/* ── AUTOMATION WATCH ─────────────────────────────────────────────────────────
   Loaded by ops.html only after its owner check. Reads dungeon, arena, quest and
   travel actions from chain history and measures, per wallet, what a person on a
   phone can't keep up: moving to a new location every 12 s or faster for minutes
   on end, fighting a near-identical few seconds after every travel, several
   locations in one minute, travel or fights bundled into one transaction, and play
   with no breaks. Quick retries at the same location are ignored: the fight
   animation can be skipped, so those are normal.

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

    // waxsweden takes 1,000 rows a request, eosdac and detroitledger 100 (learned from their
    // own error), so waxsweden is a tenth of the requests when it's up. All three agreed to
    // the action on every window compared. eosusa is left out: its index has gaps that its
    // own total shares, so the completeness check can't catch them. A node that refuses a
    // connection is skipped for the rest of the visit.
    var NODES = ['https://history.waxsweden.org', 'https://wax-history.eosdac.io',
                 'https://hyperion.wax.detroitledger.tech'];
    var PAGE = {}, DEAD = {};
    var FILTER = 'dungeons.ale:playdungeon,arena.ale:playarena,quests.ale:finishquest,players.ale:travel';
    var MOVE_S = 12;               // a move to a new location faster than this, repeatedly, is the signal
    var SUSTAIN_WIN = 3 * 60e3;    // ...measured over any 3 minutes
    var SUSTAIN_MOVES = 15;        // 15 moves in 3 min = averaging under 12 s a move
    var METRO_SPREAD_S = 1.0;      // travel-to-fight delay this steady...
    var METRO_MIN = 20;            // ...over at least this many moves
    var SESSION_BREAK_S = 300;     // a gap this long ends a session
    var HOUR = 3600e3;

    var _hours = 24, _data = null, _sort = 'score', _open = null, _busy = false, _queued = false;

    function iso(ms) { return new Date(ms).toISOString().slice(0, 19); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    /* The public nodes rate-limit (eosdac answers 429 past a few requests a second),
       so requests to each node are spaced out, a 429 waits and retries the same page
       rather than restarting the hour, and finished hours are kept for the visit so
       widening 24 h to 7 days only fetches what isn't already here. */
    var GAP_MS = 250;              // starting spacing between requests to one node
    var GAP_MAX = 3000;
    var lastAt = {}, gap = {}, HOUR_CACHE = {};

    async function politeFetch(node, url) {
        for (var k = 0; k < 7; k++) {
            var g = gap[node] || GAP_MS;
            var wait = (lastAt[node] || 0) + g - Date.now();
            if (wait > 0) await sleep(wait);
            lastAt[node] = Date.now();
            var r = await fetch(url, { signal: AbortSignal.timeout(9000) });   // a healthy node answers in ~1 s
            if (r.status !== 429 && r.status !== 503) {   // 503: overloaded, same as being told to slow down
                gap[node] = Math.max(GAP_MS, g * 0.9);       // ease back once it's accepting again
                return r;
            }
            gap[node] = Math.min(GAP_MAX, g * 2);            // it told us to slow down; stay slower
            var ra = Number(r.headers.get('Retry-After'));
            var back = ra > 0 ? ra * 1000 : Math.min(16000, 2000 * Math.pow(2, k));
            lastAt[node] = Date.now() + back;              // hold every reader off this node
            await sleep(back);
        }
        throw new Error('rate-limited by ' + node.replace('https://', ''));
    }

    // all fights, quests and travel in [a, b), complete or throws
    async function hourActs(a, b, prefer) {
        var key = a + '|' + b;
        if (HOUR_CACHE[key]) return HOUR_CACHE[key];
        // cheapest node first: time per row, i.e. its current spacing over its page size.
        // waxsweden (1,000 rows a page) wins while it's healthy; if it starts throttling its
        // spacing grows and the work moves to the next node on its own. The second reader
        // breaks ties the other way so the two don't queue behind each other.
        var live = NODES.filter(function (x) { return !(DEAD[x] > Date.now()); });
        if (!live.length) live = NODES.slice();   // everything cooling down: try anyway
        var cost = function (x) { return (gap[x] || GAP_MS) / (PAGE[x] || 1000); };
        var order = live.slice().sort(function (x, y) {
            return cost(x) - cost(y) || (prefer ? NODES.indexOf(y) - NODES.indexOf(x) : NODES.indexOf(x) - NODES.indexOf(y));
        });
        for (var n = 0; n < order.length; n++) {
            var node = order[n];
            if (DEAD[node] > Date.now()) continue;
            var refused = 0;
            for (var attempt = 0; attempt < 2; attempt++) {
                try {
                    var out = [], seen = {}, total = null;
                    for (var p = 0; p < 200; p++) {
                        var lim = PAGE[node] || 1000;
                        var r = await politeFetch(node, node + '/v2/history/get_actions?filter=' + FILTER +
                            '&after=' + iso(a) + '&before=' + iso(b) + '&limit=' + lim + '&sort=asc&skip=' + (p * lim) +
                            (p ? '' : '&track=true'));
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
                    if (total !== null && out.length >= total) {
                        // only hours safely in the past are cached; the newest may still be filling
                        if (b < Date.now() - 10 * 60e3) HOUR_CACHE[key] = out;
                        return out;
                    }
                } catch (e) {
                    // dropped connections: rest this node for a minute rather than for the whole visit,
                    // since a node just back from an outage drops the odd connection
                    // a hang counts the same as a refusal: waiting out timeouts on a node that has gone
                    // quiet was what stalled whole scans
                    if ((e.name === 'TypeError' || e.name === 'TimeoutError' || e.name === 'AbortError') &&
                        ++refused >= 1) { DEAD[node] = Date.now() + 60000; break; }
                    if (/rate-limited/.test(e.message)) break;                                 // try the next node
                }
                await sleep(1000 * (attempt + 1));
            }
        }
        throw new Error('no node returned a complete read for ' + iso(a));
    }

    async function scan(hours, progress) {
        // whole hours, so a wider window reuses the same cached slices
        var end = Math.floor((Date.now() - 2 * 60000) / HOUR) * HOUR;
        var slices = [];
        for (var t = end - hours * HOUR; t < end; t += HOUR) slices.push([t, t + HOUR]);
        slices.push([end, Math.floor((Date.now() - 2 * 60000) / 60000) * 60000]);   // the hour in progress
        var parts = [], done = 0, next = 0;
        async function worker(id) {
            while (next < slices.length) {
                var i = next++, s = slices[i];
                parts[i] = s[1] > s[0] ? await hourActs(s[0], s[1], id) : [];   // awaited, then stored by index
                progress(++done, slices.length);
            }
        }
        await Promise.all([worker(0), worker(1)]);   // two readers, each starting on a different node
        var acts = [];
        parts.forEach(function (p) { acts = acts.concat(p); });
        return { acts: acts, from: end - hours * HOUR, to: slices[slices.length - 1][1] };
    }

    function sd(a) {
        if (a.length < 2) return null;
        var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
        return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length);
    }
    function median(a) {
        if (!a.length) return null;
        var b = a.slice().sort(function (x, y) { return x - y; });
        return b[b.length >> 1];
    }
    function hhmm(ms) { return new Date(ms).toISOString().slice(11, 16); }

    function analyse(raw) {
        var by = {}, trxActs = {};
        raw.acts.forEach(function (a) {
            var auth = (a.act.authorization || [])[0] || {};
            var w = auth.actor;
            if (!w) return;
            var d = a.act.data || {};
            var e = by[w] || (by[w] = { wallet: w, fights: [], travels: [], quests: 0 });
            var t = Date.parse(a['@timestamp'] + 'Z');
            (trxActs[a.trx_id] = trxActs[a.trx_id] || []).push({ w: w, n: a.act.name });
            if (a.act.name === 'finishquest') { e.quests++; return; }
            if (a.act.name === 'travel') {
                e.travels.push({ t: t, trx: a.trx_id, kind: 'travel',
                                 loc: (d.planet || '') + (d.x != null ? ' ' + d.x + ',' + d.y : '') });
                return;
            }
            e.fights.push({
                t: t, kind: a.act.name === 'playarena' ? 'arena' : 'dungeon',
                loc: (d.planet || '?') + '/' + (d.land_id || '?'), trx: a.trx_id, diff: d.difficulty || ''
            });
        });
        var days = (raw.to - raw.from) / 86400e3;

        return Object.keys(by).map(function (w) {
            var e = by[w];
            var L = e.fights.sort(function (x, y) { return x.t - y.t; });
            var T = e.travels.sort(function (x, y) { return x.t - y.t; });

            // fastest minute, with when and how long it really took
            var best = { n: 0 }, locs = 0, j = 0, i, k;
            for (i = 0; i < L.length; i++) {
                while (L[i].t - L[j].t >= 60000) j++;
                if (i - j + 1 > best.n) best = { n: i - j + 1, a: L[j].t, b: L[i].t };
                var ls = {};
                for (k = j; k <= i; k++) ls[L[k].loc] = 1;
                locs = Math.max(locs, Object.keys(ls).length);
            }

            // moves to a new location; same-spot retries are skipped animations
            var moves = [];
            for (i = 1; i < L.length; i++)
                if (L[i].loc !== L[i - 1].loc) moves.push({ t: L[i].t, g: (L[i].t - L[i - 1].t) / 1000 });
            var under = moves.filter(function (m) { return m.g < MOVE_S; }).length;

            // sustained pace: most moves inside any 3 minutes, and when
            var sus = { n: 0 }, a0 = 0;
            for (i = 0; i < moves.length; i++) {
                while (moves[i].t - moves[a0].t > SUSTAIN_WIN) a0++;
                if (i - a0 + 1 > sus.n) sus = { n: i - a0 + 1, a: moves[a0].t, b: moves[i].t };
            }

            // travel -> fight: how long after each travel the next fight came
            var tf = [], ti = -1;
            L.forEach(function (f) {
                while (ti + 1 < T.length && T[ti + 1].t <= f.t) ti++;
                var tr = ti >= 0 ? T[ti] : null;
                if (tr && f.t - tr.t < 120000 && !tr.used) { tf.push((f.t - tr.t) / 1000); tr.used = 1; }
            });

            // bundling: fights sharing a transaction, and travel inside a fight's transaction
            var trxCount = {};
            L.forEach(function (f) { trxCount[f.trx] = (trxCount[f.trx] || 0) + 1; });
            var batched = Object.keys(trxCount).reduce(function (s, x) { return s + (trxCount[x] > 1 ? trxCount[x] : 0); }, 0);
            var bundled = L.filter(function (f) {
                return (trxActs[f.trx] || []).some(function (x) { return x.w === w && x.n === 'travel'; });
            }).length;

            // sessions and hours
            var hours = {}, sess = 0, sessStart = L.length ? L[0].t : 0;
            for (i = 0; i < L.length; i++) {
                hours[Math.floor(L[i].t / HOUR)] = 1;
                if (i && L[i].t - L[i - 1].t >= SESSION_BREAK_S * 1000) sessStart = L[i].t;
                sess = Math.max(sess, L[i].t - sessStart);
            }

            var r = {
                wallet: w, fights: L.length, quests: e.quests, travels: T.length,
                best: best, locs: locs, moves: moves.length, under: under,
                underPct: moves.length ? under / moves.length * 100 : 0,
                sus: sus, tfMed: median(tf), tfSd: sd(tf), tfN: tf.length,
                batched: batched, bundled: bundled,
                hoursPerDay: Object.keys(hours).length / days, session: sess / HOUR,
                timeline: L.concat(T).sort(function (x, y) { return x.t - y.t; })
            };
            r.flags = [];
            if (r.sus.n >= SUSTAIN_MOVES)
                r.flags.push(['SUSTAINED', r.sus.n + ' moves to new locations in 3 min (' + hhmm(r.sus.a) + '–' + hhmm(r.sus.b) + ' UTC)']);
            if (r.tfN >= METRO_MIN && r.tfSd != null && r.tfSd <= METRO_SPREAD_S)
                r.flags.push(['METRONOME', 'fights ' + r.tfMed.toFixed(1) + ' s after travel, ±' + r.tfSd.toFixed(2) + ' s over ' + r.tfN + ' moves']);
            if (r.bundled) r.flags.push(['BUNDLE', r.bundled + ' fights signed in the same transaction as a travel']);
            if (r.batched) r.flags.push(['BATCH', 'fights signed together in one transaction']);
            if (r.locs >= 5) r.flags.push(['BURST', r.locs + ' different locations inside one minute']);
            if (r.session >= 6) r.flags.push(['MARATHON', r.session.toFixed(1) + ' h without a 5-minute break']);
            if (r.hoursPerDay >= 18) r.flags.push(['24/7', r.hoursPerDay.toFixed(1) + ' active hours a day']);
            var heavy = { SUSTAINED: 3, METRONOME: 3, BUNDLE: 3 };
            r.score = r.flags.reduce(function (s, f) { return s + (heavy[f[0]] || 1) * 1000; }, 0) +
                      r.sus.n * 20 + r.underPct + (r.tfSd != null ? 50 / (1 + r.tfSd) : 0);
            return r;
        });
    }

    var COLS = [
        ['wallet', 'Wallet', 'txt'], ['flags', 'Flags', 'txt'], ['fights', 'Fights', 'num'],
        ['quests', 'Quests', 'num'], ['best', 'Fastest minute', 'num'], ['locs', 'Locations / min', 'num'],
        ['underPct', 'Moves < 12 s', 'num'], ['sus', 'Best 3 min', 'num'], ['tf', 'Travel → fight', 'num'],
        ['batched', 'Same trx', 'num'], ['hoursPerDay', 'Hours / day', 'num'], ['session', 'Longest session', 'num']
    ];
    var SORTKEY = { best: function (r) { return r.best.n; }, sus: function (r) { return r.sus.n; },
                    tf: function (r) { return r.tfSd == null ? 1e9 : r.tfSd; } };

    function cell(r, k) {
        if (k === 'wallet') return esc(r.wallet);
        if (k === 'flags') return r.flags.map(function (f) {
            return '<span class="aw-flag aw-' + f[0].replace('/', '') + '" title="' + esc(f[1]) + '">' + f[0] + '</span>';
        }).join(' ') || '<span class="aw-none">&ndash;</span>';
        if (k === 'best') return r.best.n ? r.best.n + ' <small>in ' + Math.round((r.best.b - r.best.a) / 1000) + ' s &middot; ' + hhmm(r.best.a) + '</small>' : '&ndash;';
        if (k === 'underPct') return r.moves ? Math.round(r.underPct) + '% <small>(' + r.under + ' of ' + r.moves + ')</small>' : '&ndash;';
        if (k === 'sus') return r.sus.n ? r.sus.n + ' <small>moves &middot; ' + hhmm(r.sus.a) + '</small>' : '&ndash;';
        if (k === 'tf') return r.tfN ? r.tfMed.toFixed(1) + ' s <small>±' + (r.tfSd == null ? '–' : r.tfSd.toFixed(1)) + ' &middot; ' + r.tfN + '</small>' : '&ndash;';
        if (k === 'hoursPerDay') return r.hoursPerDay.toFixed(1);
        if (k === 'session') return r.session.toFixed(1) + ' h';
        return String(r[k]);
    }

    function render() {
        var el = document.getElementById('watch');
        if (!_data) return;
        var rows = _data.rows.slice().sort(function (a, b) {
            if (_sort === 'wallet') return a.wallet.localeCompare(b.wallet);
            if (_sort === 'flags' || _sort === 'score') return b.score - a.score;
            if (_sort === 'tf') return SORTKEY.tf(a) - SORTKEY.tf(b);
            if (SORTKEY[_sort]) return SORTKEY[_sort](b) - SORTKEY[_sort](a);
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
            '<p class="note">Only <b>moves to a new location</b> are timed: a retry at the same arena or dungeon ' +
            'can follow within seconds by skipping the animation, so it&rsquo;s normal. Strong signals: ' +
            '<b>SUSTAINED</b> ' + SUSTAIN_MOVES + '+ moves in any 3 minutes (averaging under ' + MOVE_S + ' s a move) &middot; ' +
            '<b>METRONOME</b> fighting the same few seconds after every travel, within ±' + METRO_SPREAD_S + ' s over ' + METRO_MIN + '+ moves &middot; ' +
            '<b>BUNDLE</b> travel signed in the same transaction as a fight. Weaker: <b>BATCH</b> fights sharing a transaction &middot; ' +
            '<b>BURST</b> 5+ locations in a minute &middot; <b>MARATHON</b> 6 h+ with no 5-minute break &middot; ' +
            '<b>24/7</b> 18+ active hours a day. Naron Codex&rsquo;s Dungeon Run queue also fires back to back, so ' +
            'look closer before concluding. Click a wallet for its timeline, travel included.</p>' +
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

    // newest 80 events, travel included; each fight shows the gap since the last fight
    // and, when a travel came between, how long after the travel
    function timeline(r) {
        var L = r.timeline, start = Math.max(0, L.length - 80), i, f;
        var trxCount = {};
        L.forEach(function (x) { if (x.kind !== 'travel') trxCount[x.trx] = (trxCount[x.trx] || 0) + 1; });
        var info = [], lastFight = null, lastTravel = null;
        for (i = 0; i < L.length; i++) {
            f = L[i];
            if (f.kind === 'travel') { lastTravel = f; info.push(null); continue; }
            info.push({
                g: lastFight ? (f.t - lastFight.t) / 1000 : null,
                same: !!(lastFight && lastFight.loc === f.loc),
                tf: lastTravel && (!lastFight || lastTravel.t > lastFight.t) ? (f.t - lastTravel.t) / 1000 : null
            });
            lastFight = f;
        }
        var rows = [];
        for (i = L.length - 1; i >= start; i--) {
            f = L[i];
            var stamp = iso(f.t).replace('T', ' ') + '.' + String(f.t % 1000).padStart(3, '0').slice(0, 1);
            if (f.kind === 'travel') {
                rows.push('<tr class="aw-travel"><td class="txt">' + stamp + '</td><td class="txt">travel</td><td class="txt">' +
                    esc(f.loc) + '</td><td class="num"></td><td class="num"></td><td class="txt"></td></tr>');
                continue;
            }
            var x = info[i];
            var cls = x.g == null ? '' : x.same ? 'aw-g-same' : x.g < MOVE_S ? 'aw-g-bad' : x.g < 20 ? 'aw-g-warn' : '';
            rows.push('<tr><td class="txt">' + stamp + '</td><td class="txt">' + f.kind + (f.diff ? ' L' + esc(f.diff) : '') +
                '</td><td class="txt">' + esc(f.loc) + '</td><td class="num ' + cls + '">' +
                (x.g == null ? '&ndash;' : x.g.toFixed(1) + ' s' + (x.same ? ' <small>same spot</small>' : '')) +
                '</td><td class="num">' + (x.tf == null ? '' : x.tf.toFixed(1) + ' s') +
                '</td><td class="txt' + (trxCount[f.trx] > 1 ? ' aw-g-bad' : '') + '" title="' + esc(f.trx) + '">' +
                esc(f.trx.slice(0, 12)) + (trxCount[f.trx] > 1 ? ' &times;' + trxCount[f.trx] : '') + '</td></tr>');
        }
        return '<div class="aw-tl-head">' + esc(r.wallet) + ' &middot; newest ' + (L.length - start) + ' of ' + L.length +
            ' fights and travels</div><table class="aw-tl"><thead><tr><th class="txt">Time (UTC)</th><th class="txt">Action</th>' +
            '<th class="txt">Location</th><th class="num">Since last fight</th><th class="num">After travel</th>' +
            '<th class="txt">Transaction</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }

    function controls() {
        var b = function (h, l) {
            return '<button class="ops-tab' + (_hours === h ? ' active' : '') + '" data-h="' + h + '">' + l + '</button>';
        };
        return '<div class="ops-tabs">' + b(24, 'Last 24 h') + b(72, 'Last 3 days') + b(168, 'Last 7 days') +
            '<span class="ops-tab-note">fights, quests and travel from chain history</span>' +
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
        var head = ['wallet', 'flags', 'fights', 'quests', 'travels', 'fastest_minute_fights', 'fastest_minute_secs',
                    'max_locations_per_min', 'moves', 'moves_under_12s', 'best_3min_moves', 'travel_to_fight_median_s',
                    'travel_to_fight_spread_s', 'same_trx_fights', 'travel_bundled_fights', 'hours_per_day', 'longest_session_h'];
        var lines = [head.join(',')].concat(_data.rows.map(function (r) {
            return [r.wallet, r.flags.map(function (f) { return f[0]; }).join(' '), r.fights, r.quests, r.travels,
                    r.best.n, r.best.n ? Math.round((r.best.b - r.best.a) / 1000) : '', r.locs, r.moves, r.under, r.sus.n,
                    r.tfMed == null ? '' : r.tfMed.toFixed(1), r.tfSd == null ? '' : r.tfSd.toFixed(2),
                    r.batched, r.bundled, r.hoursPerDay.toFixed(2), r.session.toFixed(2)].join(',');
        }));
        var url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
        var a = document.createElement('a');
        a.href = url;
        a.download = 'automation-watch-' + _hours + 'h-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    async function load() {
        if (_busy) { _queued = true; return; }        // picked up when the running scan ends
        _busy = true;
        var el = document.getElementById('watch');
        _data = null; _open = null;
        el.innerHTML = controls() + '<div class="loading" id="aw-prog">READING CHAIN HISTORY&hellip;</div>';
        bindControls();
        try {
            var raw = await scan(_hours, function (d, n) {
                var p = document.getElementById('aw-prog');
                if (p) p.textContent = 'READING CHAIN HISTORY · ' + d + ' / ' + n + ' HOURS' +
                                       (_queued ? ' · THEN ' + _hours + ' H' : '');
            });
            _data = { rows: analyse(raw), from: raw.from, to: raw.to };
            render();
        } catch (e) {
            el.innerHTML = controls() + '<div class="err">Could not read a complete history — ' + esc(e.message || e) +
                '. Nothing partial is shown; try again in a minute.</div>';
            bindControls();
        }
        _busy = false;
        if (_queued) { _queued = false; load(); }
    }

    window.opsWatchOpen = function () { if (!_data && !_busy) load(); };
})();
