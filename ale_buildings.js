/* ── BUILDINGS TAB (aleleaders.html) ─────────────────────────────────────────
   Every Alien Legends building: where it is, who owns the land under it, its
   level, its boost now and when it was last boosted, how busy it is, and what
   it has earned since it was last claimed.

   Sources
     lands.ale  lands (one scope per planet)  type, level, coords, boost, accruals
     AtomicAssets  owner of each land NFT      the building's owner
     players.ale   players                     gamertags; who is using each tavern
     history  lands.ale::boost                 last boost: when, by whom, to what
     history  playdungeon / playarena          fights and unique visitors per site

   Boost decays 115 points an hour from its last checkpoint (lands.ale config:
   boost_decay_per_hour); it also decays as the building earns, so "boost now" is
   an estimate a little on the high side. Hires and reveals don't record which
   tavern they were at, so taverns show the players using them instead of fights. */
(function () {
    'use strict';

    var PLANETS = ['naron', 'magor', 'eyeke', 'kavian', 'neri', 'veles'];
    var RPC = ['https://wax.greymass.com', 'https://api.wax.alohaeos.com', 'https://wax.eosusa.io'];
    var AA = ['https://wax.api.atomicassets.io', 'https://atomic.wax.eosrio.io'];
    // full-history nodes; waxsweden pages 1,000 rows, the others 100 (learned from their error)
    var HIST = ['https://history.waxsweden.org', 'https://wax-history.eosdac.io',
                'https://hyperion.wax.detroitledger.tech'];
    var DECAY_PER_HOUR = 115;
    var HOUR = 3600e3;

    var _rows = null, _sort = 'busy', _dir = -1, _type = 'all', _planet = 'all', _q = '';
    var _hours = 24, _fightsFor = null, _status = '', _busy = false;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function iso(ms) { return new Date(ms).toISOString().slice(0, 19); }
    function utcMs(s) { return s ? Date.parse(String(s).replace(/Z?$/, 'Z')) : NaN; }
    function ago(ms) {
        if (!ms || isNaN(ms)) return '–';
        var m = (Date.now() - ms) / 60000;
        if (m < 60) return Math.max(0, Math.round(m)) + ' min ago';
        if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
        return Math.round(m / 1440) + ' d ago';
    }
    function num(n, d) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }); }

    /* ── chain reads ────────────────────────────────────────────────────────── */
    async function rows(body) {
        for (var i = 0; i < RPC.length; i++) {
            try {
                var r = await fetch(RPC[i] + '/v1/chain/get_table_rows', {
                    method: 'POST', headers: { 'Content-Type': 'text/plain' },
                    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
                });
                if (r.ok) return await r.json();
            } catch (e) { /* next node */ }
        }
        throw new Error('chain unreachable');
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

    async function landOwners(ids) {
        var out = {};
        for (var i = 0; i < ids.length; i += 100) {
            var batch = ids.slice(i, i + 100), done = false;
            for (var n = 0; n < AA.length && !done; n++) {
                try {
                    var r = await fetch(AA[n] + '/atomicassets/v1/assets?ids=' + batch.join(',') + '&limit=100',
                                        { signal: AbortSignal.timeout(15000) });
                    if (!r.ok) continue;
                    var j = await r.json();
                    (j.data || []).forEach(function (a) { out[a.asset_id] = a.owner; });
                    done = true;
                } catch (e) { /* next */ }
            }
        }
        return out;
    }

    /* history: paced per node, 429/503 retried in place, cheapest node first,
       every window checked against the node's own total before it's used */
    var PAGE = {}, gap = {}, lastAt = {}, REST = {};
    async function politeFetch(node, url) {
        for (var k = 0; k < 7; k++) {
            var g = gap[node] || 250, wait = (lastAt[node] || 0) + g - Date.now();
            if (wait > 0) await sleep(wait);
            lastAt[node] = Date.now();
            var r = await fetch(url, { signal: AbortSignal.timeout(9000) });
            if (r.status !== 429 && r.status !== 503) { gap[node] = Math.max(250, g * 0.9); return r; }
            gap[node] = Math.min(3000, g * 2);
            var back = Math.min(16000, 2000 * Math.pow(2, k));
            lastAt[node] = Date.now() + back;
            await sleep(back);
        }
        throw new Error('rate-limited');
    }
    function nodeOrder() {
        var live = HIST.filter(function (x) { return !(REST[x] > Date.now()); });
        if (!live.length) live = HIST.slice();
        var cost = function (x) { return (gap[x] || 250) / (PAGE[x] || 1000); };
        return live.sort(function (a, b) { return cost(a) - cost(b) || HIST.indexOf(a) - HIST.indexOf(b); });
    }
    // all actions matching filter in [a, b) — complete, or throws
    async function windowActs(filter, a, b) {
        var order = nodeOrder();
        for (var n = 0; n < order.length; n++) {
            var node = order[n];
            try {
                var out = [], seen = {}, total = null;
                for (var p = 0; p < 200; p++) {
                    var lim = PAGE[node] || 1000;
                    var r = await politeFetch(node, node + '/v2/history/get_actions?filter=' + filter +
                        (a ? '&after=' + iso(a) : '') + (b ? '&before=' + iso(b) : '') +
                        '&limit=' + lim + '&sort=asc&skip=' + (p * lim) + (p ? '' : '&track=true'));
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
                if (e.name === 'TypeError' || e.name === 'TimeoutError' || e.name === 'AbortError')
                    REST[node] = Date.now() + 60000;
            }
        }
        throw new Error('no history node gave a complete read');
    }

    /* ── loading ────────────────────────────────────────────────────────────── */
    async function loadBase() {
        setStatus('Reading buildings…');
        var lands = [];
        for (var i = 0; i < PLANETS.length; i++) {
            var pl = PLANETS[i];
            (await allRows('lands.ale', pl, 'lands')).forEach(function (l) { l._planet = l.planet || pl; lands.push(l); });
        }
        var players = await allRows('players.ale', 'players.ale', 'players');
        var tags = {}, tavernUsers = {};
        players.forEach(function (p) {
            if (p.playertag) tags[p.wallet] = p.playertag;
            (p.active_taverns || []).forEach(function (t) {
                var k = t.planet + '|' + t.x + '|' + t.y;
                tavernUsers[k] = (tavernUsers[k] || 0) + 1;
            });
        });

        var out = [], ids = {};
        lands.forEach(function (l) {
            (l.buildings || []).forEach(function (b) {
                var upd = utcMs(b.boost_score_update);
                var hours = isNaN(upd) ? 0 : Math.max(0, (Date.now() - upd) / HOUR);
                out.push({
                    type: b.building_name, planet: l._planet, x: Number(l.x), y: Number(l.y), landId: l.land_id,
                    land: [l.land_type, l.rarity].filter(Boolean).join(' · '), assetId: String(l.asset_id || ''),
                    level: Number(b.level) || 0,
                    boost: Math.max(0, Number(b.boost_score || 0) - hours * DECAY_PER_HOUR),
                    tlm: Number(b.tlm || 0) / 1e4, shards: Number(b.shards || 0) / 10,
                    credits: Number(b.credits || 0), gems: Number(b.gems || 0),
                    since: utcMs(b.last_claim),
                    users: b.building_name === 'tavern' ? (tavernUsers[l._planet + '|' + l.x + '|' + l.y] || 0) : null,
                    owner: '', tag: '', lastBoost: null, fights: null, visitors: null
                });
                if (l.asset_id && String(l.asset_id) !== '0') ids[String(l.asset_id)] = 1;
            });
        });

        setStatus('Reading land owners…');
        var owners = await landOwners(Object.keys(ids));
        out.forEach(function (r) {
            r.owner = owners[r.assetId] || '';
            r.tag = tags[r.owner] || '';
        });
        return out;
    }

    // newest boost per building; boosts are rare, so this is a few pages of history
    async function loadBoosts(list) {
        setStatus('Reading boost history…');
        // week by week from the start of beta: the nodes cap paging at 10,000 rows a query
        var acts = [], from = Date.UTC(2026, 8, 1), now = Date.now();
        for (var w = from; w < now; w += 7 * 24 * HOUR)
            acts = acts.concat(await windowActs('lands.ale:boost', w, Math.min(now, w + 7 * 24 * HOUR)));
        var last = {};
        acts.forEach(function (a) {
            var d = a.act.data || {};
            var k = d.planet + '|' + d.x + '|' + d.y + '|' + d.building;
            var t = utcMs(a['@timestamp']);
            if (!last[k] || t > last[k].t)
                last[k] = { t: t, by: (a.act.authorization[0] || {}).actor, target: Number(d.boost_target || 0),
                            credits: Number(d.cost_credits || 0), gems: Number(d.cost_gems || 0) };
        });
        list.forEach(function (r) { r.lastBoost = last[r.planet + '|' + r.x + '|' + r.y + '|' + r.type] || null; });
    }

    async function loadFights(list, hours) {
        var end = Math.floor((Date.now() - 2 * 60e3) / 60e3) * 60e3, start = end - hours * HOUR;
        var slices = [];
        for (var t = start; t < end; t += HOUR) slices.push([t, Math.min(end, t + HOUR)]);
        var count = {}, who = {}, done = 0, next = 0;
        async function worker() {
            while (next < slices.length) {
                var s = slices[next++];
                var acts = await windowActs('dungeons.ale:playdungeon,arena.ale:playarena', s[0], s[1]);
                acts.forEach(function (a) {
                    var d = a.act.data || {};
                    var k = d.planet + '|' + d.land_id + '|' + (a.act.name === 'playarena' ? 'arena' : 'dungeon');
                    count[k] = (count[k] || 0) + 1;
                    (who[k] = who[k] || {})[(a.act.authorization[0] || {}).actor] = 1;
                });
                setStatus('Reading fights… ' + (++done) + ' / ' + slices.length + ' hours');
            }
        }
        await Promise.all([worker(), worker()]);
        list.forEach(function (r) {
            if (r.type === 'tavern') return;
            var k = r.planet + '|' + r.landId + '|' + r.type;
            r.fights = (count[k] || 0) / (hours / 24);                 // per day
            r.visitors = who[k] ? Object.keys(who[k]).length : 0;      // in the window
        });
        _fightsFor = hours;
    }

    async function load() {
        if (_busy) return;
        _busy = true;
        try {
            _rows = await loadBase();
            render();
            try { await loadBoosts(_rows); render(); }
            catch (e) { _status = 'Boost history unavailable right now — ' + e.message; }
            await loadFights(_rows, _hours);
            setStatus('');
            render();
        } catch (e) {
            setStatus('Could not finish: ' + e.message + '. Showing what loaded; refresh to retry.');
            render();
        }
        _busy = false;
    }

    async function reloadFights(h) {
        if (_busy || !_rows) return;
        _busy = true;
        _hours = h;
        _rows.forEach(function (r) { r.fights = null; r.visitors = null; });
        render();
        try { await loadFights(_rows, h); setStatus(''); }
        catch (e) { setStatus('Fight history incomplete — ' + e.message + '. Nothing partial is shown; try again.'); }
        render();
        _busy = false;
    }

    /* ── view ───────────────────────────────────────────────────────────────── */
    var COLS = [
        ['type', 'Building', 'txt'], ['planet', 'Planet', 'txt'], ['xy', 'X, Y', 'txt'], ['land', 'Land', 'txt'],
        ['tag', 'Owner', 'txt'], ['owner', 'Wallet', 'txt'], ['boost', 'Boost now', 'num'],
        ['lastBoost', 'Last boosted', 'txt'], ['busy', 'Fights / day', 'num'], ['visitors', 'Unique visitors', 'num'],
        ['users', 'Tavern users', 'num'], ['tlm', 'TLM', 'num'], ['shards', 'Shards', 'num'],
        ['credits', 'Credits', 'num'], ['gems', 'Gems', 'num'], ['since', 'Unclaimed since', 'txt']
    ];
    var KEY = {
        xy: function (r) { return r.x * 1000 + r.y; },
        busy: function (r) { return r.fights == null ? -1 : r.fights; },      // taverns have no fights; they sort last
        users: function (r) { return r.users == null ? -1 : r.users; },
        lastBoost: function (r) { return r.lastBoost ? r.lastBoost.t : 0; },
        since: function (r) { return isNaN(r.since) ? 0 : r.since; }
    };
    function sortVal(r, k) { return KEY[k] ? KEY[k](r) : r[k]; }

    function cell(r, k) {
        if (k === 'type') return '<span class="bld-type bld-' + esc(r.type) + '">' + esc(r.type) + '</span>';
        if (k === 'xy') return r.x + ', ' + r.y;
        if (k === 'land') return '<span title="' + esc(r.landId) + '">' + esc(r.land || r.landId) + '</span>';
        if (k === 'tag') return esc(r.tag) || '<span class="bld-dim">–</span>';
        if (k === 'owner') return esc(r.owner) || '<span class="bld-dim">–</span>';
        if (k === 'boost') return num(r.boost);
        if (k === 'lastBoost') return r.lastBoost
            ? '<span title="to ' + num(r.lastBoost.target) + ' for ' + num(r.lastBoost.credits) + ' credits' +
              (r.lastBoost.gems ? ' + ' + num(r.lastBoost.gems) + ' gems' : '') + ' · ' + iso(r.lastBoost.t).replace('T', ' ') + ' UTC">' +
              ago(r.lastBoost.t) + ' <small>by ' + esc(r.lastBoost.by) + '</small></span>'
            : '<span class="bld-dim">not since 1 Sep</span>';
        if (k === 'busy') return r.type === 'tavern' ? '<span class="bld-dim">n/a</span>'
            : r.fights == null ? '<span class="bld-dim">…</span>' : num(r.fights, r.fights < 10 ? 1 : 0);
        if (k === 'visitors') return r.type === 'tavern' ? '<span class="bld-dim">n/a</span>'
            : r.visitors == null ? '<span class="bld-dim">…</span>' : num(r.visitors);
        if (k === 'users') return r.type === 'tavern' ? num(r.users) : '<span class="bld-dim">–</span>';
        if (k === 'tlm') return num(r.tlm, 2);
        if (k === 'shards') return num(r.shards, 1);
        if (k === 'credits' || k === 'gems') return num(r[k]);
        if (k === 'since') return isNaN(r.since) ? '–' : ago(r.since);
        return esc(r[k]);
    }

    function visible() {
        var q = _q.toLowerCase();
        return _rows.filter(function (r) {
            return (_type === 'all' || r.type === _type) && (_planet === 'all' || r.planet === _planet) &&
                   (!q || r.owner.toLowerCase().indexOf(q) >= 0 || r.tag.toLowerCase().indexOf(q) >= 0 ||
                    (r.landId || '').toLowerCase().indexOf(q) >= 0);
        }).sort(function (a, b) {
            var x = sortVal(a, _sort), y = sortVal(b, _sort);
            if (typeof x === 'string' || typeof y === 'string') return _dir * String(x).localeCompare(String(y));
            return _dir * ((x == null ? -1 : x) - (y == null ? -1 : y));
        });
    }

    function render() {
        var el = document.getElementById('bld-view');
        if (!el) return;
        var btn = function (grp, val, label, cur) {
            return '<button class="bld-pill' + (cur === val ? ' on' : '') + '" data-' + grp + '="' + val + '">' + label + '</button>';
        };
        var counts = { dungeon: 0, arena: 0, tavern: 0 };
        (_rows || []).forEach(function (r) { counts[r.type] = (counts[r.type] || 0) + 1; });

        var h = '<div class="bld-bar">' +
            btn('type', 'all', 'All ' + (_rows ? _rows.length : ''), _type) +
            btn('type', 'dungeon', 'Dungeons ' + counts.dungeon, _type) +
            btn('type', 'arena', 'Arenas ' + counts.arena, _type) +
            btn('type', 'tavern', 'Taverns ' + counts.tavern, _type) +
            '<span class="bld-sep"></span>' +
            '<select id="bld-planet"><option value="all">All planets</option>' +
            PLANETS.map(function (p) { return '<option value="' + p + '"' + (_planet === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') +
            '</select>' +
            '<input id="bld-search" type="text" placeholder="Owner, wallet or land ID" value="' + esc(_q) + '">' +
            '<span class="bld-sep"></span><span class="bld-lbl">Fights over</span>' +
            btn('h', '24', '24 h', String(_hours)) + btn('h', '168', '7 days', String(_hours)) +
            '<button class="dl-btn" id="bld-csv"' + (_rows ? '' : ' disabled') + '>&#8659; CSV</button>' +
            '</div>' +
            '<div class="bld-status">' + esc(_status) + '</div>' +
            '<p class="bld-note">Owner is whoever holds the land NFT the building stands on. Boost now is an estimate: it ' +
            'decays ' + DECAY_PER_HOUR + ' an hour and also as the building earns. Fights per day and unique visitors cover the ' +
            (_fightsFor === 168 ? 'last 7 days' : 'last 24 hours') + '. Hires and reveals don&rsquo;t record which tavern they ' +
            'were at, so taverns show how many players have them as an active tavern instead. TLM, shards, credits and gems ' +
            'are what the building has earned since it was last claimed.</p>';

        if (!_rows) {
            el.innerHTML = h + '<div class="bld-empty">Loading…</div>';
            bind(el);
            return;
        }
        var list = visible();
        h += '<div class="bld-wrap"><table class="bld-table"><thead><tr>' +
            COLS.map(function (c) {
                return '<th class="' + c[2] + (c[0] === _sort ? (_dir < 0 ? ' sort-desc' : ' sort-asc') : '') + '" data-k="' + c[0] + '">' + c[1] + '</th>';
            }).join('') + '</tr></thead><tbody>' +
            list.map(function (r) {
                return '<tr>' + COLS.map(function (c) { return '<td class="' + c[2] + '">' + cell(r, c[0]) + '</td>'; }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>';
        el.innerHTML = h;
        bind(el);
    }

    function bind(el) {
        el.querySelectorAll('[data-type]').forEach(function (b) { b.onclick = function () { _type = b.getAttribute('data-type'); render(); }; });
        el.querySelectorAll('[data-h]').forEach(function (b) {
            b.onclick = function () { var h = Number(b.getAttribute('data-h')); if (h !== _hours) reloadFights(h); };
        });
        el.querySelectorAll('th[data-k]').forEach(function (th) {
            th.onclick = function () {
                var k = th.getAttribute('data-k');
                if (_sort === k) _dir = -_dir; else { _sort = k; _dir = COLS.some(function (c) { return c[0] === k && c[2] === 'txt'; }) ? 1 : -1; }
                render();
            };
        });
        var p = el.querySelector('#bld-planet');
        if (p) p.onchange = function () { _planet = p.value; render(); };
        var s = el.querySelector('#bld-search');
        if (s) s.oninput = function () {
            _q = s.value;
            var pos = s.selectionStart;
            render();
            var s2 = document.getElementById('bld-search');
            s2.focus(); s2.setSelectionRange(pos, pos);
        };
        var c = el.querySelector('#bld-csv');
        if (c) c.onclick = csv;
    }

    function setStatus(t) {
        _status = t;
        var s = document.querySelector('#bld-view .bld-status');
        if (s) s.textContent = t;
    }

    function csv() {
        var head = ['building', 'planet', 'x', 'y', 'land_id', 'land', 'owner_tag', 'owner_wallet', 'boost_now_est',
                    'last_boost_utc', 'last_boost_by', 'last_boost_target', 'fights_per_day', 'unique_visitors', 'window_hours',
                    'tavern_users', 'tlm', 'shards', 'credits', 'gems', 'unclaimed_since_utc'];
        var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        var lines = [head.join(',')].concat(visible().map(function (r) {
            return [r.type, r.planet, r.x, r.y, r.landId, r.land, r.tag, r.owner, Math.round(r.boost),
                    r.lastBoost ? iso(r.lastBoost.t) : '', r.lastBoost ? r.lastBoost.by : '', r.lastBoost ? r.lastBoost.target : '',
                    r.fights == null ? '' : r.fights.toFixed(2), r.visitors == null ? '' : r.visitors, _fightsFor || '',
                    r.users == null ? '' : r.users, r.tlm.toFixed(4), r.shards.toFixed(1), r.credits, r.gems,
                    isNaN(r.since) ? '' : iso(r.since)].map(q).join(',');
        }));
        var url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ale-buildings-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    window.aleBuildingsOpen = function () {
        if (!_rows && !_busy) { render(); load(); } else render();
    };
})();
