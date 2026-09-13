// ── ALE Watchlist Fight Poller ────────────────────────────────────────────────
// Paste into Google Apps Script (Extensions → Apps Script) in its OWN spreadsheet.
// Standalone — it doesn't need ale_fight_poller.gs.
//
// Setup:
//   1. Reload the spreadsheet → menu "ALE Watchlist" → "Setup (tabs + 1 min trigger)".
//   2. Put wallets in column A of the "watchlist" tab, one per row below the header.
//   3. To share: File → Share → Publish to web → "watched_fights" → CSV.
//
// Every minute, fights by those wallets are copied from battle.ale::fights into
// "watched_fights" with the complete chain row as JSON, so a fight can be replayed
// later. It polls every minute because the chain deletes fight rows after roughly
// 5–10 minutes.
//
// watched_fights columns:
//   history_id | wallet | gamertag | timestamp | fight_type | dungeon_difficulty |
//   planet | x | y | result | turns | row_json

var WATCH_LIST_SHEET   = 'watchlist';
var WATCH_FIGHTS_SHEET = 'watched_fights';
var WATCH_CHAIN_NODES  = ['https://wax.eosphere.io', 'https://wax.greymass.com', 'https://api.waxsweden.org'];
// eosphere first: eosusa's index is missing actions (e.g. all of 1–2 Sep 2026)
var WATCH_HYPERION_NODES = ['https://wax.eosphere.io', 'https://api.waxsweden.org', 'https://wax.eosrio.io', 'https://wax.eosusa.io'];
var WATCH_CELL_LIMIT   = 50000;   // Google Sheets max characters per cell
var WATCH_HEADER = ['history_id', 'wallet', 'gamertag', 'timestamp', 'fight_type', 'dungeon_difficulty',
                    'planet', 'x', 'y', 'result', 'turns', 'row_json'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ALE Watchlist')
    .addItem('Setup (tabs + 1 min trigger)', 'setupWatchlist')
    .addItem('Scan Now', 'scanWatchlist')
    .addToUi();
}

function setupWatchlist() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var list = ss.getSheetByName(WATCH_LIST_SHEET);
  if (!list) {
    list = ss.insertSheet(WATCH_LIST_SHEET);
    list.getRange(1, 1, 1, 2).setValues([['wallet', 'note']]);
    list.setFrozenRows(1);
  }
  watchFightsSheet_(ss);
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'scanWatchlist') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scanWatchlist').timeBased().everyMinutes(1).create();
  ss.toast('Add wallets to column A of "' + WATCH_LIST_SHEET + '". Checking every minute.', 'Watchlist ready');
}

function watchFightsSheet_(ss) {
  var sh = ss.getSheetByName(WATCH_FIGHTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(WATCH_FIGHTS_SHEET);
    sh.getRange(1, 1, 1, WATCH_HEADER.length).setValues([WATCH_HEADER]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function scanWatchlist() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;   // previous minute's run still going
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var list = ss.getSheetByName(WATCH_LIST_SHEET);
    if (!list || list.getLastRow() < 2) return;
    var wallets = {};
    list.getRange(2, 1, list.getLastRow() - 1, 1).getValues().forEach(function(r) {
      var w = String(r[0] || '').trim().toLowerCase();
      if (w) wallets[w] = true;
    });
    if (!Object.keys(wallets).length) return;

    var fights = watchFetchFights_();
    if (!fights) { Logger.log('Watchlist: no chain node answered.'); return; }
    var mine = fights.filter(function(f) { return wallets[String(f.wallet).toLowerCase()]; });
    if (!mine.length) return;

    var sh = watchFightsSheet_(ss);
    var have = {};
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function(r) { have[String(r[0])] = true; });
    }
    mine = mine.filter(function(f) { return !have[f.history_id]; });
    if (!mine.length) return;

    // venue, difficulty and location aren't in the fight row — take them from the
    // wallet's own playdungeon / playarena actions
    var ctx = {};
    Object.keys(mine.reduce(function(o, f) { o[f.wallet] = 1; return o; }, {})).forEach(function(w) {
      var d = watchHyperion_('/v2/history/get_actions?account=' + encodeURIComponent(w)
        + '&filter=dungeons.ale%3Aplaydungeon,arena.ale%3Aplayarena&limit=50&sort=desc');
      ((d && d.actions) || []).forEach(function(a) {
        var x = a.act && a.act.data;
        if (x && x.history_id) ctx[x.history_id] = {
          type: a.act.name === 'playarena' ? 'arena' : 'dungeon',
          difficulty: a.act.name === 'playarena' ? 0 : Number(x.difficulty || 0),
          planet: x.planet || '', x: x.x || '', y: x.y || ''
        };
      });
    });

    var rows = mine.map(function(f) {
      var c = ctx[f.history_id] || {};
      var t1 = f.team1_fighters || [];
      var tag = '';
      for (var i = 0; i < t1.length && !tag; i++) tag = t1[i].gamertag || '';
      var json = JSON.stringify(f);
      if (json.length > WATCH_CELL_LIMIT) json = 'TOO LARGE FOR ONE CELL (' + json.length + ' chars)';
      return [f.history_id, f.wallet, tag, f.timestamp, c.type || '', c.difficulty || 0,
              c.planet || '', c.x || '', c.y || '',
              f.log === 'Team 1 wins' ? 'win' : f.log === 'Team 2 wins' ? 'loss' : String(f.log || ''),
              Number(f.turns || 0), json];
    });
    // plain text, so ids like "1e5abc" aren't turned into numbers
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, WATCH_HEADER.length).setNumberFormat('@').setValues(rows);
    Logger.log('Watchlist: saved ' + rows.length + ' fight(s).');
  } finally {
    lock.releaseLock();
  }
}

// Newest rows of battle.ale::fights, trying each node until one answers
function watchFetchFights_() {
  for (var i = 0; i < WATCH_CHAIN_NODES.length; i++) {
    try {
      var res = UrlFetchApp.fetch(WATCH_CHAIN_NODES[i] + '/v1/chain/get_table_rows', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ code: 'battle.ale', scope: 'battle.ale', table: 'fights', limit: 1000, json: true })
      });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText()).rows || [];
    } catch (e) { Logger.log('Watchlist chain fail ' + WATCH_CHAIN_NODES[i] + ': ' + e); }
  }
  return null;
}

// Hyperion with failover across nodes
function watchHyperion_(path) {
  for (var i = 0; i < WATCH_HYPERION_NODES.length; i++) {
    try {
      var res = UrlFetchApp.fetch(WATCH_HYPERION_NODES[i] + path, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
    } catch (e) { Logger.log('Hyperion fail ' + WATCH_HYPERION_NODES[i] + ': ' + e); }
  }
  return null;
}
