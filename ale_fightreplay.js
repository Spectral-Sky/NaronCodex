// ── ALE FIGHT REPLAY PANE ────────────────────────────────────────────────────
// Turn-by-turn replay of a battle.ale fight, rebuilt with AleFightSim (ale_fightsim.js).
// The chain keeps a fight's row for only about a minute, so rows are saved in this
// browser (newest 20) the moment a page captures them; replays run from that copy.
//
//   AleReplay.onFight(row, venue, autoOpen)  save a fight, and open it if autoOpen
//   AleReplay.open(historyId)                open a saved fight (newest if omitted)
//   AleReplay.has(historyId)                 is this fight saved?
(function () {
    'use strict';

    var STORE_KEY    = 'naron_fight_replays_v1';
    var KEEP         = 20;
    var SETTINGS_KEY = 'naron_fight_settings_v1';
    var SETTINGS_TTL = 6 * 3600 * 1000;
    var RPC = ['https://wax.eosphere.io', 'https://wax.eosusa.io', 'https://wax.greymass.com'];
    // Chain health and damage are 10x what the game displays; rounding matches the
    // in-game combat log exactly (checked turn by turn against a real fight).
    function shown(v) { return Math.round(Number(v || 0) / 10); }
    var NFT_SLOT = '99999999999';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ── storage ──────────────────────────────────────────────────────────────
    function loadStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
    }
    function saveStore(list) {
        list = list.slice(0, KEEP);
        while (list.length) {
            try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return; }
            catch (e) { list.pop(); }   // storage full: drop the oldest and try again
        }
    }
    function capture(row, venue) {
        if (!row || !row.history_id) return;
        var list = loadStore().filter(function (x) { return x.row.history_id !== row.history_id; });
        list.unshift({ row: row, venue: venue || null, savedAt: Date.now() });
        saveStore(list);
    }
    function find(historyId) {
        var list = loadStore();
        if (!historyId) return list[0] || null;
        return list.filter(function (x) { return x.row.history_id === historyId; })[0] || null;
    }

    // ── fight settings from chain (cached) ───────────────────────────────────
    async function chainRow(table) {
        for (var i = 0; i < RPC.length; i++) {
            try {
                var r = await fetch(RPC[i] + '/v1/chain/get_table_rows', {
                    method: 'POST', headers: { 'Content-Type': 'text/plain' },
                    body: JSON.stringify({ code: 'battle.ale', scope: 'battle.ale', table: table, limit: 1, json: true })
                });
                if (!r.ok) continue;
                var j = await r.json();
                if (j.rows && j.rows[0]) return j.rows[0];
            } catch (e) { /* next endpoint */ }
        }
        return null;
    }
    async function getSettings() {
        try {
            var c = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (c && Date.now() - c.at < SETTINGS_TTL) return c;
        } catch (e) {}
        var cfg = await chainRow('config'), fgt = await chainRow('fgtconfig');
        var s = {
            caps: (cfg && cfg.battle_stat_caps) || window.AleFightSim.DEFAULT_CAPS,
            tauntDeduction: fgt ? Number(fgt.taunt_deduction) : 100,
            at: Date.now()
        };
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
        return s;
    }

    // The venue only matters for building-conditional abilities. If it's unknown, or the
    // result doesn't match the chain, try the other venue.
    function simulateEntry(entry, settings) {
        var venues = entry.venue ? [entry.venue, entry.venue === 'arena' ? 'dungeon' : 'arena'] : ['dungeon', 'arena'];
        var first = null;
        for (var i = 0; i < venues.length; i++) {
            var r = window.AleFightSim.simulate(entry.row, { caps: settings.caps, tauntDeduction: settings.tauntDeduction, building: venues[i] });
            r.venue = venues[i];
            if (!first) first = r;
            if (r.matchesChain) return r;
        }
        return first;
    }

    // ── pane ─────────────────────────────────────────────────────────────────
    var CSS = ''
        + '#frp-overlay{position:fixed;inset:0;z-index:1600;display:none;align-items:center;justify-content:center;background:rgba(0,0,6,0.82);}'
        + '#frp-overlay.open{display:flex;}'
        + '#frp-box{width:min(1100px,96vw);max-height:92vh;display:flex;flex-direction:column;background:rgba(3,6,15,0.985);border:1px solid rgba(232,160,32,0.3);border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,0.8);color:#c8d0e0;font-size:14px;}'
        + '.frp-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid rgba(232,160,32,0.15);}'
        + '.frp-title{font-size:0.8em;letter-spacing:3px;color:#e8a020;font-weight:bold;}'
        + '#frp-pick{background:#0a0e18;color:#c8d0e0;border:1px solid rgba(232,160,32,0.3);border-radius:4px;padding:3px 6px;font-size:0.78em;max-width:320px;}'
        + '#frp-meta{font-size:0.75em;color:#7a8698;letter-spacing:1px;flex:1;}'
        + '.frp-chip{display:inline-block;padding:1px 7px;border-radius:8px;font-size:0.9em;margin-left:6px;}'
        + '.frp-chip.ok{color:#60e090;border:1px solid rgba(96,224,144,0.4);}.frp-chip.warn{color:#e0a040;border:1px solid rgba(224,160,64,0.4);}'
        + '.frp-new{color:#000;background:#e8a020;border-radius:6px;padding:1px 6px;font-size:0.7em;letter-spacing:1px;display:none;}'
        + '.frp-x{background:transparent;border:none;color:#556070;font-size:1em;cursor:pointer;padding:2px 6px;border-radius:5px;}.frp-x:hover{color:#ff8080;background:rgba(255,90,90,0.12);}'
        + '.frp-body{display:flex;gap:12px;padding:12px 14px;min-height:0;flex:1;}'
        + '.frp-arena{flex:0 0 46%;display:flex;flex-direction:column;gap:10px;min-width:0;}'
        + '.frp-teams{display:flex;gap:8px;}'
        + '.frp-team{flex:1;display:flex;flex-direction:column;gap:5px;min-width:0;}'
        + '.frp-team-h{font-size:0.66em;letter-spacing:2px;color:#7a8698;text-align:center;padding-bottom:2px;}'
        + '.frp-card{border:1px solid rgba(232,160,32,0.14);border-radius:6px;padding:5px 8px;background:rgba(10,14,24,0.7);transition:border-color .2s,background .2s,opacity .3s;}'
        + '.frp-card.atk{border-color:rgba(232,160,32,0.8);background:rgba(232,160,32,0.08);}'
        + '.frp-card.def{border-color:rgba(230,90,90,0.8);background:rgba(230,90,90,0.08);}'
        + '.frp-card.dead{opacity:0.32;}'
        + '.frp-card-top{display:flex;justify-content:space-between;gap:6px;font-size:0.72em;white-space:nowrap;overflow:hidden;}'
        + '.frp-cls{color:#e8c070;text-transform:uppercase;letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;}'
        + '.frp-lv{color:#6a7688;}'
        + '.frp-hp{height:6px;background:rgba(255,255,255,0.07);border-radius:3px;overflow:hidden;margin-top:4px;}'
        + '.frp-hp>div{height:100%;background:rgba(80,210,120,0.8);transition:width .35s;}'
        + '.frp-hp>div.mid{background:rgba(232,160,32,0.85);}.frp-hp>div.low{background:rgba(230,80,80,0.85);}'
        + '.frp-hpt{font-size:0.62em;color:#7a8698;text-align:right;margin-top:1px;}'
        + '.frp-ctrl{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}'
        + '.frp-ctrl button{background:#131a28;border:1px solid rgba(255,255,255,0.12);color:#c8d0e0;border-radius:5px;padding:4px 9px;cursor:pointer;font-size:0.78em;}'
        + '.frp-ctrl button:hover{border-color:rgba(232,160,32,0.5);}'
        + '.frp-ctrl button.on{border-color:#e8a020;color:#e8a020;}'
        + '#frp-turn{font-size:0.75em;color:#9aa6b8;letter-spacing:1px;margin-left:auto;}'
        + '.frp-log{flex:1;overflow-y:auto;min-height:0;border-left:1px solid rgba(255,255,255,0.06);padding-left:10px;}'
        + '.frp-row{padding:5px 6px;border-radius:5px;border-left:2px solid transparent;cursor:pointer;font-size:0.76em;line-height:1.5;}'
        + '.frp-row:hover{background:rgba(255,255,255,0.03);}'
        + '.frp-row.cur{background:rgba(232,160,32,0.08);border-left-color:#e8a020;}'
        + '.frp-row.future{opacity:0.45;}'
        + '.frp-n{color:#556070;display:inline-block;min-width:26px;}'
        + '.frp-a{color:#e8c070;}.frp-d{color:#e09090;}.frp-dmg{color:#fff;font-weight:bold;}'
        + '.frp-sub{color:#7a8698;padding-left:26px;}'
        + '.frp-fx{color:#9ab8d8;padding-left:26px;}.frp-fx.heal{color:#70d090;}'
        + '.frp-ko{color:#ff7070;padding-left:26px;}'
        + '.frp-open-h{font-size:0.66em;letter-spacing:2px;color:#7a8698;padding:2px 6px;}'
        + '@media (max-width:820px){.frp-body{flex-direction:column;}.frp-arena{flex:none;}.frp-log{border-left:none;padding-left:0;max-height:40vh;}}';

    var st = { entry: null, replay: null, byUid: null, turn: 0, timer: null, speed: 1 };

    function build() {
        if (document.getElementById('frp-overlay')) return;
        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        var ov = document.createElement('div');
        ov.id = 'frp-overlay';
        ov.innerHTML = ''
            + '<div id="frp-box">'
            +   '<div class="frp-head">'
            +     '<span class="frp-title">FIGHT REPLAY</span>'
            +     '<select id="frp-pick" title="Saved fights (newest 20)"></select>'
            +     '<span class="frp-new" id="frp-new">NEW FIGHT</span>'
            +     '<span id="frp-meta"></span>'
            +     '<button class="frp-x" id="frp-close" title="Close">&#10005;</button>'
            +   '</div>'
            +   '<div class="frp-body">'
            +     '<div class="frp-arena">'
            +       '<div class="frp-teams"><div class="frp-team" id="frp-t1"></div><div class="frp-team" id="frp-t2"></div></div>'
            +       '<div class="frp-ctrl">'
            +         '<button data-a="first" title="Start">|&#9664;</button>'
            +         '<button data-a="prev" title="Previous blow">&#9664;</button>'
            +         '<button data-a="play" id="frp-play">&#9654; PLAY</button>'
            +         '<button data-a="next" title="Next blow">&#9654;</button>'
            +         '<button data-a="last" title="End">&#9654;|</button>'
            +         '<button data-s="1" class="on">1&times;</button><button data-s="2">2&times;</button><button data-s="4">4&times;</button>'
            +         '<span id="frp-turn"></span>'
            +       '</div>'
            +     '</div>'
            +     '<div class="frp-log" id="frp-log"></div>'
            +   '</div>'
            + '</div>';
        document.body.appendChild(ov);

        ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
        document.getElementById('frp-close').onclick = close;
        document.getElementById('frp-pick').onchange = function () { openEntry(find(this.value)); };
        ov.querySelector('.frp-ctrl').addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b || !st.replay) return;
            if (b.dataset.s) {
                st.speed = Number(b.dataset.s);
                ov.querySelectorAll('.frp-ctrl [data-s]').forEach(function (x) { x.classList.toggle('on', x === b); });
                if (st.timer) { stop(); play(); }
                return;
            }
            var last = st.replay.turns.length;
            switch (b.dataset.a) {
                case 'first': stop(); goTo(0); break;
                case 'prev':  stop(); goTo(Math.max(0, st.turn - 1)); break;
                case 'next':  stop(); goTo(Math.min(last, st.turn + 1)); break;
                case 'last':  stop(); goTo(last); break;
                case 'play':  st.timer ? stop() : play(); break;
            }
        });
        document.getElementById('frp-log').addEventListener('click', function (e) {
            var r = e.target.closest('.frp-row');
            if (r && r.dataset.t != null) { stop(); goTo(Number(r.dataset.t)); }
        });
        document.addEventListener('keydown', function (e) {
            if (!ov.classList.contains('open') || /INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return;
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowRight') { stop(); goTo(Math.min(st.replay.turns.length, st.turn + 1)); }
            else if (e.key === 'ArrowLeft')  { stop(); goTo(Math.max(0, st.turn - 1)); }
            else if (e.key === ' ') { e.preventDefault(); st.timer ? stop() : play(); }
        });
    }

    function isOpen() {
        var ov = document.getElementById('frp-overlay');
        return !!(ov && ov.classList.contains('open'));
    }

    function close() {
        stop();
        var ov = document.getElementById('frp-overlay');
        if (ov) ov.classList.remove('open');
    }

    function play() {
        if (!st.replay) return;
        if (st.turn >= st.replay.turns.length) goTo(0);
        document.getElementById('frp-play').innerHTML = '&#10074;&#10074; PAUSE';
        st.timer = setInterval(function () {
            if (st.turn >= st.replay.turns.length) { stop(); return; }
            goTo(st.turn + 1);
        }, Math.round(900 / st.speed));
    }
    function stop() {
        if (st.timer) { clearInterval(st.timer); st.timer = null; }
        var p = document.getElementById('frp-play');
        if (p) p.innerHTML = '&#9654; PLAY';
    }

    function unitName(u) {
        if (String(u.fighter_id) === NFT_SLOT) return 'NFT Fighter';
        return u.classname || 'Fighter';
    }
    function emoji(u) {
        if (String(u.fighter_id) === NFT_SLOT) return '&#9876;';
        var key = (u.classname || '').toLowerCase().replace(/[\s_-]/g, '');
        var fc = window.FIGHTER_CLASSES && window.FIGHTER_CLASSES[key];
        return fc ? fc.e : '';
    }
    function sideTag(u) { return u.gamertag || u.owner || ''; }

    function fillPicker() {
        var pick = document.getElementById('frp-pick');
        var cur = st.entry ? st.entry.row.history_id : '';
        pick.innerHTML = loadStore().map(function (x) {
            var r = x.row, t = new Date((r.timestamp || '') + 'Z');
            var when = isNaN(t) ? '' : t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            var res = r.log === 'Team 1 wins' ? 'WON' : r.log === 'Team 2 wins' ? 'LOST' : String(r.log || '');
            return '<option value="' + esc(r.history_id) + '"' + (r.history_id === cur ? ' selected' : '') + '>'
                + esc(when + ' · ' + (x.venue ? x.venue.toUpperCase() + ' · ' : '') + res + ' · ' + (r.turns || '?') + ' blows') + '</option>';
        }).join('');
    }

    function renderTeams(states, turnInfo) {
        var html = { 1: '', 2: '' };
        st.replay.fighters.forEach(function (u) {
            var s = states[u.uid] || { health: u.health, max_health: u.max_health };
            var pct = s.max_health > 0 ? Math.max(0, Math.min(100, s.health / s.max_health * 100)) : 0;
            var cls = 'frp-card' + (s.health <= 0 ? ' dead' : '')
                + (turnInfo && turnInfo.attackerUid === u.uid ? ' atk' : '')
                + (turnInfo && turnInfo.defenderUid === u.uid ? ' def' : '');
            html[u.team] += '<div class="' + cls + '">'
                + '<div class="frp-card-top"><span class="frp-cls">' + emoji(u) + ' ' + esc(unitName(u)) + '</span>'
                + '<span class="frp-lv">' + (u.level ? 'LV ' + u.level : '') + ' ' + esc(u.element || '') + '</span></div>'
                + '<div class="frp-hp"><div class="' + (pct <= 25 ? 'low' : pct <= 50 ? 'mid' : '') + '" style="width:' + pct.toFixed(1) + '%"></div></div>'
                + '<div class="frp-hpt">' + shown(s.health) + ' / ' + shown(s.max_health) + ' HP</div>'
                + '</div>';
        });
        var t1 = st.replay.fighters.filter(function (u) { return u.team === 1; })[0];
        var t2 = st.replay.fighters.filter(function (u) { return u.team === 2; })[0];
        document.getElementById('frp-t1').innerHTML = '<div class="frp-team-h">' + esc(t1 ? sideTag(t1) || 'TEAM 1' : 'TEAM 1') + '</div>' + html[1];
        document.getElementById('frp-t2').innerHTML = '<div class="frp-team-h">' + esc(t2 ? sideTag(t2) || 'TEAM 2' : 'TEAM 2') + '</div>' + html[2];
    }

    function statLabel(stat) {
        return { health: 'Health', damage: 'Damage', taunt: 'Taunt', initiative: 'Windup', attackspeed: 'Cooldown' }[stat]
            || String(stat).replace('res_', '').replace(/^\w/, function (c) { return c.toUpperCase(); }) + (String(stat).indexOf('res_') === 0 ? ' Resistance' : '');
    }
    function effectLine(fx) {
        var target = st.byUid[fx.targetUid], diff = fx.after - fx.before;
        var who = fx.sourceUid === fx.targetUid ? 'its own' : esc(unitName(target || {})) + '&rsquo;s';
        var when = fx.trigger === 'on_attack' ? 'attacking' : fx.trigger === 'on_defense' ? 'defending' : 'before the fight';
        return '<div class="frp-fx' + (diff > 0 && fx.stat === 'health' ? ' heal' : '') + '">&#8627; ' + esc(fx.ability) + ' (' + when + ') '
            + (diff < 0 ? 'lowered ' : 'raised ') + who + ' ' + statLabel(fx.stat) + ' by ' + shown(Math.abs(diff)) + '</div>';
    }

    function renderLog() {
        var r = st.replay, out = '';
        if (r.openingEffects.length) {
            out += '<div class="frp-row" data-t="0"><div class="frp-open-h">BEFORE THE FIGHT</div>'
                + r.openingEffects.map(effectLine).join('') + '</div>';
        }
        r.turns.forEach(function (t) {
            var a = st.byUid[t.attackerUid], d = st.byUid[t.defenderUid];
            var over = t.killed && t.raw > t.damage ? ' · ' + shown(t.raw - t.damage) + ' overkill' : '';
            out += '<div class="frp-row" data-t="' + t.turn + '">'
                + '<span class="frp-n">' + t.turn + '</span>'
                + '<span class="frp-a">' + emoji(a) + ' ' + esc(unitName(a)) + '</span> '
                + '<span style="color:#556070">' + esc(sideTag(a)) + '</span> hit '
                + '<span class="frp-d">' + emoji(d) + ' ' + esc(unitName(d)) + '</span> '
                + '<span style="color:#556070">' + esc(sideTag(d)) + '</span> for <span class="frp-dmg">' + shown(t.damage) + '</span>'
                + '<div class="frp-sub">' + t.effectiveness + '% landed · ' + shown(t.defenderHealthBefore) + ' &rarr; ' + shown(t.defenderHealthAfter)
                +   ' HP · ' + shown(t.blocked) + ' blocked · ' + esc(t.element) + over + ' · attacker on ' + shown(t.attackerHealth) + ' HP</div>'
                + t.effects.map(effectLine).join('')
                + (t.killed ? '<div class="frp-ko">' + esc(unitName(d)) + ' is knocked out</div>' : '')
                + t.effects.filter(function (fx) { return fx.stat === 'health' && fx.after === 0 && fx.before > 0 && fx.targetUid !== t.defenderUid; })
                    .map(function (fx) { return '<div class="frp-ko">' + esc(unitName(st.byUid[fx.targetUid] || {})) + ' is knocked out</div>'; }).join('')
                + '</div>';
        });
        document.getElementById('frp-log').innerHTML = out;
    }

    function goTo(n) {
        var r = st.replay;
        st.turn = n;
        var snap = n === 0 ? r.opening : r.turns[n - 1].snapshot;
        var states = {};
        snap.forEach(function (s) { states[s.uid] = s; });
        renderTeams(states, n > 0 ? r.turns[n - 1] : null);
        document.getElementById('frp-turn').textContent = n === 0 ? 'READY · ' + r.turns.length + ' blows' : 'BLOW ' + n + ' / ' + r.turns.length;
        var rows = document.querySelectorAll('#frp-log .frp-row');
        var curRow = null;
        rows.forEach(function (row) {
            var t = Number(row.dataset.t);
            row.classList.toggle('cur', t === n && n > 0);
            row.classList.toggle('future', t > n);
            if (t === n && n > 0) curRow = row;
        });
        if (curRow) curRow.scrollIntoView({ block: 'nearest' });
    }

    async function openEntry(entry) {
        if (!entry) return;
        build();
        stop();
        st.entry = entry;
        document.getElementById('frp-new').style.display = 'none';
        document.getElementById('frp-overlay').classList.add('open');
        document.getElementById('frp-meta').textContent = 'Loading fight settings…';
        var settings = await getSettings();
        if (st.entry !== entry) return;   // another fight was picked while settings loaded
        st.replay = simulateEntry(entry, settings);
        st.byUid = {};
        st.replay.fighters.forEach(function (u) { st.byUid[u.uid] = u; });
        fillPicker();
        var r = entry.row, won = r.log === 'Team 1 wins';
        document.getElementById('frp-meta').innerHTML = esc((st.replay.venue || '').toUpperCase() + ' · ' + r.history_id + ' · ')
            + '<span style="color:' + (won ? '#60e090' : '#ff7070') + '">' + (won ? 'WON' : r.log === 'Team 2 wins' ? 'LOST' : esc(r.log)) + '</span>'
            + (st.replay.matchesChain
                ? '<span class="frp-chip ok" title="Simulated winner and blow count match the chain">&#10003; matches chain</span>'
                : '<span class="frp-chip warn" title="The simulation disagrees with the chain result — rules may have changed">&#9888; differs from chain</span>');
        renderLog();
        goTo(0);
        play();
    }

    function open(historyId) {
        var entry = find(historyId);
        if (!entry) { build(); document.getElementById('frp-overlay').classList.add('open'); fillPicker();
            document.getElementById('frp-meta').textContent = 'No saved fights yet — fight a dungeon or arena first.'; return; }
        openEntry(entry);
    }

    // Save a fight; open it too when asked. If a replay is already on screen, don't yank
    // it away mid-watch — just add the new fight to the list and flag it.
    function onFight(row, venue, autoOpen) {
        capture(row, venue);
        if (!autoOpen) return;
        if (isOpen()) {
            fillPicker();
            var flag = document.getElementById('frp-new');
            if (flag) flag.style.display = '';
            return;
        }
        openEntry(find(row.history_id));
    }

    window.AleReplay = {
        onFight: onFight,
        open: open,
        has: function (id) { return !!find(id); },
        capture: capture
    };
})();
