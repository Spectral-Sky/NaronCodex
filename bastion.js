/* Bastion tab of the PD hub (miss.pdef.html): the Planetary Defense Discord bot,
   read from its public API (https://bastion.planetarydefense.io/developers).
   GET only, no key, open CORS, 60 requests a minute per IP.

   Activity comes from the feed, the only history the API exposes: it lists notable
   events (achievements, loot, altar buys, grades, world-boss steps), not every bot
   command, so "players" here means players who appeared in the feed. The feed is read
   back about three days on first open and kept in this browser, so later visits only
   fetch what's new and the history grows to two weeks. */
(function () {
    var API = 'https://bastion.planetarydefense.io/api/public/v1';
    var CACHE = 'bastion_feed_v1';
    var WANT_MS = 3 * 86400000, KEEP_MS = 14 * 86400000, GAP_MS = 1050, MAX_PAGES = 90;
    var B = { events: [], loading: false, pages: 0, err: '', boards: null, board: 'missions', rows: {}, boardErr: '', started: false };

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function n(x, d) { return Number(x).toLocaleString('en', { maximumFractionDigits: d == null ? 0 : d }); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    // Discord emoji in names come as <:name:id> / <a:name:id>
    function nameHtml(s) {
        return esc(s).replace(/&lt;(a?):(\w+):(\d+)&gt;/g, function (m, a, nm, id) {
            return '<img class="bas-emoji" alt=":' + nm + ':" title=":' + nm + ':" src="https://cdn.discordapp.com/emojis/' + id + '.webp?size=32' + (a ? '&animated=true' : '') + '">';
        });
    }

    var lastAt = 0;
    async function get(path) {
        for (var k = 0; k < 4; k++) {
            var wait = lastAt + GAP_MS - Date.now();
            if (wait > 0) await sleep(wait);
            lastAt = Date.now();
            var r = await fetch(API + path, { signal: AbortSignal.timeout(15000) });
            if (r.status === 429) { await sleep((Number(r.headers.get('Retry-After')) || 10) * 1000); continue; }
            if (!r.ok) throw new Error('Bastion API ' + r.status);
            return r.json();
        }
        throw new Error('Bastion API is rate-limiting; try again in a minute');
    }

    /* ── feed, cached per browser as [id, playerId, kind, createdAt] ── */
    function loadCache() {
        try { var a = JSON.parse(localStorage.getItem(CACHE) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
    }
    function saveCache() {
        try { localStorage.setItem(CACHE, JSON.stringify(B.events)); } catch (e) {}
    }
    function merge(list) {
        var seen = {};
        B.events.forEach(function (e) { seen[e[0]] = 1; });
        list.forEach(function (e) { if (!seen[e.id]) { seen[e.id] = 1; B.events.push([e.id, e.playerId, e.kind, e.createdAt]); } });
        B.events.sort(function (a, b) { return b[0] - a[0]; });
        var cut = Date.now() - KEEP_MS;
        B.events = B.events.filter(function (e) { return e[3] >= cut; });
    }
    async function readFeed() {
        if (B.loading) return;
        B.loading = true; B.err = ''; B.pages = 0; paintActivity();
        try {
            B.events = loadCache();
            var top = B.events.length ? B.events[0][0] : 0;
            // newest first, until the cached part is reached
            var before = '';
            for (var i = 0; i < MAX_PAGES; i++) {
                var j = await get('/feed?limit=40' + (before ? '&before=' + before : ''));
                var ev = j.events || [];
                B.pages++;
                merge(ev);
                saveCache();
                paintActivity();
                if (!ev.length) break;
                var tail = ev[ev.length - 1];
                if (top ? tail.id <= top : tail.createdAt <= Date.now() - WANT_MS) break;
                before = ev[ev.length - 1].id;
            }
            // then further back, until three days are covered
            for (var p = 0; p < MAX_PAGES && B.events.length; p++) {
                var oldest = B.events[B.events.length - 1];
                if (oldest[3] <= Date.now() - WANT_MS) break;
                var jj = await get('/feed?limit=40&before=' + oldest[0]);
                var ev2 = jj.events || [];
                B.pages++;
                if (!ev2.length) break;
                merge(ev2);
                saveCache();
                paintActivity();
            }
            saveCache();
        } catch (e) { B.err = e.message; }
        B.loading = false;
        paintActivity();
    }

    /* ── daily activity (UTC days) ── */
    function days() {
        if (!B.events.length) return [];
        var by = {}, from = B.events[B.events.length - 1][3];
        B.events.forEach(function (e) {
            var d = new Date(e[3]).toISOString().slice(0, 10);
            var x = by[d] || (by[d] = { day: d, events: 0, players: {}, loot: 0, altar: 0 });
            x.events++; x.players[e[1]] = (x.players[e[1]] || 0) + 1;
            if (e[2] === 'loot') x.loot++;
            if (e[2] === 'altar_purchase') x.altar++;
        });
        var today = new Date().toISOString().slice(0, 10);
        return Object.keys(by).sort().map(function (d) {
            var x = by[d], np = Object.keys(x.players).length;
            x.np = np; x.avg = np ? x.events / np : 0;
            x.partial = Date.parse(d + 'T00:00:00Z') < from;          // the feed we hold starts mid-day
            x.today = d === today;
            return x;
        });
    }
    function dayLabel(d) { return new Date(d + 'T00:00:00Z').toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }

    function chartSvg(list) {
        var W = 640, H = 180, padL = 36, padB = 26, padT = 18, gap = 2;
        var max = Math.max.apply(null, list.map(function (x) { return x.np; }).concat([1]));
        var step = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / step) * step;
        if (top / step <= 2) step /= 2;
        var bw = (W - padL - 8) / list.length;
        var y = function (v) { return padT + (H - padT - padB) * (1 - v / top); };
        var grid = '';
        for (var v = 0; v <= top + 1e-9; v += step)
            grid += '<line x1="' + padL + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" class="bas-grid"/>' +
                '<text x="' + (padL - 6) + '" y="' + (y(v) + 4) + '" class="bas-ax" text-anchor="end">' + n(v) + '</text>';
        var bars = list.map(function (x, i) {
            var w = Math.max(2, Math.min(44, bw - gap * 2)), x0 = padL + i * bw + (bw - w) / 2, y0 = y(x.np), h = H - padB - y0, r = Math.min(4, w / 2, h);
            // 4px rounded top, square on the baseline
            var path = 'M' + x0 + ',' + (H - padB) + 'V' + (y0 + r) + 'Q' + x0 + ',' + y0 + ' ' + (x0 + r) + ',' + y0 +
                'H' + (x0 + w - r) + 'Q' + (x0 + w) + ',' + y0 + ' ' + (x0 + w) + ',' + (y0 + r) + 'V' + (H - padB) + 'Z';
            var lbl = list.length <= 8 || i === list.length - 1 || i % Math.ceil(list.length / 8) === 0;
            return '<g class="bas-bar' + (x.partial || x.today ? ' bas-part' : '') + '" data-i="' + i + '">' +
                '<rect x="' + (x0 - gap) + '" y="' + padT + '" width="' + (bw) + '" height="' + (H - padT) + '" class="bas-hit"/>' +
                (x.np ? '<path d="' + path + '"/>' : '') +
                (lbl ? '<text x="' + (x0 + w / 2) + '" y="' + (H - 8) + '" class="bas-ax" text-anchor="middle">' + dayLabel(x.day) + '</text>' : '') + '</g>';
        }).join('');
        var last = list[list.length - 1];
        var endLbl = last ? '<text x="' + (padL + (list.length - 1) * bw + bw / 2) + '" y="' + (y(last.np) - 6) + '" class="bas-val" text-anchor="middle">' + n(last.np) + '</text>' : '';
        return '<svg class="bas-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Players in the feed per day">' + grid + bars + endLbl + '</svg>';
    }

    function paintActivity() {
        var el = document.getElementById('bas-activity');
        if (!el) return;
        var list = days(), h = '';
        var cut24 = Date.now() - 86400000, p24 = {}, e24 = 0;
        B.events.forEach(function (e) { if (e[3] >= cut24) { p24[e[1]] = 1; e24++; } });
        var np24 = Object.keys(p24).length;
        var full = list.filter(function (x) { return !x.partial && !x.today; });
        var avgDay = full.length ? full.reduce(function (s, x) { return s + x.np; }, 0) / full.length : null;
        h += '<div class="pdd-chips">' +
            '<div class="pdd-chip"><span>Players, last 24 h</span><b>' + (B.events.length ? n(np24) : '–') + '</b></div>' +
            '<div class="pdd-chip"><span>Feed events, last 24 h</span><b>' + (B.events.length ? n(e24) : '–') + '</b></div>' +
            '<div class="pdd-chip"><span>Events per player, 24 h</span><b>' + (np24 ? n(e24 / np24, 1) : '–') + '</b></div>' +
            '<div class="pdd-chip"><span>Average players per full day</span><b>' + (avgDay != null ? n(avgDay) : '–') + '</b></div></div>';
        if (B.loading) h += '<p class="pdd-hint">Reading the Bastion feed… ' + B.pages + ' page' + (B.pages === 1 ? '' : 's') +
            (B.events.length ? ', back to ' + new Date(B.events[B.events.length - 1][3]).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '') + '</p>';
        if (B.err) h += '<div class="pdd-msg bad">' + esc(B.err) + '</div>';
        if (list.length) {
            h += '<div class="bas-chartwrap"><div class="bas-charth">Players in the feed per day <small>UTC days · lighter bars are partial days</small></div>' +
                chartSvg(list) + '<div class="bas-tip" id="bas-tip" hidden></div></div>';
            h += '<div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="txt">Day (UTC)</th><th class="num">Players</th><th class="num">Feed events</th>' +
                '<th class="num">Events per player</th><th class="num">Loot drops</th><th class="num">Altar buys</th></tr></thead><tbody>' +
                list.slice().reverse().map(function (x) {
                    return '<tr><td class="txt">' + dayLabel(x.day) + (x.today ? ' <small>so far</small>' : x.partial ? ' <small>partial</small>' : '') + '</td>' +
                        '<td class="num">' + n(x.np) + '</td><td class="num">' + n(x.events) + '</td><td class="num">' + n(x.avg, 1) + '</td>' +
                        '<td class="num">' + n(x.loot) + '</td><td class="num">' + n(x.altar) + '</td></tr>';
                }).join('') + '</tbody></table></div>';
        }
        h += '<p class="pdd-note">Counted from the Bastion feed, which lists notable events (achievements, loot, altar buys, grade-ups, world-boss steps) rather than every bot command, ' +
            'so these measure feed activity, not exact command counts. The feed is kept in this browser for up to 14 days, so history grows with each visit. ' +
            '<button class="pdd-btn pdd-sm" id="bas-refresh"' + (B.loading ? ' disabled' : '') + '>Refresh</button></p>';
        el.innerHTML = h;
        var rf = document.getElementById('bas-refresh'); if (rf) rf.onclick = readFeed;
        bindChart(list);
    }
    function bindChart(list) {
        var svg = document.querySelector('#bas-activity .bas-chart'), tip = document.getElementById('bas-tip');
        if (!svg || !tip) return;
        svg.querySelectorAll('.bas-bar').forEach(function (g) {
            g.onmouseenter = function () {
                var x = list[Number(g.getAttribute('data-i'))], r = g.getBoundingClientRect(), w = svg.parentNode.getBoundingClientRect();
                tip.innerHTML = '<b>' + dayLabel(x.day) + '</b>' + (x.today ? ' (so far)' : x.partial ? ' (partial)' : '') +
                    '<br>' + n(x.np) + ' players · ' + n(x.events) + ' events<br>' + n(x.avg, 1) + ' events per player';
                tip.hidden = false;
                tip.style.left = Math.min(w.width - 170, Math.max(0, r.left - w.left + r.width / 2 - 85)) + 'px';
                tip.style.top = Math.max(0, r.top - w.top - 8) + 'px';
                g.classList.add('on');
            };
            g.onmouseleave = function () { tip.hidden = true; g.classList.remove('on'); };
        });
    }

    /* ── leaderboards ── */
    async function loadBoards() {
        try {
            var j = await get('/leaderboards');
            B.boards = j.leaderboards || [];
            if (!B.boards.some(function (b) { return b.kind === B.board; }) && B.boards[0]) B.board = B.boards[0].kind;
        } catch (e) { B.boardErr = e.message; }
        paintBoards();
        showBoard(B.board);
    }
    async function showBoard(kind) {
        B.board = kind; B.boardErr = ''; paintBoards();
        var c = B.rows[kind];
        if (c && Date.now() - c.at < 30000) return;
        try { var j = await get('/leaderboards/' + encodeURIComponent(kind)); B.rows[kind] = { at: Date.now(), rows: j.rows || [], what: j.what }; }
        catch (e) { B.boardErr = e.message; }
        if (B.board === kind) paintBoards();
    }
    function paintBoards() {
        var el = document.getElementById('bas-boards');
        if (!el) return;
        var h = '';
        if (B.boards) h += '<div class="pdd-cats">' + B.boards.map(function (b) {
            return '<button class="pdd-segb' + (b.kind === B.board ? ' on' : '') + '" data-bboard="' + esc(b.kind) + '" title="' + esc(b.what) + '">' +
                esc(b.kind.charAt(0).toUpperCase() + b.kind.slice(1)) + '</button>';
        }).join('') + '</div>';
        if (B.boardErr) h += '<div class="pdd-msg bad">' + esc(B.boardErr) + '</div>';
        var c = B.rows[B.board];
        if (!c) h += '<p class="pdd-hint">Loading…</p>';
        else h += '<p class="pdd-hint">' + esc(c.what || '') + '</p><div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="num">#</th><th class="txt">Player</th>' +
            '<th class="txt">Grade</th><th class="num">' + esc(B.board.charAt(0).toUpperCase() + B.board.slice(1)) + '</th></tr></thead><tbody>' +
            c.rows.map(function (r) {
                return '<tr><td class="num">' + r.rank + '</td><td class="txt bas-name">' + nameHtml(r.name) + '</td><td class="txt">' + esc(r.grade || '') + '</td>' +
                    '<td class="num">' + n(r.value) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        el.innerHTML = h;
        el.querySelectorAll('[data-bboard]').forEach(function (b) { b.onclick = function () { showBoard(b.getAttribute('data-bboard')); }; });
    }

    window.bastionOpen = function () {
        var root = document.getElementById('bastion');
        if (!root) return;
        if (!B.started) {
            B.started = true;
            root.innerHTML = '<div class="panel-h"><h2>Bastion</h2><p>The Planetary Defense Discord bot. Data from the public ' +
                '<a href="https://bastion.planetarydefense.io/developers" target="_blank" rel="noopener">Bastion API</a>; Naron Codex is a community tool, not an official Bastion one.</p></div>' +
                '<div class="bas-body"><section><h3 class="bas-h">Activity</h3><div id="bas-activity"></div></section>' +
                '<section><h3 class="bas-h">Leaderboards <small>top 15</small></h3><div id="bas-boards"></div></section></div>';
            B.events = loadCache();
            paintActivity();
            paintBoards();
            loadBoards().then(readFeed);
        }
    };
})();
