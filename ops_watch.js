/* ── AUTOMATION WATCH ─────────────────────────────────────────────────────────
   Loaded by ops.html only after its owner check. Reads dungeon, arena and quest
   actions from chain history and measures, per wallet, the things a person on a
   phone can't do: fights closer than ~15 s apart, several different locations in
   one minute, fights signed together in one transaction, play with no breaks.

   Every hour of history is checked against the node's own total before it's used.
   A node that answers short is skipped for the next one, never accepted.

   Caveat shown on the page too: Naron Codex's own Dungeon Run queue fires fights
   back to back, so speed alone is a reason to look closer, not proof. */
(function () {
    'use strict';

    var OWNER = '1x1ci.wam';
    var who = '';
    try { who = localStorage.getItem('naron_wallet') || ''; } catch (e) {}
    if (who !== OWNER) return;

    // eosdac and detroitledger accept 100 rows a request, waxsweden and eosusa 1,000; the
    // size is learned from the node's own error. A node that refuses a connection is
    // skipped for the rest of the visit instead of being retried for every hour.
    var NODES = ['https://wax-history.eosdac.io', 'https://history.waxsweden.org',
                 'https://hyperion.wax.detroitledger.tech', 'https://wax.eosusa.io'];
    var PAGE = {}, DEAD = {};
    var FILTER = 'dungeons.ale:playdungeon,arena.ale:playarena,quests.ale:finishquest';
    var HUMAN_GAP_S = 15;          // fastest a person manages on a phone
    var SESSION_BREAK_S = 300;     // a gap this long ends a session
    var HOUR = 3600e3;

    var _hours = 24, _data = null, _sort = 'score', _open = null, _busy = false;

    function iso(ms) { return new Date(ms).toISOString().slice(0, 19); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // all fights and quests in [a, b), complete or throws
    async function hourActs(a, b) {
        for (var n = 0; n < NODES.length; n++) {
            var node = NODES[n];
            if (DEAD[node]) continue;
            var refused = 0;
            for (var attempt = 0; attempt < 3; attempt++) {
                try {
                    var out = [], seen = {}, total = null;
                    for (var p = 0; p < 100; p++) {
                        var lim = PAGE[node] || 1000;
                        var r = await fetch(node + '/v2/history/get_actions?filter=' + FILTER +
                            '&after=' + iso(a) + '&before=' + iso(b) + '&limit=' + lim + '&sort=asc&skip=' + (p * lim) +
                            (p ? '' : '&track=true'), { signal: AbortSignal.timeout(20000) });
                        if (!r.ok) {
                            var m = /maximum:\s*(\d+)/.exec(await r.text());
                            if (m && !PAGE[node]) { PAGE[node] = Number(m[1]); p = -1; out = []; seen = {}; continue; }
                            throw new Error('HTTP ' + r.status);
                        }
                        var j = await r.json();
                        if (!p) total = j.total ? Number(j.total.value) : null;
                        (j.actions || []).forEach(function (x) {
                            if (!seen[x.global_sequence]) { seen[x.global_sequence] = 1; out.push(x); }
                        });
                        if ((j.actions || []).length < lim || out.length >= total) break;
                    }
                    if (total !== null && out.length >= total) return out;
                } catch (e) {
                    if (e.name === 'TypeError' && ++refused >= 2) { DEAD[node] = 1; break; }   // connection refused
                }
                await sleep(500 * (attempt + 1));
            }
        }
        throw new Error('no node returned a complete read for ' + iso(a));
    }

    async function scan(hours, progress) {
        var end = Math.floor(Date.now() / 60000) * 60000 - 2 * 60000;   // let nodes catch up
        var slices = [];
        for (var t = end - hours * HOUR; t < end; t += HOUR) slices.push([t, Math.min(end, t + HOUR)]);
        var acts = [], done = 0, next = 0;
        async function worker() {
            while (next < slices.length) {
                var s = slices[next++];
                var got = await hourActs(s[0], s[1]);
                acts = acts.concat(got);
                progress(++done, slices.length);
            }
        }
        await Promise.all([worker(), worker(), worker()]);   // three at a time keeps the nodes happy
        return { acts: acts, from: end - hours * HOUR, to: end };
    }

    function analyse(raw) {
        var by = {};
        raw.acts.forEach(function (a) {
            var auth = (a.act.authorization || [])[0] || {};
            var w = auth.actor;
            if (!w) return;
            var d = a.act.data || {};
            var e = by[w] || (by[w] = { wallet: w, fights: [], quests: 0 });
            if (a.act.name === 'finishquest') { e.quests++; return; }
            e.fights.push({
                t: Date.parse(a['@timestamp'] + 'Z'), kind: a.act.name === 'playarena' ? 'arena' : 'dungeon',
                loc: (d.planet || '?') + '/' + (d.land_id || '?'), trx: a.trx_id, diff: d.difficulty || ''
            });
        });
        var days = (raw.to - raw.from) / 86400e3;
        return Object.keys(by).map(function (w) {
            var e = by[w], L = e.fights.sort(function (x, y) { return x.t - y.t; });
            var burst = 0, locs = 0, fast = 0, j = 0, sess = 0, sessStart = L.length ? L[0].t : 0, hours = {};
            var gaps = [];
            for (var i = 0; i < L.length; i++) {
                while (L[i].t - L[j].t >= 60000) j++;
                burst = Math.max(burst, i - j + 1);
                var ls = {};
                for (var k = j; k <= i; k++) ls[L[k].loc] = 1;
                locs = Math.max(locs, Object.keys(ls).length);
                hours[Math.floor(L[i].t / HOUR)] = 1;
                if (i) {
                    var g = (L[i].t - L[i - 1].t) / 1000;
                    // a quick retry at the same arena or dungeon is just a skipped
                    // animation; only a fast move to somewhere new is out of reach
                    if (L[i].loc !== L[i - 1].loc) {
                        gaps.push(g);
                        if (g < HUMAN_GAP_S) fast++;
                    }
                    if (g >= SESSION_BREAK_S) sessStart = L[i].t;
                }
                sess = Math.max(sess, L[i].t - sessStart);
            }
            var trx = {};
            L.forEach(function (f) { trx[f.trx] = (trx[f.trx] || 0) + 1; });
            var batched = Object.keys(trx).reduce(function (s, k) { return s + (trx[k] > 1 ? trx[k] : 0); }, 0);
            gaps.sort(function (a, b) { return a - b; });
            var r = {
                wallet: w, fights: L.length, quests: e.quests, burst: burst, locs: locs,
                moves: gaps.length, fast: fast, fastPct: gaps.length ? fast / gaps.length * 100 : 0,
                medGap: gaps.length ? gaps[gaps.length >> 1] : null,
                batched: batched, hoursPerDay: Object.keys(hours).length / days,
                session: sess / HOUR, timeline: L
            };
            r.flags = [];
            if (r.batched) r.flags.push(['BATCH', 'fights signed together in one transaction']);
            if (r.locs >= 4) r.flags.push(['BURST', r.locs + ' different locations inside one minute']);
            if (gaps.length >= 15 && r.fastPct >= 25)
                r.flags.push(['FAST', Math.round(r.fastPct) + '% of moves to a new location under ' + HUMAN_GAP_S + ' s']);
            if (r.session >= 6) r.flags.push(['MARATHON', r.session.toFixed(1) + ' h without a 5-minute break']);
            if (r.hoursPerDay >= 18) r.flags.push(['24/7', r.hoursPerDay.toFixed(1) + ' active hours a day']);
            r.score = r.flags.length * 1000 + r.locs * 50 + r.fastPct;   // fights/min left out: same-spot retries inflate it
            return r;
        });
    }

    var COLS = [
        ['wallet', 'Wallet', 'txt'], ['flags', 'Flags', 'txt'], ['fights', 'Fights', 'num'],
        ['quests', 'Quests', 'num'], ['burst', 'Fights / min', 'num'], ['locs', 'Locations / min', 'num'],
        ['fastPct', 'Moves < 15 s', 'num'], ['medGap', 'Median move', 'num'], ['batched', 'Same trx', 'num'],
        ['hoursPerDay', 'Hours / day', 'num'], ['session', 'Longest session', 'num']
    ];

    function cell(r, k) {
        if (k === 'wallet') return esc(r.wallet);
        if (k === 'flags') return r.flags.map(function (f) {
            return '<span class="aw-flag aw-' + f[0].replace('/', '') + '" title="' + esc(f[1]) + '">' + f[0] + '</span>';
        }).join(' ') || '<span class="aw-none">&ndash;</span>';
        if (k === 'fastPct') return r.moves ? Math.round(r.fastPct) + '% <small>(' + r.fast + ' of ' + r.moves + ')</small>' : '&ndash;';
        if (k === 'medGap') return r.medGap == null ? '&ndash;' : (r.medGap < 120 ? Math.round(r.medGap) + ' s' : (r.medGap / 60).toFixed(1) + ' min');
        if (k === 'hoursPerDay') return r.hoursPerDay.toFixed(1);
        if (k === 'session') return r.session.toFixed(1) + ' h';
        return String(r[k]);
    }

    function render() {
        var el = document.getElementById('watch');
        if (!_data) return;
        var rows = _data.rows.slice().sort(function (a, b) {
            if (_sort === 'wallet') return a.wallet.localeCompare(b.wallet);
            if (_sort === 'flags') return b.flags.length - a.flags.length || b.score - a.score;
            if (_sort === 'medGap') return (a.medGap == null ? 1e9 : a.medGap) - (b.medGap == null ? 1e9 : b.medGap);
            return (b[_sort] || 0) - (a[_sort] || 0);
        });
        var flagged = rows.filter(function (r) { return r.flags.length; }).length;
        var fights = rows.reduce(function (s, r) { return s + r.fights; }, 0);

        var h = controls() +
            '<div class="tiles">' +
              tileH('Players seen', rows.length, iso(_data.from).slice(5, 16).replace('T', ' ') + ' → ' +
                    iso(_data.to).slice(5, 16).replace('T', ' ') + ' UTC') +
              tileH('Fights', fights.toLocaleString(), 'dungeons and arenas') +
              tileH('Flagged', flagged, 'at least one signal below') +
            '</div>' +
            '<p class="note">A phone manages about one fight per ' + HUMAN_GAP_S + ' s. Flags: ' +
            '<b>BATCH</b> fights signed in one transaction &middot; <b>BURST</b> 4+ locations in a minute &middot; ' +
            '<b>FAST</b> a quarter or more of moves to a new location under ' + HUMAN_GAP_S + ' s &middot; <b>MARATHON</b> 6 h+ with no ' +
            '5-minute break &middot; <b>24/7</b> 18+ active hours a day. Quick retries at the same arena or dungeon ' +
            'are ignored (the animation can be skipped); only moves to a new location are timed. Naron Codex&rsquo;s own Dungeon Run queue ' +
            'fires fights back to back, so speed alone is a reason to look closer, not proof. ' +
            'Click a wallet for its fight-by-fight timeline.</p>' +
            '<div class="aw-wrap"><table class="aw-table"><thead><tr>' +
            COLS.map(function (c) {
                return '<th class="' + c[2] + (c[0] === _sort ? ' aw-sorted' : '') + '" data-k="' + c[0] + '">' + c[1] + '</th>';
            }).join('') + '</tr></thead><tbody>' +
            rows.map(function (r) {
                var tr = '<tr class="aw-row' + (r.flags.length ? ' aw-hot' : '') + (r.wallet === OWNER ? ' aw-me' : '') +
                    '" data-w="' + esc(r.wallet) + '">' +
                    COLS.map(function (c) { return '<td class="' + c[2] + '">' + cell(r, c[0]) + '</td>'; }).join('') + '</tr>';
                if (_open === r.wallet) tr += '<tr class="aw-detail"><td colspan="' + COLS.length + '">' + timeline(r) + '</td></tr>';
                return tr;
            }).join('') + '</tbody></table></div>' +
            '<p class="note">Read from chain history, each hour checked against the node&rsquo;s own total.</p>';
        el.innerHTML = h;

        el.querySelectorAll('th[data-k]').forEach(function (th) {
            th.onclick = function () { _sort = th.getAttribute('data-k'); render(); };
        });
        el.querySelectorAll('tr.aw-row').forEach(function (tr) {
            tr.onclick = function () { var w = tr.getAttribute('data-w'); _open = _open === w ? null : w; render(); };
        });
        bindControls();
    }

    // newest 60 fights, with the gap to the previous one coloured by how humanly possible it is
    function timeline(r) {
        var L = r.timeline, start = Math.max(0, L.length - 60);
        var trxCount = {};
        L.forEach(function (f) { trxCount[f.trx] = (trxCount[f.trx] || 0) + 1; });
        var rows = [];
        for (var i = L.length - 1; i >= start; i--) {
            var f = L[i], g = i ? (f.t - L[i - 1].t) / 1000 : null;
            var same = i && f.loc === L[i - 1].loc;
            var cls = g == null ? '' : same ? 'aw-g-same' : g < HUMAN_GAP_S ? 'aw-g-bad' : g < 30 ? 'aw-g-warn' : '';
            rows.push('<tr><td class="txt">' + iso(f.t).replace('T', ' ') + '.' + String(f.t % 1000).padStart(3, '0').slice(0, 1) +
                '</td><td class="txt">' + f.kind + (f.diff ? ' L' + esc(f.diff) : '') + '</td><td class="txt">' + esc(f.loc) +
                '</td><td class="num ' + cls + '">' + (g == null ? '&ndash;' : g.toFixed(1) + ' s' + (same ? ' <small>same spot</small>' : '')) +
                '</td><td class="txt' + (trxCount[f.trx] > 1 ? ' aw-g-bad' : '') + '" title="' + esc(f.trx) + '">' +
                esc(f.trx.slice(0, 12)) + (trxCount[f.trx] > 1 ? ' &times;' + trxCount[f.trx] : '') + '</td></tr>');
        }
        return '<div class="aw-tl-head">' + esc(r.wallet) + ' &middot; newest ' + (L.length - start) + ' of ' + L.length +
            ' fights</div><table class="aw-tl"><thead><tr><th class="txt">Time (UTC)</th><th class="txt">Fight</th>' +
            '<th class="txt">Location</th><th class="num">Gap</th><th class="txt">Transaction</th></tr></thead><tbody>' +
            rows.join('') + '</tbody></table>';
    }

    function controls() {
        var b = function (h, l) {
            return '<button class="ops-tab' + (_hours === h ? ' active' : '') + '" data-h="' + h + '">' + l + '</button>';
        };
        return '<div class="ops-tabs">' + b(24, 'Last 24 h') + b(72, 'Last 3 days') + b(168, 'Last 7 days') +
            '<span class="ops-tab-note">dungeons, arenas and quests from chain history</span>' +
            (_data ? '<button class="ops-csv" id="aw-csv">&#8681; CSV</button>' : '') + '</div>';
    }
    function bindControls() {
        var el = document.getElementById('watch');
        el.querySelectorAll('button[data-h]').forEach(function (b) {
            b.onclick = function () { var h = Number(b.getAttribute('data-h')); if (h !== _hours) { _hours = h; load(); } };
        });
        var c = document.getElementById('aw-csv');
        if (c) c.onclick = csv;
    }
    function tileH(k, v, s) {
        return '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>';
    }

    function csv() {
        var head = ['wallet', 'flags', 'fights', 'quests', 'max_per_min', 'max_locations_per_min',
                    'moves_under_15s', 'moves_under_15s_pct', 'median_move_gap_s', 'same_trx_fights', 'hours_per_day', 'longest_session_h'];
        var lines = [head.join(',')].concat(_data.rows.map(function (r) {
            return [r.wallet, r.flags.map(function (f) { return f[0]; }).join(' '), r.fights, r.quests, r.burst, r.locs,
                    r.fast, r.fastPct.toFixed(1), r.medGap == null ? '' : r.medGap, r.batched,
                    r.hoursPerDay.toFixed(2), r.session.toFixed(2)].join(',');
        }));
        var url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
        var a = document.createElement('a');
        a.href = url;
        a.download = 'automation-watch-' + _hours + 'h-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    async function load() {
        if (_busy) return;
        _busy = true;
        var el = document.getElementById('watch');
        _data = null; _open = null;
        el.innerHTML = controls() + '<div class="loading" id="aw-prog">READING CHAIN HISTORY&hellip;</div>';
        bindControls();
        try {
            var raw = await scan(_hours, function (d, n) {
                var p = document.getElementById('aw-prog');
                if (p) p.textContent = 'READING CHAIN HISTORY · ' + d + ' / ' + n + ' HOURS';
            });
            _data = { rows: analyse(raw), from: raw.from, to: raw.to };
            render();
        } catch (e) {
            el.innerHTML = controls() + '<div class="err">Could not read a complete history — ' + esc(e.message || e) +
                '. Nothing partial is shown; try again in a minute.</div>';
            bindControls();
        }
        _busy = false;
    }

    window.opsWatchOpen = function () { if (!_data && !_busy) load(); };
})();
