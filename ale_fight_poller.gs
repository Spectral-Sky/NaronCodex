// ── ALE Fight Stats Poller ────────────────────────────────────────────────────
// Paste into Google Apps Script (script.google.com) attached to a spreadsheet.
//
// Sheet columns (16):
//   history_id | wallet | timestamp | fight_type | dungeon_difficulty |
//   winner | crew_asset_id | weapon_asset_id |
//   team1_classes | team2_classes | team1_fighter_ids | team2_fighter_ids |
//   team1_races | team2_races | team1_elements | team2_elements
//
// Note: team2 crew/weapon asset IDs are NOT in the fight data — the
//       battle.ale::fight action only records the attacker's NFTs.
//
// After running repairSheet(), publish the "fights" sheet as CSV:
//   File → Share → Publish to web → Sheet "fights" → CSV → Copy link
//   Paste that URL into the ale.html STATS ⚙ SETUP panel.

var WAX_NODE   = 'https://wax.greymass.com';
var SHEET_NAME = 'fights';
var MAX_ROWS   = 100000;   // live sheet cap; also how often a full copy is archived
var ARCHIVE_PROP = 'rowsSinceArchive';

// eosphere first: eosusa's index is missing actions (e.g. all of 1–2 Sep 2026), and when
// it answered first the missing fights were written with a blank fight_type.
var HYPERION_NODES = [
  'https://wax.eosphere.io',
  'https://api.waxsweden.org',
  'https://wax.eosrio.io',
  'https://wax.eosusa.io'
];

// ─────────────────────────────────────────────────────────────────────────────
// UI MENU
// ─────────────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ALE Fight Stats')
    .addItem('Run Manual Scan', 'scanFightsManual')
    .addSeparator()
    .addItem('Setup Auto-Trigger (5 min)', 'createTrigger')
    .addSeparator()
    .addItem('Repair Header (safe — keeps all rows)', 'repairSheet')
    .addItem('⚠ Full Reset (DELETES all data)', 'fullResetSheet')
    .addSeparator()
    .addItem('Watchlist: Setup (tabs + 1 min trigger)', 'setupWatchlist')
    .addItem('Watchlist: Scan Now', 'scanWatchlist')
    .addToUi();
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL SCAN — creates a timestamped sheet each run
// ─────────────────────────────────────────────────────────────────────────────
function scanFightsManual() {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'fights_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  var sheet     = ss.insertSheet(sheetName);
  writeHeader_(sheet);
  ss.toast('Fetching fights from chain…', 'ALE Stats');
  var count = processFightsData_(sheet);
  ss.toast('Done. Added ' + count + ' rows to ' + sheetName, 'ALE Stats');
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO SCAN — called by time trigger every 5 min
// ─────────────────────────────────────────────────────────────────────────────
function scanFights() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    writeHeader_(sheet);
  }
  processFightsData_(sheet);
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE LOGIC
// ─────────────────────────────────────────────────────────────────────────────
function processFightsData_(sheet) {
  // Collect existing history_ids to skip duplicates
  var existingIds = new Set();
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues()
      .forEach(function(r){ if (r[0]) existingIds.add(String(r[0])); });
  }

  var enrichMap = buildEnrichMap_();
  var fights    = fetchFightsTable_();
  Logger.log('Fights in table: ' + fights.length + ' | Hyperion matches: ' + Object.keys(enrichMap).length);

  var newRows = [];
  fights.forEach(function(row) {
    if (existingIds.has(row.history_id)) return;

    var en     = enrichMap[row.history_id] || {};
    var winner = (row.log === 'Team 1 wins') ? 1 : 2;
    var wallet = row.wallet || '';

    var t1c = (row.team1_fighters || [])
      .filter(function(f){ return f.classname && f.classname.trim(); })
      .map(function(f){ return f.classname; }).join('|');

    var t2c = (row.team2_fighters || [])
      .filter(function(f){ return f.classname && f.classname.trim(); })
      .map(function(f){ return f.classname; }).join('|');

    var t1r = (row.team1_fighters || [])
      .filter(function(f){ return f.racename && f.racename.trim(); })
      .map(function(f){ return f.racename; }).join('|');

    var t2r = (row.team2_fighters || [])
      .filter(function(f){ return f.racename && f.racename.trim(); })
      .map(function(f){ return f.racename; }).join('|');

    var t1e = (row.team1_fighters || [])
      .filter(function(f){ return (f.elementname || f.element || '').trim(); })
      .map(function(f){ return f.elementname || f.element; }).join('|');

    var t2e = (row.team2_fighters || [])
      .filter(function(f){ return (f.elementname || f.element || '').trim(); })
      .map(function(f){ return f.elementname || f.element; }).join('|');

    // fighter_id 99999999999 is the weapon NFT slot placeholder — exclude it
    var t1ids = (row.team1_fighters || [])
      .filter(function(f){ return f.fighter_id && String(f.fighter_id) !== '99999999999'; })
      .map(function(f){ return String(f.fighter_id); }).join('|');

    var t2ids = (row.team2_fighters || [])
      .filter(function(f){ return f.fighter_id && String(f.fighter_id) !== '99999999999'; })
      .map(function(f){ return String(f.fighter_id); }).join('|');

    // Infer fight_type when not in Hyperion window
    // NOTE: both arena and dungeon team2 can have gamertags (dungeon defenders
    // are real players' staked fighters), so this heuristic is unreliable —
    // prefer Hyperion-confirmed fight_type whenever available.
    var ft = en.fight_type || '';

    newRows.push([
      row.history_id,   // A
      wallet,           // B
      row.timestamp,    // C
      ft,               // D
      en.difficulty || 0,           // E
      winner,                       // F
      en.crew_asset_id   || '',     // G  (attacker's crew NFT)
      en.weapon_asset_id || '',     // H  (attacker's weapon NFT)
      t1c,                          // I
      t2c,                          // J
      t1ids,                        // K
      t2ids,                        // L
      t1r,                          // M
      t2r,                          // N
      t1e,                          // O
      t2e                           // P
    ]);
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 16).setValues(newRows);
    Logger.log('Appended ' + newRows.length + ' rows.');
  } else {
    Logger.log('No new fights.');
  }

  repairBlankRows_(sheet, enrichMap);
  var unarchived = archiveIfDue_(sheet, newRows.length);   // before the trim, so the copy is complete

  // Trim oldest rows down to MAX_ROWS. If an archive copy is overdue (it failed), keep
  // the rows not yet archived so the retry can still save them — capped at 5,000 extra
  // rows so a lasting failure can't grow the live sheet without limit.
  var keep  = Math.min(Math.max(MAX_ROWS, unarchived), MAX_ROWS + 5000);
  var total = sheet.getLastRow() - 1;
  if (total > keep) {
    sheet.deleteRows(2, total - keep);
    Logger.log('Trimmed to ' + keep + ' rows.');
  }

  return newRows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write the canonical 16-column header
// ─────────────────────────────────────────────────────────────────────────────
function writeHeader_(sheet) {
  sheet.getRange(1, 1, 1, 16).setValues([[
    'history_id','wallet','timestamp','fight_type','dungeon_difficulty',
    'winner','crew_asset_id','weapon_asset_id',
    'team1_classes','team2_classes','team1_fighter_ids','team2_fighter_ids',
    'team1_races','team2_races','team1_elements','team2_elements'
  ]]);
  sheet.setFrozenRows(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch battle.ale::fights table (paginated)
// ─────────────────────────────────────────────────────────────────────────────
function fetchFightsTable_() {
  var rows = [], lb = '', LIMIT = 500;
  for (var page = 0; page < 20; page++) {
    var payload = { code:'battle.ale', scope:'battle.ale', table:'fights', limit:LIMIT, json:true };
    if (lb) payload.lower_bound = lb;
    var res = UrlFetchApp.fetch(WAX_NODE + '/v1/chain/get_table_rows', {
      method:'post', contentType:'application/json',
      payload:JSON.stringify(payload), muteHttpExceptions:true
    });
    if (res.getResponseCode() !== 200) break;
    var data = JSON.parse(res.getContentText());
    (data.rows || []).forEach(function(r){ rows.push(r); });
    if (data.more && (data.rows||[]).length === LIMIT) lb = data.next_key;
    else break;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hyperion with failover across nodes
// ─────────────────────────────────────────────────────────────────────────────
function fetchHyperionData_(path) {
  for (var i = 0; i < HYPERION_NODES.length; i++) {
    try {
      var res = UrlFetchApp.fetch(HYPERION_NODES[i] + path, { muteHttpExceptions:true });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
    } catch(e) { Logger.log('Hyperion fail ' + HYPERION_NODES[i] + ': ' + e); }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build enrichment map: history_id → {fight_type, difficulty, crew, weapon}
// ─────────────────────────────────────────────────────────────────────────────
// pages: how many 1,000-action pages to read back per fight type (default 1 = newest 1,000)
function buildEnrichMap_(pages) {
  pages = pages || 1;
  var map = {};
  [['arena.ale', 'playarena', 'arena'], ['dungeons.ale', 'playdungeon', 'dungeon']].forEach(function(src) {
    for (var p = 0; p < pages; p++) {
      var d = fetchHyperionData_('/v2/history/get_actions?account=' + src[0] + '&filter=' + src[0] + '%3A' + src[1]
        + '&limit=1000&skip=' + (p * 1000) + '&sort=desc');
      var acts = (d && d.actions) || [];
      acts.forEach(function(a) {
        var x = a.act && a.act.data;
        if (x && x.history_id) {
          map[x.history_id] = { fight_type: src[2], difficulty: src[2] === 'arena' ? 0 : Number(x.difficulty || 0),
            crew_asset_id: String(x.crew_asset_id || ''), weapon_asset_id: String(x.weapon_asset_id || '') };
        }
      });
      if (acts.length < 1000) break;
    }
  });
  return map;
}

// Rows appended before their playarena/playdungeon action reached the history node were
// left with a blank fight_type and, being skipped as duplicates, never revisited — on
// 12–13 Sep 2026 that was ~2,000 fights a day. Re-type them from history. Only rows from
// the last 3 days are considered, so unfixable old blanks don't force a deep history read
// on every 5-minute run; the deeper read happens only when the newest page can't fix them.
function repairBlankRows_(sheet, shallowMap) {
  var n = sheet.getLastRow() - 1;
  if (n < 1) return 0;
  var vals = sheet.getRange(2, 1, n, 8).getValues();   // A..H
  var cutoff = Date.now() - 3 * 86400000;
  var blanks = [];
  for (var i = 0; i < n; i++) {
    if (!vals[i][0] || vals[i][3]) continue;           // no id, or fight_type already set
    var ts = vals[i][2] instanceof Date ? vals[i][2].getTime() : Date.parse(String(vals[i][2]) + 'Z');
    if (ts && ts >= cutoff) blanks.push(i);
  }
  if (!blanks.length) return 0;

  var map = shallowMap;
  var unresolved = blanks.some(function(i) { return !map[String(vals[i][0])]; });
  if (unresolved) map = buildEnrichMap_(8);            // ~8,000 actions per type, under the 10,000 skip cap

  var fixed = 0;
  blanks.forEach(function(i) {
    var en = map[String(vals[i][0])];
    if (!en) return;
    vals[i][3] = en.fight_type;
    vals[i][4] = en.difficulty || 0;
    vals[i][6] = en.crew_asset_id || '';
    vals[i][7] = en.weapon_asset_id || '';
    fixed++;
  });
  if (fixed) {
    // write D..H back in one call rather than a round trip per row
    sheet.getRange(2, 4, n, 5).setValues(vals.map(function(r) { return r.slice(3, 8); }));
    Logger.log('Repaired ' + fixed + ' of ' + blanks.length + ' recent rows with a blank fight_type.');
  }
  return fixed;
}

// Saves a full copy of the live sheet as a new tab once every MAX_ROWS rows added.
// A running count of rows added since the last copy is kept in script properties,
// because the live sheet sits at MAX_ROWS once trimming starts, so "is it full?" would
// be true on every run. Each copy is cut down to exactly the rows added since the
// previous one, so consecutive archives line up with no overlap and no gaps.
// Workbook limit: Google Sheets allows 10M cells; each copy is ~1.6M (100k x 16 cols).
function archiveIfDue_(sheet, added) {
  if (sheet.getName() !== SHEET_NAME) return 0;   // manual timestamped scans aren't archived
  var props = PropertiesService.getScriptProperties();
  var raw   = props.getProperty(ARCHIVE_PROP);
  // First run with this version: start from the rows already in the sheet, so the first
  // copy is made when the sheet itself first reaches MAX_ROWS.
  var since = raw === null ? sheet.getLastRow() - 1 : Number(raw) + added;
  if (since >= MAX_ROWS) {
    try {
      var name = 'fights_archive_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
      var copy = sheet.copyTo(sheet.getParent()).setName(name);
      // The live sheet can hold rows the previous archive already saved (it keeps the
      // newest MAX_ROWS rows plus this run's additions), so drop the oldest from the copy
      // until it holds exactly the rows added since the last archive.
      var extra = (copy.getLastRow() - 1) - since;
      if (extra > 0) copy.deleteRows(2, extra);
      Logger.log('Archived ' + (copy.getLastRow() - 1) + ' rows to "' + name + '".');
      since = 0;
    } catch (e) {
      // most likely the 10M-cell workbook limit; keep the count so it retries next run
      Logger.log('Archive FAILED (will retry next run): ' + e);
    }
  }
  props.setProperty(ARCHIVE_PROP, String(since));
  return since;   // rows not yet archived — the trim keeps these while a copy is overdue
}

// ─────────────────────────────────────────────────────────────────────────────
// REPAIR — fixes the header row only, keeps all existing data rows intact,
// then appends any new fights from chain (duplicates are skipped automatically)
// ─────────────────────────────────────────────────────────────────────────────
function repairSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    Logger.log('Sheet not found — created new one.');
  }
  // Overwrite row 1 with canonical header, leave all data rows untouched
  writeHeader_(sheet);
  var count = processFightsData_(sheet);
  ss.toast('Header fixed. Added ' + count + ' new rows (existing rows preserved).', 'Repair Done');
  Logger.log('repairSheet done. ' + count + ' new rows appended.');
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL RESET — wipes the sheet and repopulates from chain.
// WARNING: only recovers as far back as battle.ale::fights table holds.
// Historical data older than that is permanently lost.
// ─────────────────────────────────────────────────────────────────────────────
function fullResetSheet() {
  var ui = SpreadsheetApp.getUi();
  var confirm = ui.alert(
    '⚠ Full Reset — Are you sure?',
    'This will DELETE all rows and repopulate from the chain table.\n\nHistorical data NOT in the current chain table will be permanently lost.\n\nDuplicate the sheet manually before proceeding if you want a backup.',
    ui.ButtonSet.OK_CANCEL
  );
  if (confirm !== ui.Button.OK) { ui.alert('Cancelled.'); return; }
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet "' + SHEET_NAME + '" not found.'); return; }
  sheet.clearContents();
  PropertiesService.getScriptProperties().deleteProperty(ARCHIVE_PROP);   // restart the count for the fresh sheet
  writeHeader_(sheet);
  var count = processFightsData_(sheet);
  ss.toast('Full reset done. ' + count + ' rows written.', 'Reset Complete');
  Logger.log('fullResetSheet done. ' + count + ' rows.');
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER SETUP — run once manually
// ─────────────────────────────────────────────────────────────────────────────
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'scanFights') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scanFights').timeBased().everyMinutes(5).create();
  SpreadsheetApp.getActiveSpreadsheet().toast('Polling every 5 min.', 'Trigger Set');
  Logger.log('Trigger created.');
}

// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST — full fight rows for chosen wallets only
// ─────────────────────────────────────────────────────────────────────────────
// Put wallets in column A of the "watchlist" tab (one per row, below the header).
// Every minute, fights by those wallets are copied from battle.ale::fights into
// "watched_fights" with the complete chain row as JSON, so a fight can be replayed
// later. This runs on its own 1-minute trigger because the chain deletes fight rows
// after roughly 5–10 minutes, and it doesn't touch the "fights" sheet at all.
//
// To share: File → Share → Publish to web → "watched_fights" → CSV.

var WATCH_LIST_SHEET  = 'watchlist';
var WATCH_FIGHTS_SHEET = 'watched_fights';
var WATCH_CHAIN_NODES = ['https://wax.eosphere.io', 'https://wax.greymass.com', 'https://api.waxsweden.org'];
var WATCH_CELL_LIMIT  = 50000;   // Google Sheets max characters per cell
var WATCH_HEADER = ['history_id', 'wallet', 'gamertag', 'timestamp', 'fight_type', 'dungeon_difficulty',
                    'planet', 'x', 'y', 'result', 'turns', 'row_json'];

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
      var d = fetchHyperionData_('/v2/history/get_actions?account=' + encodeURIComponent(w)
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
