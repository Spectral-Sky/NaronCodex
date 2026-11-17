/* ALE Hub (alehub.html): Alien Legends activity at a glance.
   Fights come from the fight log the Apps Script poller publishes (ale_fight_poller.gs,
   "fights" sheet: one row per arena or dungeon fight with both teams' classes, races
   and fighter ids). winner 1 means the player's team won. The CSV is large, so it is
   kept in IndexedDB and fetched again at most every 30 minutes.
   Tavern hires are read from chain history (players.ale::hire, which records the
   player but not the tavern). The tavern draw is live chain state: every tavern
   ranked by how many players have it in their active_taverns; "draw" is its place in
   the game's queue for the next tavern handed out (lowest lands.ale tavern_score). */
(function () {
    'use strict';
    var FIGHTS_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ-hAPQk2ovvVSlVWR4UWEm91bF9yWem-bkSfteZyKmX8eO-cvUPJmJfeeJbpstKoOK6UWbURvphKq6/pub?gid=1899855497&single=true&output=csv';
    var RPC = ['https://wax.greymass.com', 'https://api.wax.alohaeos.com', 'https://wax.eosusa.io'];
    var HIST = ['https://wax-history.eosdac.io', 'https://hyperion.wax.detroitledger.tech', 'https://history.waxsweden.org'];
    var PLANETS = ['naron', 'magor', 'eyeke', 'kavian', 'neri', 'veles'];
    var CACHE_MS = 30 * 60e3, DECAY_PER_HOUR = 115, HOUR = 3600e3, DAY = 86400e3;
    var H = { period: '24h', fights: null, fightsAt: 0, hires: {}, wk: null, tags: {} };

    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function n(x, d) { return Number(x).toLocaleString('en', { maximumFractionDigits: d == null ? 0 : d }); }
    function pct(a, b) { return b ? (a / b * 100) : 0; }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function utcMs(s) { return Date.parse(/Z$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z'); }
    function status(t) { $('status').innerHTML = t; }

    /* ── small IndexedDB cache ── */
    function idb() {
        return new Promise(function (res, rej) {
            try {
                var r = indexedDB.open('alehub', 1);
                r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
                r.onsuccess = function () { res(r.result); };
                r.onerror = function () { rej(r.error); };
            } catch (e) { rej(e); }
        });
    }
    async function cacheGet(k) {
        try { var db = await idb(); return await new Promise(function (res) { var q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(null); }; }); }
        catch (e) { return null; }
    }
    async function cacheSet(k, v) {
        try { var db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) {}
    }

    /* ── chain helpers ── */
    async function rows(body) {
        for (var i = 0; i < RPC.length * 2; i++) {
            try {
                var r = await fetch(RPC[i % RPC.length] + '/v1/chain/get_table_rows', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
                if (r.ok) return await r.json();
            } catch (e) {}
        }
        return { rows: [] };
    }
    async function allRows(code, scope, table) {
        var out = [], lb = '';
        for (var p = 0; p < 20; p++) {
            var d = await rows({ json: true, code: code, scope: scope, table: table, limit: 1000, lower_bound: lb || undefined });
            out = out.concat(d.rows || []);
            if (!d.more) break;
            lb = d.next_key;
        }
        return out;
    }
    async function hist(path) {
        for (var k = 0; k < HIST.length * 2; k++) {
            try {
                var r = await fetch(HIST[k % HIST.length] + path, { signal: AbortSignal.timeout(20000) });
                if (r.ok) return await r.json();
                if (r.status === 429) await sleep(2000);
            } catch (e) {}
        }
        throw new Error('chain history unavailable');
    }

    /* ── fight log ── */
    // compact row: [time, wallet, 'a'|'d', difficulty, won 0/1, classes, fighter ids, races, elements]
    function parseCsv(text) {
        var lines = text.split('\n'), head = lines[0].split(','), col = {};
        head.forEach(function (h, i) { col[h.trim()] = i; });
        var out = [];
        for (var i = 1; i < lines.length; i++) {
            var c = lines[i].split(',');
            if (c.length < 12) continue;
            var t = utcMs(c[col.timestamp]);
            if (!t) continue;
            out.push([t, c[col.wallet], c[col.fight_type] === 'arena' ? 'a' : 'd', Number(c[col.dungeon_difficulty]) || 0,
                c[col.winner] === '1' ? 1 : 0, c[col.team1_classes] || '', c[col.team1_fighter_ids] || '', c[col.team1_races] || '', c[col.team1_elements] || '']);
        }
        return out;
    }
    async function loadFights(force) {
        var c = await cacheGet('fights2');
        if (c && !force && Date.now() - c.at < CACHE_MS) { H.fights = c.rows; H.fightsAt = c.at; return; }
        if (c) { H.fights = c.rows; H.fightsAt = c.at; render(); }
        status('Downloading the fight log…');
        var r = await fetch(FIGHTS_CSV);
        if (!r.ok) throw new Error('fight log HTTP ' + r.status);
        var total = Number(r.headers.get('content-length')) || 0, got = 0, chunks = [], reader = r.body.getReader();
        for (;;) {
            var x = await reader.read();
            if (x.done) break;
            chunks.push(x.value); got += x.value.length;
            status('Downloading the fight log… ' + (got / 1048576).toFixed(1) + ' MB' + (total ? ' of ' + (total / 1048576).toFixed(1) : ''));
        }
        var buf = new Uint8Array(got), o = 0;
        chunks.forEach(function (ch) { buf.set(ch, o); o += ch.length; });
        status('Reading ' + n(got / 1048576, 1) + ' MB of fights…');
        await sleep(20);
        H.fights = parseCsv(new TextDecoder().decode(buf));
        H.fightsAt = Date.now();
        cacheSet('fights2', { at: H.fightsAt, rows: H.fights });
    }

    /* ── periods ── */
    async function weekendWindow() {
        if (H.wk) return H.wk;
        var d = await rows({ json: true, code: 'arena.ale', scope: 'arena.ale', table: 'lbscopes', limit: 20 });
        var s = (d.rows || []).find(function (x) { return /weekend/.test(x.scope); });
        var now = Date.now();
        if (!s) { H.wk = { from: now - 2 * DAY, to: now, label: 'last 48 h' }; return H.wk; }
        var a = utcMs(s.leaderboard_start), b = utcMs(s.leaderboard_end), step = Number(s.start_to_start_seconds) * 1000;
        var live = now >= a && now < b;
        if (!live && now < a) { a -= step; b -= step; }
        H.wk = { from: a, to: Math.min(b, now), live: live, label: (live ? 'running now: ' : '') + fmtD(a) + ' → ' + fmtD(b) };
        return H.wk;
    }
    function fmtD(t) { return new Date(t).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'; }
    async function windowOf(p) {
        var now = Date.now();
        if (p === '24h') return { from: now - DAY, to: now, label: 'last 24 hours' };
        if (p === '7d') return { from: now - 7 * DAY, to: now, label: 'last 7 days' };
        if (p === '30d') return { from: now - 30 * DAY, to: now, label: 'last 30 days' };
        return weekendWindow();
    }

    /* ── tavern hires from chain history ── */
    function loadHires(w, per) {
        var key = per + '|' + Math.floor(w.from / 600e3);
        if (!H.hires[key]) H.hires[key] = scanHires(w).catch(function (e) { delete H.hires[key]; throw e; });
        return H.hires[key];
    }
    async function scanHires(w) {
        var cnt = {}, before = new Date(w.to).toISOString(), seen = {}, total = 0;
        for (var i = 0; i < 120; i++) {
            var j = await hist('/v2/history/get_actions?account=players.ale&filter=players.ale:hire&limit=100&sort=desc&after=' +
                new Date(w.from).toISOString() + '&before=' + before);
            var a = (j.actions || []).filter(function (x) { if (seen[x.global_sequence]) return false; seen[x.global_sequence] = 1; return true; });
            a.forEach(function (x) { var p = x.act.data.wallet; cnt[p] = (cnt[p] || 0) + 1; total++; });
            document.querySelectorAll('.hire-prog').forEach(function (x) { x.textContent = n(total); });
            if ((j.actions || []).length < 100 || !a.length) break;
            before = new Date(utcMs(a[a.length - 1]['@timestamp']) + 1000).toISOString();
        }
        return { cnt: cnt, total: total };
    }

    /* ── fighter art (from the game's own assets: new.alienlegends.io) ── */
    var ART = 'https://new.alienlegends.io/assets/';
    var ELEMENTS = ['air', 'fire', 'gem', 'metal', 'nature', 'neutral'];
    var RIM = { metal: '#c8733a', air: '#9fe6ff', nature: '#7dffb0', gem: '#ff7fc8', fire: '#ffb070', neutral: '#5b7fd6' };
    function el(e) { return ELEMENTS.indexOf(e) >= 0 ? e : 'neutral'; }
    function portrait(cls, race, element, size) {
        var e = el(element), k = String(cls || 'unknown') + '_' + String(race || 'unknown');
        return '<span class="art art-' + size + '" style="--rim:' + RIM[e] + ';background-image:url(' + ART + 'fighter/classes/backgrounds/full/full_background_' + e + '.jpeg)" title="' +
            esc(cls + ' ' + race + ' \u00b7 ' + e) + '"><img loading="lazy" alt="" src="' + ART + 'fighters/' + k + (size === 's' ? '_avatar' : '') + '.webp" ' +
            'onerror="this.onerror=null;this.src=\'' + ART + 'fighters/unknown_unknown.webp\'">' +
            '<img class="art-el" alt="" src="' + ART + 'icons/elements/' + e + '.svg"></span>';
    }
    function top(m) { var b = '', v = -1; Object.keys(m).forEach(function (k) { if (m[k] > v) { v = m[k]; b = k; } }); return b; }

    // the game's building icons, wherever an arena, dungeon or tavern is named
    function ic(k) { return '<img class="bi" alt="" src="Ale%20images/' + { arena: 'Arena', dungeon: 'dungeon', tavern: 'tavern' }[k] + '.svg">'; }

    var HARD = 12;   // dungeon difficulty from which a win is worth counting

    /* ── render ──
       Every section has its own period (24 h, 7 days, 30 days or the Weekend Challenge) and
       draws on its own, so a slow tavern-hire scan never holds the rest of the page back. */
    var SECS = { chips: '24h', tops: '24h', classes: '24h', fighters: '30d', heat: '7d', podium: '24h' };
    var PERIODS = [['24h', '24 h'], ['7d', '7 days'], ['30d', '30 days'], ['wk', 'Weekend']];
    var SEC_EL = { chips: 'chips', tops: 'tops', classes: 'classes', fighters: 'fighters', heat: 'heat', podium: 'podium' };
    function perButtons(sec) {
        return PERIODS.map(function (x) { return '<button type="button" data-p="' + x[0] + '"' + (SECS[sec] === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>'; }).join('');
    }
    function placeToggles() {
        Object.keys(SEC_EL).forEach(function (sec) {
            if (sec === 'heat') return;   // a weekday x hour grid: always the last 7 days
            var card = $(SEC_EL[sec]).closest('section'), bar = card.querySelector('.sper');
            if (!bar) {
                bar = document.createElement('div'); bar.className = 'sper'; bar.setAttribute('data-sec', sec); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Period');
                var hd = card.querySelector('h2');
                if (hd) { var row = document.createElement('div'); row.className = 'sec-head'; hd.parentNode.insertBefore(row, hd); row.appendChild(hd); row.appendChild(bar); }
                else card.insertBefore(bar, card.firstChild);
            }
            bar.innerHTML = perButtons(sec);
        });
    }
    document.addEventListener('click', function (e) {
        var b = e.target.closest('.sper[data-sec] button'); if (!b) return;
        var sec = b.parentNode.getAttribute('data-sec');
        SECS[sec] = b.getAttribute('data-p');
        b.parentNode.innerHTML = perButtons(sec);
        drawSection(sec);
    });
    async function sectionData(sec) {
        var w = await windowOf(SECS[sec]);
        return { w: w, f: H.fights.filter(function (r) { return r[0] >= w.from && r[0] <= w.to; }) };
    }
    async function render() {
        if (!H.fights) return;
        var newest = H.fights.length ? H.fights.reduce(function (m, r) { return r[0] > m ? r[0] : m; }, 0) : 0;
        status('Fight log up to ' + fmtD(newest) + ' · <a href="#" id="reload">refresh</a>');
        var rl = $('reload'); if (rl) rl.onclick = function (e) { e.preventDefault(); boot(true); };
        placeToggles();
        Object.keys(SECS).forEach(drawSection);
    }
    async function drawSection(sec) {
        var per = SECS[sec], d = await sectionData(sec);
        if (SECS[sec] !== per) return;   // clicked again while this was loading
        var f = d.f, w = d.w;
        var arena = f.filter(function (r) { return r[2] === 'a'; }), dung = f.filter(function (r) { return r[2] === 'd'; });
        var hard = dung.filter(function (r) { return r[3] >= HARD; });
        var card = $(SEC_EL[sec]).closest('section');
        var bar = card.querySelector('.sper'); if (bar) bar.title = w.label;
        if (sec === 'chips') drawChips(f, arena, dung, w, per);
        else if (sec === 'tops') drawTops(arena, hard, w, per);
        else if (sec === 'classes') drawClasses(f);
        else if (sec === 'fighters') drawFx(f);
        else if (sec === 'heat') drawHeat(f);
        else if (sec === 'podium') drawPodium(dung);
    }
    function hiresInto(w, per, sec, paint) {
        loadHires(w, per).then(function (h) { if (SECS[sec] === per) paint(h); }).catch(function () { if (SECS[sec] === per) paint(null, true); });
    }
    function drawChips(f, arena, dung, w, per) {
        var wins = f.filter(function (r) { return r[4]; }).length, players = {};
        f.forEach(function (r) { players[r[1]] = 1; });
        var paint = function (hires, failed) {
            $('chips').innerHTML = [
                ['Fights', n(f.length)], [ic('arena') + 'Arena', n(arena.length)], [ic('dungeon') + 'Dungeon', n(dung.length)],
                ['Won', pct(wins, f.length).toFixed(0) + '%'], ['Players fighting', n(Object.keys(players).length)],
                [ic('tavern') + 'Tavern hires', hires ? n(hires.total) : failed ? '\u2013' : '<small class="hire-prog">\u2026</small>']
            ].map(function (c) { return '<div class="chip"><span>' + c[0] + '</span><b>' + c[1] + '</b></div>'; }).join('');
        };
        paint(null);
        hiresInto(w, per, 'chips', paint);
    }
    function drawTops(arena, hard, w, per) {
        var tally = function (list) {
            var t = {};
            list.forEach(function (r) { var x = t[r[1]] = t[r[1]] || { w: 0, f: 0 }; x.f++; if (r[4]) x.w++; });
            return Object.keys(t).map(function (k) { return { k: k, w: t[k].w, f: t[k].f }; }).sort(function (a, b) { return b.w - a.w || a.f - b.f; }).slice(0, 10);
        };
        var table = function (title, list, cols, empty) {
            return '<div><h3 style="margin:0 0 6px;font-size:0.92em;color:var(--gold)">' + title + '</h3><table><thead><tr><th class="rk">#</th><th>Player</th>' +
                cols.map(function (c) { return '<th class="num">' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
                (list.length ? list.map(function (r, i) {
                    return '<tr><td class="rk">' + (i + 1) + '</td><td class="who" title="' + esc(r.k) + '">' + esc(H.tags[r.k] || r.k) + (H.tags[r.k] ? ' <small>' + esc(r.k) + '</small>' : '') + '</td>' + r.cells + '</tr>';
                }).join('') : '<tr><td colspan="4" class="empty">' + (empty || 'None in this period.') + '</td></tr>') + '</tbody></table></div>';
        };
        var asRows = function (l) { return l.map(function (x) { return { k: x.k, cells: '<td class="num"><b>' + n(x.w) + '</b></td><td class="num wr">' + pct(x.w, x.f).toFixed(0) + '%</td>' }; }); };
        var fights = table(ic('arena') + 'Arena wins', asRows(tally(arena)), ['Wins', 'Rate']) + table(ic('dungeon') + 'Dungeon wins, difficulty ' + HARD + '+', asRows(tally(hard)), ['Wins', 'Rate']);
        var paint = function (hires, failed) {
            var hireRows = hires ? Object.keys(hires.cnt).sort(function (a, b) { return hires.cnt[b] - hires.cnt[a]; }).slice(0, 10)
                .map(function (k) { return { k: k, cells: '<td class="num"><b>' + n(hires.cnt[k]) + '</b></td>' }; }) : [];
            $('tops').innerHTML = fights + table(ic('tavern') + 'Tavern hires', hireRows, ['Hires'],
                hires ? '' : failed ? 'Hire history unavailable right now.' : 'Reading hires\u2026 <span class="hire-prog"></span>');
        };
        paint(null);
        hiresInto(w, per, 'tops', paint);
    }
    function drawClasses(f) {
        // classes: arena wins and dungeon wins at difficulty 12+, each fighter in a winning team once
        var cls = {};
        f.forEach(function (r) {
            var counts = r[2] === 'a' || r[3] >= HARD;
            if (!counts) return;
            var rc = r[7].split('|'), ec = (r[8] || '').split('|');
            r[5].split('|').forEach(function (c, i) {
                if (!c) return;
                var x = cls[c] = cls[c] || { w: 0, f: 0, aw: 0, dw: 0, race: {}, el: {} };
                x.f++;
                if (r[4]) {
                    x.w++; if (r[2] === 'a') x.aw++; else x.dw++;
                    if (rc[i]) x.race[rc[i]] = (x.race[rc[i]] || 0) + 1; if (ec[i]) x.el[ec[i]] = (x.el[ec[i]] || 0) + 1;
                }
            });
        });
        var ck = Object.keys(cls).sort(function (a, b) { return cls[b].w - cls[a].w; });
        var cmax = ck.length ? cls[ck[0]].w : 1;
        $('classes').innerHTML = ck.length ? ck.map(function (c) {
            var x = cls[c];
            return '<div class="bar" title="' + esc(c + ': ' + n(x.aw) + ' arena wins, ' + n(x.dw) + ' dungeon ' + HARD + '+ wins, of ' + n(x.f) + ' fights') + '"><span class="lab">' + portrait(c, top(x.race), top(x.el), 's') + esc(c) + '</span>' +
                '<span class="trk trk2"><i class="ia" style="width:' + (x.aw / cmax * 100).toFixed(1) + '%"></i><i class="id" style="width:' + (x.dw / cmax * 100).toFixed(1) + '%"></i></span>' +
                '<span class="val"><b>' + n(x.w) + '</b> \u00b7 ' + pct(x.w, x.f).toFixed(0) + '%</span></div>';
        }).join('') + '<div class="legend2"><span><i class="ia"></i>' + ic('arena') + 'Arena wins</span><span><i class="id"></i>' + ic('dungeon') + 'Dungeon ' + HARD + '+ wins</span></div>' : '<div class="empty">No arena or dungeon ' + HARD + '+ fights in this period.</div>';

    }
    function drawFx(f) {
        // top fighters: arena and dungeon 12+ kept apart, ranked on the two together
        var fx = {};
        f.forEach(function (r) {
            var isA = r[2] === 'a', isH = !isA && r[3] >= HARD;
            if (!isA && !isH) return;
            var ids = r[6].split('|'), cl = r[5].split('|'), rc = r[7].split('|'), ec = (r[8] || '').split('|');
            ids.forEach(function (id, i) {
                if (!id) return;
                var x = fx[id] = fx[id] || { aw: 0, af: 0, dw: 0, df: 0, cls: cl[i] || '', race: rc[i] || '', el: ec[i] || '', owner: r[1] };
                if (isA) { x.af++; if (r[4]) x.aw++; } else { x.df++; if (r[4]) x.dw++; }
            });
        });
        H.fx = fx;
        drawFighters();

    }
    function drawHeat(f) {
        // heatmap: weekday x hour, UTC
        var grid = [], mx = 1, DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        for (var d = 0; d < 7; d++) { grid.push([]); for (var h = 0; h < 24; h++) grid[d].push(0); }
        f.forEach(function (r) { var t = new Date(r[0]); var d2 = (t.getUTCDay() + 6) % 7; grid[d2][t.getUTCHours()]++; });
        grid.forEach(function (row) { row.forEach(function (v) { if (v > mx) mx = v; }); });
        var hh = '<div class="heat"><span></span>';
        for (var h2 = 0; h2 < 24; h2++) hh += '<span class="hh">' + (h2 % 3 === 0 ? h2 : '') + '</span>';
        grid.forEach(function (row, d3) {
            hh += '<span class="hl">' + DAYS[d3] + '</span>';
            row.forEach(function (v, h3) {
                var a = v ? 0.12 + 0.88 * v / mx : 0;
                hh += '<span class="c" style="' + (v ? 'background:rgba(232,160,32,' + a.toFixed(2) + ')' : '') + '" title="' + DAYS[d3] + ' ' + String(h3).padStart(2, '0') + ':00 UTC: ' + n(v) + ' fights"></span>';
            });
        });
        $('heat').innerHTML = hh + '</div><div class="heat-key">fewer <i style="background:rgba(232,160,32,0.15)"></i><i style="background:rgba(232,160,32,0.5)"></i><i style="background:rgba(232,160,32,1)"></i> more · busiest hour: ' +
            (function () { var b = [0, 0, 0]; grid.forEach(function (row, d4) { row.forEach(function (v, h4) { if (v > b[0]) b = [v, d4, h4]; }); }); return b[0] ? DAYS[b[1]] + ' ' + String(b[2]).padStart(2, '0') + ':00 (' + n(b[0]) + ' fights)' : 'none'; })() + '</div>';

    }
    function drawPodium(dung) {
        // dungeon podium: players by wins at difficulty 10+, each difficulty won shown as a pin (x count)
        var pod = {};
        dung.forEach(function (r) {
            if (!r[4] || r[3] < PODMIN) return;
            var x = pod[r[1]] = pod[r[1]] || { w: 0, top: 0, sum: 0, by: {} };
            x.w++; x.sum += r[3]; x.top = Math.max(x.top, r[3]); x.by[r[3]] = (x.by[r[3]] || 0) + 1;
        });
        var pk = Object.keys(pod).sort(function (a, b) { return pod[b].w - pod[a].w || pod[b].top - pod[a].top; });
        var pins = function (x) {
            return Object.keys(x.by).map(Number).sort(function (a, b) { return b - a; }).map(function (d) {
                return '<span class="pin" style="--pc:' + pinCol(d) + '" title="' + esc(n(x.by[d]) + ' win' + (x.by[d] === 1 ? '' : 's') + ' at difficulty ' + d) + '"><b>' + d + '</b>' + (x.by[d] > 1 ? '<i>\u00d7' + x.by[d] + '</i>' : '') + '</span>';
            }).join('');
        };
        var who = function (w) { return esc(H.tags[w] || w); };
        // score: the difficulties of every 10+ win added up, over those wins (the average difficulty beaten)
        var score = function (x) { return '<span class="pscore" title="' + esc('Score: ' + n(x.sum) + ' difficulty levels over ' + n(x.w) + ' wins') + '">Score <b>' + (x.sum / x.w).toFixed(2) + '</b></span>'; };
        var step = function (i) {
            var w = pk[i]; if (!w) return '<div class="pod-col p' + (i + 1) + ' empty-step"></div>';
            var x = pod[w];
            return '<div class="pod-col p' + (i + 1) + '"><div class="pod-who" title="' + esc(w) + '"><span class="medal">' + ['1st', '2nd', '3rd'][i] + '</span><span class="nm">' + who(w) + '</span></div>' +
                '<div class="pins">' + pins(x) + '</div>' +
                '<div class="pod-step"><b>' + n(x.w) + '</b><small>win' + (x.w === 1 ? '' : 's') + '</small>' + score(x) + '</div></div>';
        };
        $('podium').innerHTML = pk.length ? '<div class="pod">' + step(1) + step(0) + step(2) + '</div>' +
            (pk.length > 3 ? '<ol class="pod-rest" start="4">' + pk.slice(3, 10).map(function (w) {
                return '<li><span class="who" title="' + esc(w) + '">' + who(w) + '</span><span class="pins">' + pins(pod[w]) + '</span><b>' + n(pod[w].w) + '</b>' + score(pod[w]) + '</li>';
            }).join('') + '</ol>' : '')
            : '<div class="empty">No dungeon wins at difficulty ' + PODMIN + '+ in this period.</div>';
    }

    // top fighters show one mode at a time: arena, or dungeon 12+ (the swap button flips it)
    var FMODE = 'a';
    function drawFighters() {
        var fx = H.fx || {}, A = FMODE === 'a', wk = A ? 'aw' : 'dw', fk2 = A ? 'af' : 'df';
        var label = A ? 'Arena' : 'Dungeon ' + HARD + '+';
        var fk = Object.keys(fx).filter(function (id) { return fx[id][wk] > 0; })
            .sort(function (a, b) { return fx[b][wk] - fx[a][wk] || fx[a][fk2] - fx[b][fk2]; }).slice(0, 15);
        var sw = '<button type="button" class="fswap" id="fswap" title="Swap to ' + (A ? 'dungeon ' + HARD + '+' : 'arena') + '">⇄ ' + (A ? ic('dungeon') + 'Dungeon ' + HARD + '+' : ic('arena') + 'Arena') + '</button>';
        $('fmode').innerHTML = ic(A ? 'arena' : 'dungeon') + label + ' wins' + sw;
        $('fswap').onclick = function () { FMODE = A ? 'd' : 'a'; drawFighters(); };
        $('fighters').innerHTML = fk.length ? '<table><thead><tr><th class="rk">#</th><th></th><th>Fighter</th><th>Class</th><th>Race</th><th>Element</th><th>Owner</th>' +
            '<th class="num">' + label + ' wins</th><th class="num">Rate</th><th class="num" title="Days since the fighter was hired, and the share of its health and damage it still fights with">Age</th></tr></thead><tbody>' +
            fk.map(function (id, i) {
                var x = fx[id];
                return '<tr class="fr" data-fid="' + esc(id) + '"><td class="rk">' + (i + 1) + '</td><td class="pic">' + portrait(x.cls, x.race, x.el, 'm') + '</td><td>#' + esc(id) + '</td><td style="text-transform:capitalize">' + esc(x.cls) + '</td>' +
                    '<td style="text-transform:capitalize">' + esc(x.race) + '</td><td style="text-transform:capitalize;color:' + RIM[el(x.el)] + '">' + esc(x.el || '–') + '</td><td class="who">' + esc(H.tags[x.owner] || x.owner) + '</td>' +
                    '<td class="num"><b>' + n(x[wk]) + '</b></td><td class="num wr">' + pct(x[wk], x[fk2]).toFixed(0) + '%</td><td class="num age" data-age="' + esc(id) + '">\u2026</td></tr>';
            }).join('') + '</tbody></table><p class="sub" style="margin:8px 0 0">Hover a fighter for its stats. Age is days since it was hired; the % is how much of its health and damage it still fights with, ' +
            'since the game shrinks both by age_decay<sup>days\u00b2</sup>: barely felt for weeks, then falling fast (about 92% at 60 days, 82% at 100, 45% at 200).</p>' : '<div class="empty">No ' + label.toLowerCase() + ' wins in this period.</div>';
        bindFighterTips();
        fk.forEach(function (id) {
            fighter(id).then(function (r) {
                var td = document.querySelector('#fighters td[data-age="' + id + '"]'); if (!td) return;
                td.innerHTML = r ? ageHtml(r.creation_date) : '<small class="wr">gone</small>';
            }).catch(function () {});
        });
    }

    /* fighter age: whole days since creation, and age_decay ^ days^2 (the contract's apply_weather_and_age) */
    var AGE_DECAY = 0.99997997283935547;
    rows({ json: true, code: 'battle.ale', scope: 'battle.ale', table: 'config', limit: 1 })
        .then(function (d) { var v = Number(((d.rows || [])[0] || {}).age_decay); if (v > 0 && v < 1) AGE_DECAY = v; }).catch(function () {});
    function ageOf(created) {
        var t = Date.parse(String(created || '') + 'Z'); if (!isFinite(t)) return null;
        var days = Math.max(0, Math.floor((Date.now() - t) / DAY));
        return { days: days, f: Math.pow(AGE_DECAY, days * days) };
    }
    function ageHtml(created) {
        var a = ageOf(created); if (!a) return '\u2013';
        var p = a.f * 100, c = p >= 90 ? 'var(--win)' : p >= 70 ? 'var(--gold)' : '#ff6b6b';
        return '<span title="' + esc(a.days + ' days old: fights at ' + p.toFixed(1) + '% health and damage') + '">' + a.days + 'd <b style="color:' + c + '">' + p.toFixed(0) + '%</b></span>';
    }

    var PODMIN = 10;
    function pinCol(d) { return ['#4fb3cf', '#6c8bff', '#b06cff', '#ff5fa8', '#ff7a3d', '#ffd04a'][Math.min(Math.max(d - PODMIN, 0), 5)]; }

    /* ── fighter stat card (hover) ──
       fighters.ale::fighters.stats holds every stat at ten times its shown value; the game
       shows each as its midpoint and swing, "73 (\u00b111)". Cooldown (attackspeed) and Wind-up
       (initiative) are timings, so lower is better. */
    var FCACHE = {}, TIP = null;
    var STATS = [['health', 'Health'], ['damage', 'Damage'], ['taunt', 'Taunt'], ['attackspeed', 'Cooldown'], ['initiative', 'Wind-up']];
    var RES = ['gem', 'metal', 'air', 'fire', 'nature', 'neutral'];
    async function fighter(id) {
        if (FCACHE[id]) return FCACHE[id];
        var d = await rows({ json: true, code: 'fighters.ale', scope: 'fighters.ale', table: 'fighters', lower_bound: id, upper_bound: id, limit: 1 });
        FCACHE[id] = (d.rows || [])[0] || null;
        return FCACHE[id];
    }
    function statText(lo, hi) {
        var v = Math.floor((lo + hi) / 2 / 10), sp = Math.floor(Math.abs(hi - lo) / 2 / 10);
        return sp > 0 ? v + ' <small>(\u00b1' + sp + ')</small>' : String(v);
    }
    function tipHtml(f) {
        var st = f.stats || {}, e = el(f.element);
        var abil = (st.abilities || []).map(function (a) {
            var m = /\[(\w+)\]\s*$/.exec(a.displayname || ''), rar = m ? m[1] : '';
            return '<li><b class="r-' + esc(rar) + '">' + esc(String(a.displayname || a.ability).replace(/\s*\[\w+\]\s*$/, '')) + '</b>' + (rar ? ' <small>' + esc(rar) + '</small>' : '') + '</li>';
        }).join('');
        return '<div class="tip-h">' + portrait(f.classname, f.racename, f.element, 'm') + '<div><b style="text-transform:capitalize">' + esc(f.classname + ' ' + f.racename) + '</b>' +
            '<small>#' + esc(f.fighter_id) + ' \u00b7 level ' + (st.level || '?') + (Number(f.ascension_level) ? ' \u00b7 ascension ' + f.ascension_level : '') + ' \u00b7 age ' + ageHtml(f.creation_date) + ' \u00b7 <span style="color:' + RIM[e] + ';text-transform:capitalize">' + e + '</span></small>' +
            '<small>' + esc(H.tags[f.owner] || f.owner) + '</small></div></div>' +
            '<table class="tip-s">' + STATS.map(function (x) {
                return '<tr><td>' + x[1] + (x[0] === 'attackspeed' || x[0] === 'initiative' ? ' <small>lower is better</small>' : '') + '</td><td class="num">' + statText(Number(st[x[0] + '_min']) || 0, Number(st[x[0] + '_max']) || 0) + '</td></tr>';
            }).join('') + '</table>' +
            '<div class="tip-r">' + RES.map(function (r) {
                return '<span title="' + r + ' resistance"><img src="' + ART + 'icons/elements/' + r + '.svg" alt="">' + Math.round((Number(st['res_' + r]) || 0) / 10) + '%</span>';
            }).join('') + '</div>' + (abil ? '<ul class="tip-a">' + abil + '</ul>' : '');
    }
    function bindFighterTips() {
        if (!TIP) { TIP = document.createElement('div'); TIP.className = 'ftip'; TIP.hidden = true; document.body.appendChild(TIP); }
        document.querySelectorAll('#fighters tr.fr').forEach(function (tr) {
            var id = tr.getAttribute('data-fid');
            var place = function (ev) {
                var w = TIP.offsetWidth || 300, h = TIP.offsetHeight || 300;
                var x = ev.clientX + 18, y = ev.clientY + 12;
                if (x + w > window.innerWidth - 8) x = ev.clientX - w - 18;
                if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
                TIP.style.left = x + 'px'; TIP.style.top = y + 'px';
            };
            tr.onmouseenter = async function (ev) {
                TIP.innerHTML = '<p class="sub" style="margin:0">Reading fighter #' + esc(id) + '\u2026</p>'; TIP.hidden = false; place(ev);
                var f = await fighter(id);
                if (TIP.hidden || tr.getAttribute('data-hover') !== '1') return;
                TIP.innerHTML = f ? tipHtml(f) : '<p class="sub" style="margin:0">Fighter #' + esc(id) + ' isn\u2019t on chain any more (sold or burned).</p>';
                place(ev);
            };
            tr.onmousemove = place;
            tr.addEventListener('mouseenter', function () { tr.setAttribute('data-hover', '1'); });
            tr.onmouseleave = function () { tr.removeAttribute('data-hover'); TIP.hidden = true; };
        });
    }

    /* ── live tavern draw ── */
    var TV = { list: null, prev: {}, at: 0, busy: false, players: 0 };
    async function loadTaverns() {
        if (TV.busy) return;
        TV.busy = true;
        try {
            var lands = [];
            for (var i = 0; i < PLANETS.length; i++) {
                var pl = PLANETS[i];
                (await allRows('lands.ale', pl, 'lands')).forEach(function (l) { l._p = pl; lands.push(l); });
            }
            var players = await allRows('players.ale', 'players.ale', 'players');
            var inLists = {}, inActive = {}, active = 0, since = Date.now() - 3 * DAY;
            players.forEach(function (p) {
                if (p.playertag) H.tags[p.wallet] = p.playertag;
                var on = utcMs(p.last_action) >= since; if (on) active++;
                (p.active_taverns || []).forEach(function (t) {
                    var k = String(t.planet).replace(/[^a-z]/g, '') + '|' + t.x + '|' + t.y;
                    inLists[k] = (inLists[k] || 0) + 1; if (on) inActive[k] = (inActive[k] || 0) + 1;
                });
            });
            var assets = {}, list = [];
            lands.forEach(function (l) {
                (l.buildings || []).forEach(function (b) {
                    if (b.building_name !== 'tavern') return;
                    var k = l._p + '|' + l.x + '|' + l.y, u = utcMs(b.boost_score_update), hrs = isNaN(u) ? 0 : Math.max(0, (Date.now() - u) / HOUR);
                    list.push({ k: k, p: l._p, x: Number(l.x), y: Number(l.y), score: Number(l.tavern_score) || 0, asset: String(l.asset_id || ''),
                        boost: Math.max(0, Number(b.boost_score || 0) - hrs * DECAY_PER_HOUR) / 100000, all: inLists[k] || 0, act: inActive[k] || 0 });
                    if (l.asset_id && String(l.asset_id) !== '0') assets[l.asset_id] = 1;
                });
            });
            // owners of the tavern lands, once
            if (!TV.owner) {
                TV.owner = {};
                try {
                    var r = await fetch('https://wax.api.atomicassets.io/atomicassets/v1/assets?ids=' + Object.keys(assets).join(',') + '&limit=100');
                    ((await r.json()).data || []).forEach(function (a) { TV.owner[a.asset_id] = a.owner; });
                } catch (e) {}
            }
            list.sort(function (a, b) { return a.score - b.score; });
            list.forEach(function (t, i) { t.draw = i + 1; });
            if (TV.list) { TV.prev = { act: {}, all: {} }; ['act', 'all'].forEach(function (m) { tvSorted(TV.list, m).forEach(function (t, i) { TV.prev[m][t.k] = { pos: i, n: t[m] }; }); }); }
            TV.list = list; TV.at = Date.now(); TV.players = players.length; TV.active = active;
        } catch (e) {}
        TV.busy = false;
        paintTaverns();
    }
    // which lists count: 'act' = players who did anything in the last 72 h, 'all' = every list
    TV.mode = 'act';
    function tvSorted(list, m) {
        return list.slice().sort(function (a, b) { return ((a.boost <= 0) - (b.boost <= 0)) || b[m] - a[m] || a.draw - b.draw; });
    }
    function paintTaverns() {
        var el = $('feed');
        if (!TV.list) { el.innerHTML = '<div class="feed-h"><b>' + ic('tavern') + 'Tavern draw</b><span class="live"></span></div><p class="feed-note">Reading players’ tavern lists…</p>'; return; }
        var m = TV.mode, A = m === 'act', list = tvSorted(TV.list, m), prev = (TV.prev || {})[m] || {};
        var max = Math.max.apply(null, list.map(function (t) { return t[m]; }).concat([1]));
        el.innerHTML = '<div class="feed-h"><b>' + ic('tavern') + 'Tavern draw</b><span class="live"></span><small>' + (A ? TV.active + ' active of ' : '') + TV.players + ' players · ' +
            new Date(TV.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</small></div>' +
            '<div class="tvmode" role="group" aria-label="Which lists count"><button type="button" data-m="act"' + (A ? ' class="on"' : '') + '>Active 72 h</button><button type="button" data-m="all"' + (A ? '' : ' class="on"') + '>All lists</button></div>' +
            '<p class="feed-note">' + (A ? 'How many players who played in the last 72 hours have each tavern in their list. Lists of players who stopped playing are left out.'
                : 'How many players have each tavern in their list right now, including players who may have stopped playing.') +
            ' Draw is its place in the queue for the next tavern the game hands out (1 = next). Updates every minute.</p>' +
            '<ol class="tv">' + list.map(function (t, i) {
                t.n = t[m];
                var pv = prev[t.k], mv = pv ? pv.pos - i : 0, dn = pv ? t.n - pv.n : 0, zero = t.boost <= 0, own = TV.owner && TV.owner[t.asset];
                return '<li class="' + (zero ? 'zero' : mv > 0 ? 'up' : mv < 0 ? 'down' : '') + '"><span class="pos">' + (i + 1) + '</span><div class="m">' +
                    '<div class="t"><b>' + esc(t.p.charAt(0).toUpperCase() + t.p.slice(1)) + ' ' + t.x + ':' + t.y + '</b><span class="x">' + t.boost.toFixed(1) + 'x</span>' +
                    (mv ? '<span class="mv">' + (mv > 0 ? '▲' : '▼') + Math.abs(mv) + '</span>' : '') + '</div>' +
                    '<div class="tb"><i style="width:' + (t.n / max * 100).toFixed(1) + '%"></i></div>' +
                    '<small>in <b>' + t.n + '</b> ' + (A ? 'active ' : '') + 'list' + (t.n === 1 ? '' : 's') + (dn ? ' (' + (dn > 0 ? '+' : '') + dn + ')' : '') + (A ? ' <span class="of">of ' + t.all + '</span>' : '') + ' · draw #' + t.draw +
                    (own ? ' · ' + esc(H.tags[own] || own) : '') + '</small>' +
                    (zero ? '<small class="zn">0x boost: may not be drawn any more</small>' : '') + '</div></li>';
            }).join('') + '</ol>';
        el.querySelectorAll('.tvmode button').forEach(function (b) { b.onclick = function () { TV.mode = b.getAttribute('data-m'); paintTaverns(); }; });
    }


    /* ── Profitability ───────────────────────────────────────────────────────
       In: WAX buys only gems. Every purchase is a WAX transfer to shop.ale with
       memo "purchase,gem.small|medium|large|giant" (100 / 1,100 / 12,500 / 140,000
       gems for 49 / 499 / 4,999 / 49,999 WAX); signing up is a WAX transfer to
       players.ale with memo "signup". Out: each player's lifetime totals in
       players.ale permstats: tlm_earned (4 decimals), wax_earned (8) and
       shards_earned (tenths). TLM is valued in WAX at Alcor's latest daily close;
       shards have no market price, so they are counted, not valued. */
    var PF = { spend: null, players: null, tlmWax: 0, sel: '', sort: 'net', busy: false, detail: {} };
    var PACK = { small: [49, 100], medium: [499, 1100], large: [4999, 12500], giant: [49999, 140000] };
    // Beta began 1 Sept 2026 and wiped everything before it; gems bought in alpha were
    // credited again in full at Beta start, so they're shown but not counted as spend.
    var BETA = Date.UTC(2026, 8, 1);
    var LOGO = { TLM: 'https://wax.alcor.exchange/api/v2/tokens/tlm-alien.worlds/logo', WAX: 'https://wax.alcor.exchange/api/v2/tokens/wax-eosio.token/logo', SHARDS: 'Shards.png' };
    // an amount with its token's logo; shards in purple
    function tk(sym, amt) {
        var k = String(sym).toUpperCase().replace(/^SHRDS$|^SHARD$/, 'SHARDS');
        return (LOGO[k] ? '<img class="tk" src="' + LOGO[k] + '" alt="">' : '') +
            '<span class="' + (k === 'SHARDS' ? 'shd' : '') + '">' + amt + ' ' + (k === 'SHARDS' ? 'shards' : k) + '</span>';
    }
    function stat(p, k) { var x = (p.permstats || []).find(function (s2) { return s2.first === k; }); return x ? Number(x.second) : 0; }
    async function loadPlayers() {
        if (PF.players && Date.now() - PF.playersAt < 5 * 60e3) return PF.players;
        PF.players = await allRows('players.ale', 'players.ale', 'players'); PF.playersAt = Date.now();
        PF.players.forEach(function (p) { if (p.playertag) H.tags[p.wallet] = p.playertag; });
        return PF.players;
    }
    async function loadTlmPrice() {
        if (PF.tlmWax) return PF.tlmWax;
        try {
            var now = Date.now(), r = await fetch('https://wax.alcor.exchange/api/v2/swap/candles?tokenA=tlm-alien.worlds&tokenB=wax-eosio.token&resolution=1D&from=' + (now - 5 * DAY) + '&to=' + now);
            var j = await r.json(), c = (j.candles || j || []);
            PF.tlmWax = parseFloat(c[c.length - 1].close) || 0;
        } catch (e) {}
        return PF.tlmWax;
    }
    // every gem purchase and signup, newest first; cached, and topped up from where it stopped
    function loadSpend() {
        if (!PF.spendP || Date.now() - ((PF.spend && PF.spend.at) || 0) > 10 * 60e3) PF.spendP = loadSpend_();
        return PF.spendP;
    }
    async function loadSpend_() {
        var c = (await cacheGet('spend3')) || { top: {}, by: {}, at: 0 };
        var scan = async function (acct, test, add) {
            var before = '', seen = {}, newTop = c.top[acct] || 0, stop = c.top[acct] || 0;
            for (var i = 0; i < 200; i++) {
                var j = await hist('/v2/history/get_actions?account=' + acct + '&filter=eosio.token:transfer&limit=100&sort=desc' + (before ? '&before=' + before : ''));
                var a = (j.actions || []).filter(function (x) { if (seen[x.global_sequence]) return false; seen[x.global_sequence] = 1; return true; });
                var done = false;
                a.forEach(function (x) {
                    var gs = Number(x.global_sequence);
                    if (gs > newTop) newTop = gs;
                    if (gs <= stop) { done = true; return; }
                    var d = x.act.data;
                    if (d.to === acct && test(d)) add(d, utcMs(x['@timestamp']));
                });
                if (!document.querySelector('[data-panel="profit"]').hidden) status('Reading gem purchases\u2026 ' + acct + ' page ' + (i + 1));
                if (done || (j.actions || []).length < 100 || !a.length) break;
                before = new Date(utcMs(a[a.length - 1]['@timestamp']) + 1000).toISOString();
            }
            c.top[acct] = newTop;
        };
        var w = function (k) { return c.by[k] = c.by[k] || { wax: 0, signup: 0, packs: {}, paid: {}, alphaWax: 0, alphaGems: 0 }; };
        await scan('shop.ale', function (d) { return /^purchase,gem\./.test(d.memo || ''); }, function (d, t) {
            var x = w(d.from), pk = String(d.memo).split('gem.')[1];
            var amt = Number(d.amount) || parseFloat(d.quantity) || 0;
            if (t < BETA) { x.alphaWax += amt; x.alphaGems += (PACK[pk] || [0, 0])[1]; return; }
            x.wax += amt; x.packs[pk] = (x.packs[pk] || 0) + 1; x.paid[pk] = (x.paid[pk] || 0) + amt;
        });
        await scan('players.ale', function (d) { return d.memo === 'signup'; }, function (d, t) { if (t >= BETA) w(d.from).signup += Number(d.amount) || parseFloat(d.quantity) || 0; });
        c.at = Date.now();
        cacheSet('spend3', c);
        PF.spend = c;
        return c;
    }
    /* What things are worth, in WAX, from the game's own prices: gems at the best gem
       pack; credits at the best credit pack (paid in gems); energy at the best energy
       pack (paid in credits). Shards: Alien Worlds' shard shop (uspts.worlds pointoffers,
       10 points = 1 shard) priced at each item's recent AtomicHub sales. */
    var RATES = null, SHARD = { list: null, ref: '' };
    async function loadRates() {
        if (RATES) return RATES;
        var it = (await rows({ json: true, code: 'shop.ale', scope: 'shop.ale', table: 'shopitems', limit: 100 })).rows || [];
        var best = function (f) { var v = it.map(f).filter(function (x) { return x > 0 && isFinite(x); }); return v.length ? Math.min.apply(null, v) : 0; };
        var gemWax = best(function (x) { return x.category === 'gems' && x.gain_gem ? parseFloat(x.cost_wax) / x.gain_gem : 0; });
        var credGem = best(function (x) { return x.category === 'credits' && x.gain_dust ? x.cost_gem / x.gain_dust : 0; });
        var nrgCred = best(function (x) { return x.category === 'flasks' && x.cost_dust && x.gain_action_points ? x.cost_dust / x.gain_action_points : 0; });
        RATES = { gem: gemWax, credit: credGem * gemWax, energy: nrgCred * credGem * gemWax };
        return RATES;
    }
    async function loadShards() {
        if (SHARD.list) return SHARD.list;
        var offers = await allRows('uspts.worlds', 'uspts.worlds', 'pointoffers'), now = Date.now();
        offers = offers.filter(function (o) { return utcMs(o.start) <= now && utcMs(o.end) >= now; });
        var ids = offers.map(function (o) { return o.template_id; }).filter(function (v, i, a) { return a.indexOf(v) === i; }), info = {};
        try {
            var tr = await fetch('https://wax.api.atomicassets.io/atomicassets/v1/templates?collection_name=alien.worlds&ids=' + ids.join(',') + '&limit=100');
            ((await tr.json()).data || []).forEach(function (t) { info[t.template_id] = { name: t.immutable_data.name, rarity: t.immutable_data.rarity }; });
        } catch (e) {}
        // the priciest offers matter most; each is priced at the average of its last 10 completed
        // sales (never a listing price); the default pools the last 10 sales across every Mythic
        offers.sort(function (a, b) { return b.required - a.required; });
        var list = [];
        for (var i = 0; i < offers.length && i < 14; i++) {
            var o = offers[i];
            try {
                var sr = await fetch('https://wax.api.atomicassets.io/atomicmarket/v1/sales?state=3&collection_name=alien.worlds&template_id=' + o.template_id + '&sort=updated&order=desc&limit=10');
                var sales = ((await sr.json()).data || []).filter(function (x) { return x.price.token_symbol === 'WAX'; })
                    .map(function (x) { return { t: Number(x.updated_at_time) || 0, wax: Number(x.price.amount) / Math.pow(10, x.price.token_precision) }; });
                var px = sales.map(function (x) { return x.wax; });
                if (!px.length) continue;
                var med = px.reduce(function (t, v) { return t + v; }, 0) / px.length, sh = o.required / 10, nm = (info[o.template_id] || {}).name || '#' + o.template_id;
                if (list.some(function (l) { return l.name === nm; })) continue;
                list.push({ name: nm, rarity: (info[o.template_id] || {}).rarity || '', shards: sh, wax: med, sales: px.length, rate: med / sh,
                    recent: sales.map(function (x) { return { t: x.t, rate: x.wax / sh }; }) });
            } catch (e) {}
        }
        var myth = [];
        list.forEach(function (l) { if (/myth/i.test(l.rarity)) l.recent.forEach(function (x) { myth.push({ t: x.t, rate: x.rate, name: l.name }); }); });
        myth.sort(function (a, b) { return b.t - a.t; });
        myth = myth.slice(0, 10);
        if (myth.length) {
            var avg = myth.reduce(function (t, x) { return t + x.rate; }, 0) / myth.length;
            var items = myth.map(function (x) { return x.name; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
            list.unshift({ name: 'Mythic average', rarity: 'Mythical', shards: 0, wax: 0, sales: myth.length, rate: avg, items: items, combined: true });
        }
        SHARD.list = list;
        if (!SHARD.ref) SHARD.ref = (list[0] || {}).name || '';
        return list;
    }
    function shardNote() {
        var l = (SHARD.list || []).find(function (x) { return x.name === SHARD.ref; });
        var t = l && !/myth/i.test(l.rarity) ? 'Estimated based on ' + l.name + ' (' + l.rarity + ') mint cost and average of ' + l.sales + ' last sold'
            : 'Estimated based on Mythic mint cost and average of ' + (l ? l.sales : 10) + ' last sold';
        return '<abbr class="est" title="' + esc(t) + '">*</abbr>';
    }
    function shardRate() { var l = (SHARD.list || []).find(function (x) { return x.name === SHARD.ref; }); return l ? l.rate : 0; }

    function profitRows() {
        var t = PF.tlmWax || 0;
        return (PF.players || []).map(function (p) {
            var sp = PF.spend.by[p.wallet] || { wax: 0, signup: 0, packs: {}, paid: {}, alphaWax: 0, alphaGems: 0 };
            var tlm = stat(p, 'tlm_earned') / 1e4, wax = stat(p, 'wax_earned') / 1e8, sh = stat(p, 'shards_earned') / 10;
            var spent = sp.wax + sp.signup, got = tlm * t + wax;
            var a = p.activestats || {}, R = RATES || { gem: 0, credit: 0, energy: 0 };
            var held = { gems: Number(a.gems) || 0, credits: Number(a.credits) || 0, energy: Number(a.action_points) || 0 };
            var heldWax = held.gems * R.gem + held.credits * R.credit + held.energy * R.energy, shWax = sh * shardRate();
            return { w: p.wallet, tag: p.playertag || '', spent: spent, gems: sp.wax, signup: sp.signup, packs: sp.packs, paid: sp.paid || {},
                alphaWax: sp.alphaWax || 0, alphaGems: sp.alphaGems || 0, tlm: tlm, wax: wax, sh: sh, got: got, net: got - spent,
                held: held, heldWax: heldWax, shWax: shWax, netAll: got + heldWax + shWax - spent,
                credGained: stat(p, 'credits_gained'), credFarm: stat(p, 'alf_credits_claimed'), legendMonths: stat(p, 'premium_account_months') };
        }).filter(function (r) { return r.spent > 0 || r.got > 0; });
    }
    async function openProfit() {
        if (PF.busy) return;
        PF.busy = true;
        $('prof-main').innerHTML = '<section class="card"><p class="sub">Reading players, gem purchases and the TLM price\u2026</p></section>';
        try { await Promise.all([loadPlayers(), loadTlmPrice(), loadSpend(), loadRates(), loadShards()]); }
        catch (e) { $('prof-main').innerHTML = '<section class="card"><p class="sub">Could not read the chain: ' + esc(e.message) + '</p></section>'; PF.busy = false; return; }
        PF.busy = false;
        status('<b>Since Beta began (1 Sept 2026)</b> \u00b7 every player \u00b7 1 TLM \u2248 ' + n(PF.tlmWax, 4) + ' WAX (Alcor)');
        if (!PF.sel) PF.sel = localStorage.getItem('naron_wallet') || '';
        paintBoard(); paintDetail(); paintTeaser();
    }
    function paintTeaser() {
        if (!PF.spend || !PF.players) return;
        var rs = profitRows(), sp = 0, got = 0;
        rs.forEach(function (r) { sp += r.spent; got += r.got; });
        $('prof-mini').innerHTML = 'All players since Beta: <b>' + tk('WAX', n(sp)) + '</b> spent on gems and signups \u00b7 <b>' + tk('WAX', n(got)) + '</b> earned back in TLM and WAX \u00b7 net <b class="' +
            (got - sp >= 0 ? 'pos' : 'neg') + '">' + (got - sp >= 0 ? '+' : '') + n(got - sp) + ' WAX</b>. Open the breakdown \u2192';
    }
    function paintBoard() {
        var rs = profitRows(), k = PF.sort;
        rs.sort(function (a, b) { return b[k] - a[k]; });
        var sortBtn = function (v, l) { return '<button class="' + (PF.sort === v ? 'on' : '') + '" data-psort="' + v + '">' + l + '</button>'; };
        $('prof-board').innerHTML = '<div class="feed-h"><b>Players</b><small>' + rs.length + ' with spend or earnings</small></div>' +
            '<div class="search" style="margin:10px 14px"><input id="prof-q" placeholder="Search a wallet or tag" value=""><button id="prof-go">Go</button></div>' +
            '<div class="periods" style="margin:0 14px 8px;display:inline-flex">' + sortBtn('net', 'Net') + sortBtn('netAll', 'Net + held') + sortBtn('spent', 'Spent') + sortBtn('got', 'Earned') + '</div>' +
            '<table><thead><tr><th class="rk">#</th><th>Player</th><th class="num">' + (k === 'spent' ? 'Spent' : k === 'got' ? 'Earned' : k === 'netAll' ? 'Net + held' : 'Net') + ' WAX</th></tr></thead><tbody>' +
            rs.slice(0, 200).map(function (r, i) {
                var v = r[k];
                return '<tr class="board-row' + (r.w === PF.sel ? ' sel' : '') + '" data-pw="' + esc(r.w) + '"><td class="rk">' + (i + 1) + '</td><td class="who">' + esc(r.tag || r.w) + (r.tag ? ' <small>' + esc(r.w) + '</small>' : '') + '</td>' +
                    '<td class="num ' + (/^net/.test(k) ? (v >= 0 ? 'pos' : 'neg') : '') + '">' + (/^net/.test(k) && v >= 0 ? '+' : '') + n(v) + '</td></tr>';
            }).join('') + '</tbody></table>';
        $('prof-board').querySelectorAll('[data-pw]').forEach(function (tr) { tr.onclick = function () { PF.sel = tr.getAttribute('data-pw'); paintBoard(); paintDetail(); }; });
        $('prof-board').querySelectorAll('[data-psort]').forEach(function (b) { b.onclick = function () { PF.sort = b.getAttribute('data-psort'); paintBoard(); }; });
        var go = function () {
            var q = ($('prof-q').value || '').trim().toLowerCase(); if (!q) return;
            var hit = (PF.players || []).find(function (p) { return p.wallet === q || (p.playertag || '').toLowerCase() === q; }) ||
                (PF.players || []).find(function (p) { return p.wallet.indexOf(q) >= 0 || (p.playertag || '').toLowerCase().indexOf(q) >= 0; });
            PF.sel = hit ? hit.wallet : q; paintBoard(); paintDetail();
        };
        $('prof-go').onclick = go; $('prof-q').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    }
    async function paintDetail() {
        var el = $('prof-main');
        var rs = profitRows(), r = rs.find(function (x) { return x.w === PF.sel; });
        if (!PF.sel || !r) {
            el.innerHTML = '<section class="card"><h2>Pick a player</h2><p class="sub">' + (PF.sel ? esc(PF.sel) + ' has no gem purchases or earnings on record. ' : '') +
                'Choose someone from the list, or search a wallet.</p></section>';
            return;
        }
        var roi = r.spent ? (r.got / r.spent * 100) : null;
        var packs = Object.keys(PACK).filter(function (k) { return r.packs[k]; }).map(function (k) {
            return '<span>' + r.packs[k] + '\u00d7 Gem Pack ' + k.charAt(0).toUpperCase() + k.slice(1) + ' <small style="color:var(--dim)">' + n(PACK[k][1]) + ' gems each \u00b7 paid ' + n(r.paid[k] || 0) + ' WAX in all (now ' + n(PACK[k][0]) + ' each)</small></span>';
        }).join('');
        var R = RATES || { gem: 0, credit: 0, energy: 0 }, ref = (SHARD.list || []).find(function (x) { return x.name === SHARD.ref; });
        var shardOpts = (SHARD.list || []).map(function (x) {
            return '<option value="' + esc(x.name) + '"' + (x.name === SHARD.ref ? ' selected' : '') + '>' + esc(x.combined
                ? 'Mythic average: ' + x.sales + ' recent sales across ' + x.items.length + ' Mythic item' + (x.items.length === 1 ? '' : 's')
                : x.name + ' (' + x.rarity + '): ' + n(x.shards) + ' shards, ~' + n(x.wax) + ' WAX') + '</option>';
        }).join('');
        var sgn = function (v) { return (v >= 0 ? '+' : '') + n(v); };
        el.innerHTML = '<section class="card"><h2>' + esc(r.tag || r.w) + ' <small>' + esc(r.w) + ' \u00b7 since Beta began, 1 Sept 2026</small></h2>' +
            '<div class="pl" style="margin-top:10px">' +
            '<div class="chip"><span>WAX spent</span><b>' + n(r.spent) + '</b></div>' +
            '<div class="chip"><span>Earned, in WAX</span><b>' + n(r.got) + '</b></div>' +
            '<div class="chip"><span>Net</span><b class="' + (r.net >= 0 ? 'pos' : 'neg') + '">' + sgn(r.net) + '</b></div>' +
            '<div class="chip"><span>Back per WAX spent</span><b>' + (roi == null ? '\u2013' : n(roi) + '%') + '</b></div>' +
            '<div class="chip"><span>Held in game \u2248 WAX</span><b>' + n(r.heldWax) + '</b></div>' +
            '<div class="chip"><span><img class="tk" src="Shards.png" alt="">Shards \u2248 WAX' + shardNote() + '</span><b>' + n(r.shWax) + '</b></div>' +
            '<div class="chip"><span>Net incl. held + shards</span><b class="' + (r.netAll >= 0 ? 'pos' : 'neg') + '">' + sgn(r.netAll) + '</b></div></div></section>' +
            '<section class="card"><h2>Where it went</h2><dl class="flow">' +
            '<dt>Gem packs</dt><dd>' + tk('WAX', n(r.gems)) + '</dd><dt>Signup</dt><dd>' + tk('WAX', n(r.signup)) + '</dd>' +
            (r.alphaWax ? '<dt>Alpha gems</dt><dd>' + n(r.alphaGems) + ' gems bought for ' + n(r.alphaWax) + ' WAX before Beta <small style="color:var(--dim)">credited again at Beta start, not counted as spend</small></dd>' : '') +
            '</dl>' + (packs ? '<div class="packs" style="margin-top:10px">' + packs + '</div>' : '') + '</section>' +
            '<section class="card"><h2>Held in the game now</h2><dl class="flow">' +
            '<dt>Gems</dt><dd>' + n(r.held.gems) + ' \u2248 ' + n(r.held.gems * R.gem) + ' WAX <small style="color:var(--dim)">at ' + n(R.gem, 4) + ' WAX a gem, the best gem pack</small></dd>' +
            '<dt>Credits</dt><dd>' + n(r.held.credits) + ' \u2248 ' + n(r.held.credits * R.credit) + ' WAX <small style="color:var(--dim)">at the gem price of the best credit pack</small></dd>' +
            '<dt>Energy</dt><dd>' + n(r.held.energy) + ' \u2248 ' + n(r.held.energy * R.energy) + ' WAX <small style="color:var(--dim)">at the credit price of the best energy pack</small></dd></dl>' +
            '<h3 style="margin:14px 0 6px;font-size:0.92em;color:var(--gold)">Where the credits came from</h3><dl class="flow">' +
            '<dt>Credits gained</dt><dd>' + n(r.credGained) + '</dd>' +
            '<dt>Farmed</dt><dd>' + n(r.credFarm) + ' <small style="color:var(--dim)">' + (r.credGained ? n(r.credFarm / r.credGained * 100) + '% \u00b7 ' : '') + 'from staking Alien Worlds NFTs in the farm</small></dd>' +
            '<dt>From gems</dt><dd>' + n(Math.max(0, r.credGained - r.credFarm)) + ' <small style="color:var(--dim)">converted with credit packs</small></dd></dl>' +
            '<p class="sub" style="margin:8px 0 0">Credits come only from farming (staking Alien Worlds NFTs) or from converting gems. Farmed credits cost no WAX, so their value here is what they would cost in gems, not what was paid. ' +
            'Energy is free each day (100, or 1,000 with a Legend pass' + (r.legendMonths ? ': this player has had ' + n(r.legendMonths) + ' Legend month' + (r.legendMonths === 1 ? '' : 's') : '') + ') or bought with credits.</p></section>' +
            '<section class="card"><h2>Boosting lands</h2><div id="prof-boost" class="sub">Reading boosts and land claims\u2026</div></section>' +
            '<section class="card"><h2>What came back</h2><dl class="flow">' +
            '<dt>TLM earned</dt><dd>' + tk('TLM', n(r.tlm, 2)) + ' \u2248 ' + tk('WAX', n(r.tlm * PF.tlmWax)) + '</dd>' +
            '<dt>WAX earned</dt><dd>' + tk('WAX', n(r.wax, 2)) + '</dd>' +
            '<dt>Shards earned</dt><dd>' + tk('SHARDS', n(r.sh)) + ' \u2248 ' + tk('WAX', n(r.shWax)) + shardNote() + ' <small style="color:var(--dim)">valued separately below, not in Earned</small></dd></dl>' +
            '<div style="margin-top:12px"><label class="sub" style="display:block;margin-bottom:4px">Value shards by what they redeem for in the Alien Worlds shard shop:</label>' +
            '<select id="prof-shref" style="background:var(--panel2);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit;max-width:100%">' + shardOpts + '</select>' +
            '<p class="sub" style="margin:6px 0 0">' + (ref ? '<b>' + tk('SHARDS', '100,000') + ' \u2248 ' + tk('WAX', n(ref.rate * 100000)) + '</b>' + shardNote() + (ref.combined ? ' (average of the last ' + ref.sales + ' Mythic sales: ' + esc(ref.items.join(', ')) + ')'
                : ' (' + esc(ref.name) + ': ' + n(ref.shards) + ' shards, average of its last ' + ref.sales + ' sales ~' + n(ref.wax) + ' WAX)') : 'No shard-shop prices available.') + '</p></div>' +
            '<div id="prof-log" class="sub" style="margin-top:12px">Reading recent rewards\u2026</div></section>' +
            '<section class="card"><h2>Alien Worlds NFTs minted to this wallet <small>not counted above</small></h2>' +
            '<p class="sub">Mints into the alien.worlds collection since Beta began (mining drops and shard-shop redemptions), valued at their last AtomicHub sale. Shine upgrades (Gold and above) are left out: they come from combining four NFTs, not from spending anything.</p><div id="prof-nfts" class="sub">Loading\u2026</div></section>';
        var w = r.w;
        var sel = $('prof-shref'); if (sel) sel.onchange = function () { SHARD.ref = sel.value; paintBoard(); paintDetail(); };
        loadBoost(w, R);
        // recent itemised rewards, by pool (rwrdlog.ale keeps the latest rows per player)
        try {
            var lg = await allRows('rwrdlog.ale', w, 'rewards'), by = {};
            lg.forEach(function (x) {
                var a = String(x.reward).split(' '), k = (x.pool_description || x.pool) + '|' + a[1];
                by[k] = by[k] || { d: x.pool_description || x.pool, sym: a[1], amt: 0, n: 0 }; by[k].amt += parseFloat(a[0]) || 0; by[k].n++;
            });
            var ks = Object.keys(by).sort(function (a, b) { return by[b].amt - by[a].amt; });
            if (PF.sel === w && $('prof-log')) $('prof-log').innerHTML = ks.length ? '<p class="sub" style="margin:0 0 6px">Recent rewards by source (ALE keeps the latest ' + lg.length + '):</p><table><tbody>' +
                ks.map(function (k) { return '<tr><td>' + esc(by[k].d) + '</td><td class="num">' + by[k].n + '\u00d7</td><td class="num">' + tk(by[k].sym, '<b>' + n(by[k].amt, 2) + '</b>') + '</td></tr>'; }).join('') + '</tbody></table>'
                : 'No itemised rewards on record.';
        } catch (e) { if ($('prof-log')) $('prof-log').textContent = 'Recent rewards unavailable.'; }
        // AW NFT mints
        try {
            var acts = [], before = '';
            for (var i = 0; i < 5; i++) {
                var j = await hist('/v2/history/get_actions?account=' + w + '&filter=atomicassets:logmint&limit=100&sort=desc' + (before ? '&before=' + before : ''));
                var a2 = j.actions || [];
                acts = acts.concat(a2.filter(function (x) { return x.act.data.collection_name === 'alien.worlds' && x.act.data.authorized_minter !== 's.federation' && utcMs(x['@timestamp']) >= BETA; }));
                if (a2.length && utcMs(a2[a2.length - 1]['@timestamp']) < BETA) break;
                if (a2.length < 100) break;
                before = a2[a2.length - 1]['@timestamp'];
            }
            var tp = {};
            acts.forEach(function (x) { var t2 = x.act.data.template_id; tp[t2] = (tp[t2] || 0) + 1; });
            var ids = Object.keys(tp), info = {}, est = 0;
            if (ids.length) {
                var tr = await fetch('https://wax.api.atomicassets.io/atomicassets/v1/templates?collection_name=alien.worlds&ids=' + ids.join(',') + '&limit=100');
                ((await tr.json()).data || []).forEach(function (t3) { info[t3.template_id] = { name: t3.immutable_data.name, img: t3.immutable_data.img, shine: t3.immutable_data.shine }; });
                // anything above Stone is a shine upgrade, whoever minted it
                ids = ids.filter(function (t6) { var sh = (info[t6] || {}).shine; if (sh && sh !== 'Stone') { acts = acts.filter(function (x) { return String(x.act.data.template_id) !== String(t6); }); delete tp[t6]; return false; } return true; });
                for (var k2 = 0; k2 < ids.length && k2 < 40; k2++) {
                    try {
                        var sr = await fetch('https://wax.api.atomicassets.io/atomicmarket/v1/sales?state=3&collection_name=alien.worlds&template_id=' + ids[k2] + '&sort=updated&order=desc&limit=1');
                        var sd = ((await sr.json()).data || [])[0];
                        if (sd && sd.price.token_symbol === 'WAX') { info[ids[k2]] = info[ids[k2]] || {}; info[ids[k2]].wax = Number(sd.price.amount) / Math.pow(10, sd.price.token_precision); }
                    } catch (e) {}
                }
            }
            ids.forEach(function (t4) { if (info[t4] && info[t4].wax) est += info[t4].wax * tp[t4]; });
            if (PF.sel === w && $('prof-nfts')) $('prof-nfts').innerHTML = ids.length ? '<p style="margin:0 0 8px">' + acts.length + ' minted \u00b7 ~est. ' + n(est) + ' WAX at last sale</p><div class="nfts">' +
                ids.sort(function (a, b) { return tp[b] - tp[a]; }).map(function (t5) {
                    var x = info[t5] || {};
                    return '<div class="nft"><img loading="lazy" alt="" src="https://wsrv.nl/?url=ipfs.alienworlds.io/ipfs/' + esc(x.img || '') + '&w=200&output=webp">' +
                        esc(tp[t5] + '\u00d7 ' + (x.name || '#' + t5)) + (x.wax ? '<br>~' + n(x.wax, 2) + ' WAX' : '') + '</div>';
                }).join('') + '</div>' : 'No Alien Worlds NFTs minted to this wallet in its recent history.';
        } catch (e) { if ($('prof-nfts')) $('prof-nfts').textContent = 'NFT history unavailable.'; }
    }
    async function loadBoost(w, R) {
        var out = $('prof-boost');
        try {
            var list = async function (filter) {
                var acts = [], before = '', seen = {};
                for (var i = 0; i < 40; i++) {
                    var j = await hist('/v2/history/get_actions?account=' + w + '&filter=' + filter + '&limit=100&sort=desc&after=' + new Date(BETA).toISOString() + (before ? '&before=' + before : ''));
                    var a = (j.actions || []).filter(function (x) { if (seen[x.global_sequence]) return false; seen[x.global_sequence] = 1; return true; });
                    acts = acts.concat(a);
                    if ((j.actions || []).length < 100 || !a.length) break;
                    before = new Date(utcMs(a[a.length - 1]['@timestamp']) + 1000).toISOString();
                }
                return acts;
            };
            var boosts = (await list('lands.ale:boost')).filter(function (x) { return x.act.data.wallet === w; });
            var cr = 0, gm = 0;
            boosts.forEach(function (x) { cr += Number(x.act.data.cost_credits) || 0; gm += Number(x.act.data.cost_gems) || 0; });
            var spentWax = cr * R.credit + gm * R.gem;
            if (PF.sel !== w || !$('prof-boost')) return;
            out.innerHTML = '<dl class="flow"><dt>Boosts</dt><dd>' + n(boosts.length) + '</dd><dt>Spent</dt><dd>' + n(cr) + ' credits' + (gm ? ' + ' + n(gm) + ' gems' : '') +
                ' \u2248 <b>' + n(spentWax) + ' WAX</b></dd><dt>Land claims</dt><dd>reading\u2026</dd></dl>';
            var claims = await list('lands.ale:claimlndrwrd'), ids = {}, tlm = 0;
            claims.forEach(function (x) { if (x.act.data.wallet === w) ids[x.trx_id] = 1; });
            var tx = Object.keys(ids).slice(0, 200);
            for (var i = 0; i < tx.length; i++) {
                try {
                    var t = await hist('/v2/history/get_transaction?id=' + tx[i]), seen = {};
                    (t.actions || []).forEach(function (a) {
                        if (seen[a.global_sequence]) return; seen[a.global_sequence] = 1;
                        var d = a.act.data || {};
                        if (a.act.name === 'transfer' && d.from === 'lands.ale' && d.to === w && /^Land reward claimed/.test(d.memo || '')) tlm += parseFloat(d.quantity) || 0;
                    });
                } catch (e) {}
                if (PF.sel === w && $('prof-boost') && i % 5 === 0) $('prof-boost').querySelector('dd:last-child').textContent = 'reading\u2026 ' + (i + 1) + ' / ' + tx.length;
            }
            if (PF.sel !== w || !$('prof-boost')) return;
            var back = tlm * PF.tlmWax;
            out.innerHTML = '<dl class="flow"><dt>Boosts</dt><dd>' + n(boosts.length) + ' since Beta</dd>' +
                '<dt>Spent</dt><dd>' + n(cr) + ' credits' + (gm ? ' + ' + n(gm) + ' gems' : '') + ' \u2248 <b>' + n(spentWax) + ' WAX</b></dd>' +
                '<dt>Land rewards claimed</dt><dd>' + tk('TLM', n(tlm, 2)) + ' \u2248 <b>' + tk('WAX', n(back)) + '</b></dd>' +
                '<dt>Earned back</dt><dd><b class="' + (back >= spentWax ? 'pos' : 'neg') + '">' + (spentWax ? n(back / spentWax * 100) + '%' : '\u2013') + '</b> of the boost spend, in TLM claimed</dd></dl>' +
                '<p class="sub" style="margin:8px 0 0">Boosts are paid in credits (sometimes gems). Credits come from farming Alien Worlds NFTs or from gems, so the WAX figure is their gem price; for a player who farms most of their credits, the WAX actually paid is lower. ' +
                'Owners also get shards on every visit to their buildings; those are in Shards earned and the recent-rewards list as Landowner Rewards. TLM still waiting in buildings isn\u2019t counted until it\u2019s claimed.</p>';
        } catch (e) { if (PF.sel === w && out) out.textContent = 'Boost history unavailable right now.'; }
    }
    function setTab(t) {
        document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); });
        document.querySelectorAll('[data-panel]').forEach(function (p2) { p2.hidden = p2.getAttribute('data-panel') !== t; });
        if (t === 'profit') openProfit(); else render();
    }
    document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { setTab(b.getAttribute('data-tab')); }; });
    $('prof-teaser').onclick = function () { setTab('profit'); };

    /* ── start ── */
    async function boot(force) {
        try { await loadFights(force); } catch (e) { status('Could not load the fight log: ' + esc(e.message)); return; }
        render();
    }
    paintTaverns();
    loadTaverns().then(function () { if (H.fights) render(); });
    setInterval(function () { if (!document.hidden) loadTaverns(); }, 60000);
    boot(false);
    Promise.all([loadPlayers(), loadTlmPrice(), loadSpend()]).then(paintTeaser).catch(function () {});
})();
