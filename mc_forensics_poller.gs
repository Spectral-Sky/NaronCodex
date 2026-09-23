/**
 * MC FORENSICS POLLER — Naron Codex
 * ---------------------------------------------------------------------------
 * Builds the cohort data behind naroncodex.app/forensics:
 *
 *   mc_members  — the members.mc "mcmembers" table, one row per member
 *   mc_mining   — per-wallet mining rollup from notify.mc::logmine, with the
 *                 cadence measures the page ranks on
 *
 * Why the mining stream and not per-wallet queries: every MC member's mine is
 * notified to notify.mc, so one filtered stream carries the whole roster. The
 * history runs from Feb 2026 and is ~94k actions; Hyperion's `skip` caps out
 * around 10k, so paging walks backwards by timestamp with `before` instead.
 *
 * SETUP
 *   1. Paste into a new Apps Script project bound to your sheet.
 *   2. Run pollAll() once and grant the prompts.
 *   3. Triggers → pollAll, time-driven, once a day is plenty. The mining
 *      window is trailing, so a missed run costs nothing.
 *   4. File → Share → Publish to web → publish BOTH tabs as CSV, then give
 *      the two links to whoever wires up the page.
 *
 * A note on what these numbers are: they measure how regular a wallet's mining
 * is, nothing more. Regularity is consistent with automation, it is not proof
 * of it — a patient player with a good tool set looks similar. Treat the output
 * as a list of wallets worth a human look, never as a verdict.
 */

var CHAIN     = ['https://wax.greymass.com', 'https://wax.eosusa.io', 'https://api.waxsweden.org'];
var HYPERION  = ['https://wax.eosusa.io', 'https://wax.eosphere.io', 'https://api.waxsweden.org'];
var WINDOW_DAYS = 30;     // trailing window the cadence measures are taken over
var MIN_MINES   = 25;     // below this a wallet is reported but not scored

function pollAll() {
  var members = pullMembers_();
  writeMembers_(members);
  var mines = pullMines_(WINDOW_DAYS);
  writeMining_(rollup_(mines, members));
}

/* ── chain ───────────────────────────────────────────────────────────────── */

function chainPost_(path, body) {
  var last;
  for (var i = 0; i < CHAIN.length; i++) {
    try {
      var r = UrlFetchApp.fetch(CHAIN[i] + path, {
        method: 'post', contentType: 'text/plain',
        payload: JSON.stringify(body), muteHttpExceptions: true
      });
      if (r.getResponseCode() === 200) return JSON.parse(r.getContentText());
    } catch (e) { last = e; }
  }
  throw last || new Error('chain unavailable');
}

function pullMembers_() {
  var rows = [], lb = '';
  for (var i = 0; i < 60; i++) {
    var d = chainPost_('/v1/chain/get_table_rows', {
      json: true, code: 'members.mc', scope: 'members.mc', table: 'mcmembers',
      limit: 1000, lower_bound: lb || undefined
    });
    if (!d.rows || !d.rows.length) break;
    rows = rows.concat(d.rows);
    if (!d.more) break;
    lb = d.next_key;
  }
  return rows;
}

/* ── mining history ──────────────────────────────────────────────────────── */

function hyperion_(url) {
  var last;
  for (var i = 0; i < HYPERION.length; i++) {
    try {
      var r = UrlFetchApp.fetch(HYPERION[i] + url, { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) return JSON.parse(r.getContentText());
    } catch (e) { last = e; }
  }
  throw last || new Error('history unavailable');
}

// Walks back by timestamp because `skip` cannot reach past ~10k actions.
function pullMines_(days) {
  var cutoff = Date.now() - days * 86400000;
  var base = '/v2/history/get_actions?account=notify.mc&filter=' +
             encodeURIComponent('notify.mc:logmine') + '&limit=1000&sort=desc';
  var out = [], before = '';
  for (var page = 0; page < 200; page++) {
    var d = hyperion_(base + (before ? '&before=' + encodeURIComponent(before) : ''));
    var acts = d.actions || [];
    if (!acts.length) break;
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i], ms = Date.parse(a.timestamp + 'Z');
      if (ms < cutoff) return out;
      var p = (a.act.data && a.act.data.params) || {};
      out.push({
        ms: ms,
        miner: a.act.data.miner,
        bounty: parseFloat(a.act.data.bounty) || 0,
        land: String(a.act.data.land_id || ''),
        owner: String(a.act.data.landowner || ''),
        planet: String(a.act.data.planet_name || ''),
        delay: Number(p.delay) || 0,
        commission: Number(p.commission) || 0
      });
    }
    if (acts.length < 1000) break;
    before = acts[acts.length - 1].timestamp;
  }
  return out;
}

/* ── rollup ──────────────────────────────────────────────────────────────── */

function median_(a) {
  if (!a.length) return 0;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function rollup_(mines, members) {
  var memberBy = {};
  members.forEach(function (m) { memberBy[m.wallet] = m; });

  var per = {};
  mines.forEach(function (x) {
    (per[x.miner] || (per[x.miner] = [])).push(x);
  });

  var out = [];
  Object.keys(per).forEach(function (w) {
    var list = per[w].sort(function (a, b) { return a.ms - b.ms; });
    var excess = [], hours = {}, owners = {}, lands = {}, tlm = 0, gapsH = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      tlm += x.bounty;
      hours[new Date(x.ms).getUTCHours()] = 1;
      owners[x.owner] = (owners[x.owner] || 0) + 1;
      lands[x.land] = (lands[x.land] || 0) + 1;
      if (i) {
        var gap = (x.ms - list[i - 1].ms) / 1000;
        gapsH.push(gap / 3600);
        // how long after the cooldown expired the next mine landed
        if (gap > 0 && gap < 6 * 3600 && list[i - 1].delay) excess.push(gap - list[i - 1].delay);
      }
    }
    var med = median_(excess);
    // median absolute deviation: robust scatter, unmoved by the odd long break
    var mad = median_(excess.map(function (v) { return Math.abs(v - med); }));
    var mcShare = list.length ? (owners['land.mc'] || 0) / list.length : 0;
    var m = memberBy[w] || {};

    out.push({
      wallet: w,
      mines: list.length,
      tlm: tlm,
      first: new Date(list[0].ms).toISOString(),
      last: new Date(list[list.length - 1].ms).toISOString(),
      hours_covered: Object.keys(hours).length,
      longest_gap_h: gapsH.length ? Math.max.apply(null, gapsH) : 0,
      median_excess_s: Math.round(med),
      mad_excess_s: Math.round(mad),
      distinct_lands: Object.keys(lands).length,
      land_mc_share: Math.round(mcShare * 1000) / 1000,
      scored: list.length >= MIN_MINES ? 1 : 0,
      regularity: list.length >= MIN_MINES ? regularity_(mad, Object.keys(hours).length, gapsH) : '',
      member_id: m.member_id || '',
      level: m.level || '',
      flagged: m.flagged || 0,
      member: m.member || 0,
      trial: m.trial || 0,
      joined: m.joined || '',
      recruited_by: m.recruited_by || '',
      in_members_table: memberBy[w] ? 1 : 0
    });
  });

  out.sort(function (a, b) { return (b.regularity || 0) - (a.regularity || 0); });
  return out;
}

/**
 * 0-100, higher = more regular. Three parts, each capped so no single one can
 * carry the score on its own:
 *   tightness  — how little the gap-over-cooldown varies (MAD)
 *   coverage   — how many hours of the day see mining
 *   continuity — how short the longest break is
 * This says "regular", not "automated". A human on a strict routine scores high.
 */
function regularity_(mad, hoursCovered, gapsH) {
  var tight = Math.max(0, 1 - mad / 1800);                 // 30 min scatter → 0
  var cover = Math.min(1, hoursCovered / 24);
  var longest = gapsH.length ? Math.max.apply(null, gapsH) : 24;
  var cont = Math.max(0, 1 - longest / 12);                // a 12h break → 0
  return Math.round((tight * 45 + cover * 30 + cont * 25));
}

/* ── sheets ──────────────────────────────────────────────────────────────── */

function sheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  return sh;
}

function write_(sh, header, rows) {
  if (!rows.length) return;
  var data = rows.map(function (r) {
    return header.map(function (k) { return r[k] === undefined ? '' : r[k]; });
  });
  sh.getRange(2, 1, data.length, header.length).setValues(data);
}

function writeMembers_(members) {
  var header = ['wallet', 'playertag', 'member_id', 'joined', 'last_activity', 'level',
                'total_experience', 'member', 'trial', 'flagged', 'flag_reason',
                'last_review', 'next_review', 'reviewed_by', 'recruited_by', 'stake'];
  var sh = sheet_('mc_members', header);
  write_(sh, header, members);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
}

function writeMining_(rows) {
  var header = ['wallet', 'regularity', 'mines', 'tlm', 'hours_covered', 'longest_gap_h',
                'median_excess_s', 'mad_excess_s', 'distinct_lands', 'land_mc_share',
                'first', 'last', 'scored', 'member_id', 'level', 'flagged', 'member',
                'trial', 'joined', 'recruited_by', 'in_members_table'];
  var sh = sheet_('mc_mining', header);
  rows.forEach(function (r) { r.tlm = Math.round(r.tlm * 10000) / 10000; r.longest_gap_h = Math.round(r.longest_gap_h * 100) / 100; });
  write_(sh, header, rows);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
}
