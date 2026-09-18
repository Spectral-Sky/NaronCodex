// ── ALE MARKET POLLER ─────────────────────────────────────────────────────────
// Paste into Google Apps Script (Extensions → Apps Script) in its OWN spreadsheet.
//
// Setup:
//   1. Reload the sheet → menu "ALE Market" → "Setup (tabs + 30 min trigger)".
//      The first run backfills every sale market.ale has ever settled.
//   2. Share both tabs: File → Share → Publish to web → "sales" → CSV, then "listings" → CSV.
//
// Why history and not just snapshots: a sold listing is deleted from the contract, but the
// transaction that settles it always records the same actions, so every sale can be rebuilt
// exactly — nothing is missed between polls and the whole past can be backfilled.
//   fighters.ale::chgowner   → fighter_id + buyer   (one per sale, authorised by market.ale)
//   players.ale::updpermstat → market_spent (buyer, gems paid) / market_earned (seller, net)
//   market.ale::buyoffer     → only on instant buys; auctions settle under compauct
//
// Prices are in GEMS. The seller receives the net after the 15% processing fee (min 1 gem).
//
// Runs every 30 minutes on purpose: because sales come from history, no sale can be missed
// whatever the interval — only the listings snapshot ages — and Apps Script's 90 min/day of
// total trigger runtime is shared with the fight and watchlist pollers, which have to run
// often because their chain rows are deleted within minutes. A steady run here is ~2s.

var SALES_SHEET    = 'sales';
var LISTINGS_SHEET = 'listings';
var CURSOR_PROP    = 'marketLastSaleGlobalSeq';
var CHAIN_NODES    = ['https://wax.eosphere.io', 'https://wax.greymass.com', 'https://api.waxsweden.org'];
var HYPERION_NODES = ['https://wax.eosphere.io', 'https://api.waxsweden.org', 'https://wax.eosrio.io'];

var SALES_HEADER = ['timestamp', 'sale_type', 'fighter_id', 'classname', 'racename', 'element', 'level',
                    'gems_paid', 'gems_to_seller', 'fee_gems', 'buyer', 'seller', 'listing_id', 'trx_id'];
var LISTINGS_HEADER = ['listing_type', 'listing_id', 'fighter_id', 'classname', 'racename', 'element', 'level',
                       'price_gems', 'bids', 'current_bidder', 'owner', 'owner_gamertag', 'ends', 'started',
                       'ascension_level', 'abilities', 'health', 'damage', 'taunt', 'windup', 'cooldown',
                       'res_fire', 'res_air', 'res_gem', 'res_metal', 'res_nature', 'res_neutral', 'snapshot_at'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ALE Market')
    .addItem('Setup (tabs + 30 min trigger)', 'setupMarket')
    .addItem('Scan Now', 'scanMarket')
    .addSeparator()
    .addItem('Rebuild full sale history', 'rebuildSales')
    .addToUi();
}

function setupMarket() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  sheetFor_(ss, SALES_SHEET, SALES_HEADER);
  sheetFor_(ss, LISTINGS_SHEET, LISTINGS_HEADER);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scanMarket') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scanMarket').timeBased().everyMinutes(30).create();
  ss.toast('Backfilling sales and snapshotting listings…', 'ALE Market');
  scanMarket();
  ss.toast('Ready. Publish both tabs as CSV to share them.', 'ALE Market');
}

function sheetFor_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function rebuildSales() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = sheetFor_(ss, SALES_SHEET, SALES_HEADER);
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  PropertiesService.getScriptProperties().deleteProperty(CURSOR_PROP);
  var n = pullSales_(sh);
  ss.toast('Rebuilt ' + n + ' sales.', 'ALE Market');
}

function scanMarket() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    pullSales_(sheetFor_(ss, SALES_SHEET, SALES_HEADER));
    snapshotListings_(sheetFor_(ss, LISTINGS_SHEET, LISTINGS_HEADER));
  } finally {
    lock.releaseLock();
  }
}

// ── SALES ────────────────────────────────────────────────────────────────────
function pullSales_(sheet) {
  var props  = PropertiesService.getScriptProperties();
  var cursor = Number(props.getProperty(CURSOR_PROP) || 0);   // global_sequence of the last sale written
  var acts = [], skip = 0;
  while (skip < 10000) {
    var page = hyperion_('/v2/history/get_actions?account=market.ale&filter=fighters.ale%3Achgowner'
      + '&limit=1000&skip=' + skip + '&sort=asc');
    var got = (page && page.actions) || [];
    acts = acts.concat(got);
    if (got.length < 1000) break;
    skip += 1000;
  }
  var fresh = acts.filter(function (a) { return Number(a.global_sequence || 0) > cursor; });
  if (!fresh.length) return 0;

  var order = [], maxSeq = cursor;
  fresh.forEach(function (a) {
    if (order.indexOf(a.trx_id) < 0) order.push(a.trx_id);          // one tx can settle several auctions
    maxSeq = Math.max(maxSeq, Number(a.global_sequence || 0));
  });

  // a transaction that settles several auctions can straddle the cursor, so drop anything
  // already written rather than risk a duplicate row
  var have = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, SALES_HEADER.length).getValues().forEach(function (r) {
      have[String(r[13]) + ':' + String(r[2])] = 1;   // trx_id : fighter_id
    });
  }
  var rows = [];
  order.forEach(function (trx) {
    salesFromTrx_(trx).forEach(function (s) {
      if (!have[String(s[13]) + ':' + String(s[2])]) rows.push(s);
    });
  });
  if (!rows.length) { props.setProperty(CURSOR_PROP, String(maxSeq)); return 0; }

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SALES_HEADER.length)
       .setNumberFormat('@').setValues(rows);
  props.setProperty(CURSOR_PROP, String(maxSeq));
  Logger.log('Wrote ' + rows.length + ' sale(s).');
  return rows.length;
}

// Rebuild every sale settled in one transaction. The actions come in matching order, so the
// nth fighter handover belongs with the nth buyer charge and the nth seller payout.
function salesFromTrx_(trxId) {
  var tx = hyperion_('/v2/history/get_transaction?id=' + trxId);
  var acts = (tx && tx.actions) || [];
  var seen = {}, uniq = [];
  acts.forEach(function (a) {
    var k = String(a.action_ordinal);
    if (seen[k]) return;
    seen[k] = 1;
    uniq.push(a);
  });
  uniq.sort(function (a, b) { return Number(a.action_ordinal) - Number(b.action_ordinal); });

  var ts = (uniq[0] && uniq[0]['@timestamp']) || '';
  var handovers = [], spent = [], earned = [], offers = [];
  uniq.forEach(function (a) {
    var d = (a.act && a.act.data) || {}, nm = a.act.account + '::' + a.act.name;
    if (nm === 'fighters.ale::chgowner' && d.new_owner) handovers.push(d);
    else if (nm === 'players.ale::updpermstat' && d.statname === 'market_spent')  spent.push(d);
    else if (nm === 'players.ale::updpermstat' && d.statname === 'market_earned') earned.push(d);
    else if (nm === 'market.ale::buyoffer') offers.push(d);
  });

  return handovers.map(function (h, i) {
    var buyerSpent = spent[i] || {}, sellerGot = earned[i] || {};
    var gross = Number(buyerSpent.statvalue || 0), net = Number(sellerGot.statvalue || 0);
    var offer = offers[i];
    var f = fighterInfo_(h.fighter_id);
    return [ts, offer ? 'instant' : 'auction', String(h.fighter_id), f.classname, f.racename, f.element, f.level,
            gross, net, gross - net, h.new_owner, sellerGot.player || '',
            offer ? String(offer.offer_id) : '', trxId];
  });
}

// Class, race and element never change; level is as it stands now, which is all the chain
// still holds once a fighter has moved on.
var _fighterCache = {};
function fighterInfo_(fighterId) {
  var key = String(fighterId);
  if (_fighterCache[key]) return _fighterCache[key];
  var out = { classname: '', racename: '', element: '', level: '' };
  try {
    var r = chainRows_({ code: 'fighters.ale', scope: 'fighters.ale', table: 'fighters',
      lower_bound: key, upper_bound: key, limit: 1, json: true })[0];
    if (r) out = { classname: r.classname || '', racename: r.racename || '', element: r.element || '',
                   level: (r.stats && r.stats.level) || '' };
  } catch (e) {}
  _fighterCache[key] = out;
  return out;
}

// ── LISTINGS ─────────────────────────────────────────────────────────────────
// A live picture of what's for sale: replaced in full each run.
function snapshotListings_(sheet) {
  var now = new Date().toISOString().slice(0, 19);
  var rows = [];
  chainRows_({ code: 'market.ale', scope: 'market.ale', table: 'auctions', limit: 1000, json: true })
    .forEach(function (r) {
      rows.push(listingRow_('auction', r.auction_id, r.current_bid, r.bids,
        r.current_bidder_gamertag || r.current_bidder || '', r.auction_end, r.auction_start, r, now));
    });
  chainRows_({ code: 'market.ale', scope: 'market.ale', table: 'instantoffer', limit: 1000, json: true })
    .forEach(function (r) {
      rows.push(listingRow_('instant', r.offer_id, r.gems, '', '', r.offer_end, r.offer_start, r, now));
    });

  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
  if (rows.length) sheet.getRange(2, 1, rows.length, LISTINGS_HEADER.length).setNumberFormat('@').setValues(rows);
  Logger.log('Snapshotted ' + rows.length + ' listing(s).');
  return rows.length;
}

function listingRow_(type, id, price, bids, bidder, ends, started, r, now) {
  var f = r.fighter || {};
  var mid = function (a, b) { return Math.round((Number(a || 0) + Number(b || 0)) / 2); };
  return [type, String(id), String(r.fighter_id), f.classname || r.classname || '', f.racename || '',
          f.element || '', (f.level != null ? f.level : ''), Number(price || 0),
          bids === '' ? '' : Number(bids || 0), bidder, r.owner || '', r.owner_gamertag || '',
          ends || '', started || '', Number(r.ascension_level || 0),
          (f.abilities || []).map(function (a) { return a.displayname || a.ability; }).join(' | '),
          mid(f.health_min, f.health_max), mid(f.damage_min, f.damage_max), mid(f.taunt_min, f.taunt_max),
          mid(f.initiative_min, f.initiative_max), mid(f.attackspeed_min, f.attackspeed_max),
          Number(f.res_fire || 0), Number(f.res_air || 0), Number(f.res_gem || 0),
          Number(f.res_metal || 0), Number(f.res_nature || 0), Number(f.res_neutral || 0), now];
}

// ── CHAIN / HISTORY ──────────────────────────────────────────────────────────
function chainRows_(body) {
  for (var i = 0; i < CHAIN_NODES.length; i++) {
    try {
      var res = UrlFetchApp.fetch(CHAIN_NODES[i] + '/v1/chain/get_table_rows', {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(body), muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText()).rows || [];
    } catch (e) { Logger.log('chain fail ' + CHAIN_NODES[i] + ': ' + e); }
  }
  return [];
}

function hyperion_(path) {
  for (var i = 0; i < HYPERION_NODES.length; i++) {
    try {
      var res = UrlFetchApp.fetch(HYPERION_NODES[i] + path, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
    } catch (e) { Logger.log('hyperion fail ' + HYPERION_NODES[i] + ': ' + e); }
  }
  return null;
}
