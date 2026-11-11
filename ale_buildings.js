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
    var _view = 'table', _players = [], _share = {};

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
        _players = players; _share = {};
        players.forEach(function (p) {
            if (p.playertag) tags[p.wallet] = p.playertag;
            // landowner_tlm_share: the % of land rewards an owner takes as TLM; the rest comes as shards
            if (p.landowner_tlm_share != null) _share[p.wallet] = Number(p.landowner_tlm_share);
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
                    land: [l.land_type, l.rarity].filter(Boolean).join(' · '), landType: l.land_type || 'Unknown', assetId: String(l.asset_id || ''),
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
        ['users', 'Tavern users', 'num'], ['tlm', 'TLM to claim', 'num'], ['shards', 'Shards since claim', 'num'],
        ['credits', 'Credits', 'num'], ['gems', 'Gems', 'num'], ['since', 'Last claimed', 'txt']
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
        // boost as the in-game multiplier (score ÷ 100,000); the raw score is in the tooltip
        if (k === 'boost') return '<span title="boost score ' + num(r.boost) + '">' + (r.boost / 100000).toFixed(1) + 'x</span>';
        if (k === 'lastBoost') return r.lastBoost
            ? '<span title="to ' + (Number(r.lastBoost.target) / 100000).toFixed(1) + 'x for ' + num(r.lastBoost.credits) + ' credits' +
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


    /* ── TLM / shard split ────────────────────────────────────────────────────
       Each player's landowner_tlm_share (players.ale) is the % of their land
       rewards taken as TLM; the rest is paid as shards. 50 is the default.
       Boost is shown in-game as a multiplier; boost score ÷ 100,000 matches it
       (a new building starts at 350,000 = 3.5x), so 0.1x is 10,000. */
    var BOOST_X = 100000, BOOST_STEPS = [0.1, 1, 2, 3, 4, 5, 6], _minX = 0.1;
    /* Building rewards: when a building pays out, pools.ale::claimbreward draws on
       that building type's pools (logged as tlmlndowner / shrdlndowner). The same
       pools also pay the players fighting there. Shard amounts are stored in tenths. */
    var BPOOLS = [['Arena', 'tlmarena', 'shrdarena'], ['Dungeon', 'tlmdung', 'shrddung'], ['Tavern', 'tlmtavern', 'shrdtavern']];
    var _pools = null, _poolsBusy = false;
    async function loadPools() {
        if (_pools || _poolsBusy) return;
        _poolsBusy = true;
        try {
            var t = await allRows('pools.ale', 'pools.ale', 'tlmpools'), sh = await allRows('pools.ale', 'pools.ale', 'shardpools');
            var tm = {}, sm = {};
            t.forEach(function (r) { tm[r.pool] = r; });
            sh.forEach(function (r) { sm[r.pool] = r; });
            _pools = BPOOLS.map(function (b) {
                var tp = tm[b[1]] || {}, sp = sm[b[2]] || {};
                return { name: b[0], tlmNow: parseFloat(tp.tlm_current) || 0, tlmHr: parseFloat(tp.fillrate) || 0,
                         shNow: (Number(sp.shard_current) || 0) / 10, shHr: (Number(sp.fillrate_per_hour) || 0) / 10, tp: b[1], sp: b[2] };
            });
        } catch (e) { _pools = []; }
        _poolsBusy = false;
        if (_view === 'split') render();
    }
    // two small single-series bar charts: what each building pool gains per hour
    function poolChart(key, unit, cls) {
        var max = Math.max.apply(null, _pools.map(function (p) { return p[key]; }).concat([1e-9]));
        return '<div class="sp-mini"><div class="sp-mini-h">' + unit + ' added per hour</div>' + _pools.map(function (p) {
            var w = p[key] / max * 100;
            return '<div class="sp-mini-r" title="' + esc(p.name + ': ' + fmtN2(p[key]) + ' ' + unit + ' an hour') + '"><span>' + p.name + '</span>' +
                '<div class="sp-mini-t"><i class="' + cls + '" style="width:' + w.toFixed(1) + '%"></i></div><b>' + fmtN2(p[key]) + '</b></div>';
        }).join('') + '</div>';
    }
    function fmtN2(x) { return Number(x).toLocaleString('en', { maximumFractionDigits: x < 100 ? 2 : 0 }); }
    function renderPools() {
        if (!_pools) { loadPools(); return '<section class="sp-sec"><h3>Pools that pay buildings</h3><p class="sp-key">Reading pools.ale…</p></section>'; }
        if (!_pools.length) return '';
        return '<section class="sp-sec"><h3>Pools that pay buildings <small>pools.ale, live</small></h3>' +
            '<div class="sp-pools">' + poolChart('tlmHr', 'TLM', 'sp-ptlm') + poolChart('shHr', 'Shards', 'sp-pshd') + '</div>' +
            '<div class="bld-wrap"><table class="bld-table sp-table"><thead><tr><th class="txt">Building</th><th class="txt">TLM pool</th><th class="num">In it now</th><th class="num">Added / hour</th>' +
            '<th class="txt">Shard pool</th><th class="num">In it now</th><th class="num">Added / hour</th></tr></thead><tbody>' +
            _pools.map(function (p) {
                return '<tr><td class="txt">' + p.name + '</td><td class="txt">' + p.tp + '</td><td class="num">' + fmtN2(p.tlmNow) + '</td><td class="num">' + fmtN2(p.tlmHr) + '</td>' +
                    '<td class="txt">' + p.sp + '</td><td class="num">' + fmtN2(p.shNow) + '</td><td class="num">' + fmtN2(p.shHr) + '</td></tr>';
            }).join('') + '</tbody></table></div>' +
            '<p class="sp-key">A building\u2019s owner is paid from its type\u2019s pools (in the chain\u2019s reward log as tlmlndowner and shrdlndowner); ' +
            'the same pools also pay the players fighting or hiring there.</p></section>';
    }
    var BUCKETS = [
        { k: 'b0', label: 'All shards', test: function (v) { return v === 0; } },
        { k: 'b1', label: 'Mostly shards', test: function (v) { return v > 0 && v < 50; } },
        { k: 'b2', label: 'Even split (default 50%)', test: function (v) { return v === 50; } },
        { k: 'b3', label: 'Mostly TLM', test: function (v) { return v > 50 && v < 100; } },
        { k: 'b4', label: 'All TLM', test: function (v) { return v === 100; } }
    ];
    function bucketOf(v) { for (var i = 0; i < BUCKETS.length; i++) if (BUCKETS[i].test(v)) return BUCKETS[i].k; return null; }
    function pct(x, t) { return t ? (x / t * 100) : 0; }
    // one 100% bar: counts per bucket; hover names the bucket and its share
    function splitBar(cnt, total, unit) {
        if (!total) return '<div class="sp-bar sp-empty">none</div>';
        return '<div class="sp-bar">' + BUCKETS.map(function (b) {
            var v = cnt[b.k] || 0, w = pct(v, total);
            return v ? '<span class="sp-' + b.k + '" style="flex:' + v + '" title="' + esc(b.label + ': ' + fmtN(v) + ' ' + unit + ' (' + w.toFixed(1) + '%)') + '">' +
                (w >= 7 ? w.toFixed(0) + '%' : '') + '</span>' : '';
        }).join('') + '</div>';
    }
    function fmtN(x) { return Number(x).toLocaleString('en', { maximumFractionDigits: 0 }); }
    function renderSplit() {
        var h = '';
        var legend = '<div class="sp-legend">' + BUCKETS.map(function (b) { return '<span><i class="sp-' + b.k + '"></i>' + b.label + '</span>'; }).join('') + '</div>';
        // 1. every player
        var all = {}, nAll = 0;
        _players.forEach(function (p) { var k = bucketOf(Number(p.landowner_tlm_share)); if (k) { all[k] = (all[k] || 0) + 1; nAll++; } });
        h += '<section class="sp-sec"><h3>All players <small>' + fmtN(nAll) + ' signed up</small></h3>' + legend + splitBar(all, nAll, 'players') +
            '<div class="sp-counts">' + BUCKETS.map(function (b) { return '<span>' + b.label + ': <b>' + fmtN(all[b.k] || 0) + '</b></span>'; }).join('') + '</div></section>';

        // the boost floor the rest of this view uses
        var mx = _minX + 'x', minBoost = _minX * BOOST_X;
        h += '<div class="sp-floor"><span class="sp-lab">Min boost</span>' + BOOST_STEPS.map(function (x) {
            return '<button class="bld-pill' + (x === _minX ? ' on' : '') + '" data-minx="' + x + '">' + x + 'x</button>';
        }).join('') + '<small>everything below uses buildings boosted ' + mx + ' or more</small></div>';
        // 2. owners with at least one building boosted that much
        // follows the planet / building / search filters above
        var boosted = visible().filter(function (r) { return r.boost >= minBoost && r.owner; });
        var owners = {}, byOwner = {}, byBoost = {}, totBoost = 0, noProfile = 0, tlmW = 0;
        boosted.forEach(function (r) { (owners[r.owner] = owners[r.owner] || []).push(r); });
        Object.keys(owners).forEach(function (w) {
            var v = _share[w];
            if (v == null) { noProfile++; return; }
            var k = bucketOf(v);
            byOwner[k] = (byOwner[k] || 0) + 1;
            owners[w].forEach(function (r) { byBoost[k] = (byBoost[k] || 0) + r.boost; totBoost += r.boost; tlmW += r.boost * v / 100; });
        });
        var nOwn = Object.keys(owners).length - noProfile;
        h += '<section class="sp-sec"><h3>Land owners with a building boosted ' + mx + ' or more <small>' + fmtN(nOwn) + ' owners, ' + fmtN(boosted.length) + ' buildings</small></h3>' +
            '<div class="sp-row"><span class="sp-lab">By owner</span>' + splitBar(byOwner, nOwn, 'owners') + '</div>' +
            '<div class="sp-row"><span class="sp-lab">By boost</span>' + splitBar(byBoost, totBoost, 'boost') + '</div>' +
            '<p class="sp-key">Of all that boost, <b class="sp-tlm">' + pct(tlmW, totBoost).toFixed(1) + '%</b> is set to earn TLM and <b class="sp-shd">' +
            (100 - pct(tlmW, totBoost)).toFixed(1) + '%</b> shards (each owner\u2019s buildings weighted by boost and split by their setting).' +
            (noProfile ? ' ' + fmtN(noProfile) + ' owner' + (noProfile === 1 ? ' has' : 's have') + ' no player profile, so no setting, and ' + (noProfile === 1 ? 'is' : 'are') + ' left out.' : '') + '</p></section>';

        // 3. by land type, and by building type, for those boosted buildings
        // by building / land type, measured by boost: total and average x, the owners' settings
        // weighted by boost, and how the buildings spread over 1x bands up to 10x
        var group = function (keyFn, title) {
            var g = {};
            boosted.forEach(function (r) {
                var v = _share[r.owner]; if (v == null) return;
                var k = keyFn(r), x = g[k] = g[k] || { wb: {}, n: 0, boost: 0, tlmW: 0, tlm: 0, shards: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
                var b = bucketOf(v), bx = r.boost / BOOST_X;
                x.wb[b] = (x.wb[b] || 0) + r.boost; x.n++; x.boost += r.boost; x.tlmW += r.boost * v / 100; x.tlm += r.tlm; x.shards += r.shards;
                x.bands[Math.min(9, Math.floor(bx))]++;
            });
            var keys = Object.keys(g).sort(function (a, b) { return g[b].boost - g[a].boost; });
            var bandMax = 1;
            keys.forEach(function (k) { g[k].bands.forEach(function (c) { if (c > bandMax) bandMax = c; }); });
            var spread = function (bands) {
                return '<div class="sp-bands">' + bands.map(function (c, i) {
                    return '<i title="' + i + '\u2013' + (i + 1) + 'x: ' + c + ' building' + (c === 1 ? '' : 's') + '" style="height:' + (c ? Math.max(8, c / bandMax * 100) : 0).toFixed(0) + '%"></i>';
                }).join('') + '</div><div class="sp-bands-ax"><span>0x</span><span>5x</span><span>10x</span></div>';
            };
            return '<section class="sp-sec"><h3>' + title + '</h3><div class="bld-wrap"><table class="bld-table sp-table"><thead><tr><th class="txt">' +
                (title.indexOf('land') >= 0 ? 'Land type' : 'Building') + '</th><th class="num">Total boost</th><th class="num">Average</th><th class="txt">Boost spread</th>' +
                '<th class="txt">Owners\u2019 settings, by boost</th><th class="num">Boost set to TLM</th>' +
                '<th class="num">TLM to claim</th><th class="num">Shards since last claim</th></tr></thead><tbody>' +
                keys.map(function (k) {
                    var x = g[k];
                    return '<tr><td class="txt">' + esc(k) + ' <small>' + fmtN(x.n) + '</small></td><td class="num">' + num(x.boost / BOOST_X, 1) + 'x</td>' +
                        '<td class="num">' + num(x.boost / BOOST_X / x.n, 2) + 'x</td><td class="txt sp-spread">' + spread(x.bands) + '</td>' +
                        '<td class="txt sp-cell">' + splitBar(x.wb, x.boost, 'boost') + '</td>' +
                        '<td class="num">' + pct(x.tlmW, x.boost).toFixed(0) + '%</td><td class="num">' + fmtN(x.tlm) + '</td><td class="num">' + fmtN(x.shards) + '</td></tr>';
                }).join('') + '</tbody></table></div></section>';
        };
        h += renderPools();
        h += group(function (r) { return r.type.charAt(0).toUpperCase() + r.type.slice(1); }, 'By building <small>buildings boosted ' + mx + ' or more</small>');
        h += group(function (r) { return r.landType; }, 'By land type <small>buildings boosted ' + mx + ' or more</small>');
        h += '<p class="bld-note">The split setting comes from each player\u2019s profile (players.ale: landowner_tlm_share, the % taken as TLM). ' +
            'Boost multipliers are boost score \u00f7 100,000 (a new building starts at 3.5x). TLM to claim is what waits in those buildings for their owners; ' +
            'shards are paid to the owner on every visit, so that column is what they have earned since their last claim. Together they show where payouts are landing.</p>';
        return h;
    }

    /* ── Lands for sale (hidden: Buildings clicked 5 times) ─────────────────────
       Lands whose buildings hold TLM to claim, with any active AtomicHub listing
       of the land NFT. Listings come from atomicmarket sales, state 1 (listed). */
    var FS = { sales: null, busy: false, onlyListed: false, err: '' };
    var MARKET = ['https://wax.api.atomicassets.io', 'https://wax-aa.eu.eosamsterdam.net', 'https://wax-atomic-api.eosphere.io'];
    async function loadSales(ids) {
        FS.busy = true; FS.err = '';
        var out = {};
        for (var i = 0; i < ids.length; i += 100) {
            var chunk = ids.slice(i, i + 100).join(','), ok = false;
            for (var k = 0; k < MARKET.length && !ok; k++) {
                try {
                    var r = await fetch(MARKET[k] + '/atomicmarket/v2/sales?state=1&asset_id=' + chunk + '&limit=100', { signal: AbortSignal.timeout(15000) });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    var j = await r.json();
                    (j.data || []).forEach(function (x) {
                        var price = Number(x.price.amount) / Math.pow(10, x.price.token_precision);
                        (x.assets || []).forEach(function (a) {
                            out[a.asset_id] = { id: x.sale_id, price: price, sym: x.price.token_symbol, seller: x.seller, bundle: (x.assets || []).length };
                        });
                    });
                    ok = true;
                } catch (e) {}
            }
            if (!ok) FS.err = 'Some listings could not be checked (the AtomicHub API did not answer).';
        }
        FS.sales = out; FS.busy = false;
        if (_view === 'forsale') render();
    }
    function renderForSale() {
        var lands = {}, list = [];
        visible().forEach(function (r) {
            if (!r.assetId || r.assetId === '0') return;
            var l = lands[r.assetId] = lands[r.assetId] || { assetId: r.assetId, planet: r.planet, x: r.x, y: r.y, landId: r.landId, land: r.land,
                owner: r.owner, tag: r.tag, tlm: 0, types: [] };
            l.tlm += r.tlm || 0; l.types.push(r.type);
        });
        Object.keys(lands).forEach(function (k) { if (lands[k].tlm > 0) list.push(lands[k]); });
        if (!FS.sales && !FS.busy) loadSales(list.map(function (l) { return l.assetId; }));
        var listed = list.filter(function (l) { return FS.sales && FS.sales[l.assetId]; });
        list.sort(function (a, b) {
            var sa = FS.sales && FS.sales[a.assetId] ? 1 : 0, sb = FS.sales && FS.sales[b.assetId] ? 1 : 0;
            return sb - sa || b.tlm - a.tlm;
        });
        if (FS.onlyListed) list = list.filter(function (l) { return FS.sales && FS.sales[l.assetId]; });
        var h = '<section class="sp-sec fs-sec"><h3>Lands for sale with TLM waiting <small>' + (FS.busy ? 'checking AtomicHub listings…' :
                fmtN(listed.length) + ' listed of ' + fmtN(Object.keys(lands).filter(function (k) { return lands[k].tlm > 0; }).length) + ' lands holding TLM') + '</small></h3>' +
            '<div class="sp-floor"><button class="bld-pill' + (FS.onlyListed ? '' : ' on') + '" data-fsl="0">All lands with TLM</button>' +
            '<button class="bld-pill' + (FS.onlyListed ? ' on' : '') + '" data-fsl="1">Only listed</button>' +
            '<button class="bld-pill" data-fsr="1"' + (FS.busy ? ' disabled' : '') + '>Recheck listings</button></div>' +
            (FS.err ? '<p class="sp-key" style="color:#ff9b88">' + esc(FS.err) + '</p>' : '') +
            '<div class="bld-wrap"><table class="bld-table"><thead><tr><th class="txt">Land</th><th class="txt">Type</th><th class="txt">Buildings</th><th class="txt">Owner</th>' +
            '<th class="num">TLM to claim</th><th class="num">Listed for</th><th class="txt"></th></tr></thead><tbody>' +
            (list.length ? list.map(function (l) {
                var sale = FS.sales && FS.sales[l.assetId];
                return '<tr' + (sale ? ' class="fs-listed"' : '') + '><td class="txt">' + esc(l.planet) + ' ' + l.x + ',' + l.y + ' <small>' + esc(l.landId) + '</small></td>' +
                    '<td class="txt">' + esc(l.land) + '</td><td class="txt">' + esc(l.types.join(', ')) + '</td>' +
                    '<td class="txt">' + (l.tag ? esc(l.tag) + ' <small>' + esc(l.owner) + '</small>' : esc(l.owner) || '–') + '</td>' +
                    '<td class="num">' + num(l.tlm, 2) + '</td>' +
                    '<td class="num">' + (sale ? '<b>' + num(sale.price, 2) + ' ' + esc(sale.sym) + '</b>' + (sale.bundle > 1 ? ' <small>bundle of ' + sale.bundle + '</small>' : '')
                        : FS.sales ? '<span class="bld-dim">not listed</span>' : '…') + '</td>' +
                    '<td class="txt">' + (sale ? '<a class="fs-link" href="https://atomichub.io/market/sale/wax-mainnet/' + encodeURIComponent(sale.id) + '" target="_blank" rel="noopener">View on AtomicHub &#8599;</a>' : '') + '</td></tr>';
            }).join('') : '<tr><td colspan="7" class="bld-empty">No lands with TLM waiting match these filters.</td></tr>') +
            '</tbody></table></div>' +
            '<p class="bld-note">TLM to claim is what the buildings on that land hold for their owner. Land rewards appear to be claimed by whoever owns the land ' +
            'when they are claimed, so a buyer would likely receive it, but that is not confirmed on chain: check before you buy. Listings are live AtomicHub sales of the land NFT.</p></section>';
        return h;
    }
    window.aleBuildingsSecret = function () { _view = _view === 'forsale' ? 'table' : 'forsale'; FS.sales = null; render(); };

    function render() {
        var el = document.getElementById('bld-view');
        if (!el) return;
        var btn = function (grp, val, label, cur) {
            return '<button class="bld-pill' + (cur === val ? ' on' : '') + '" data-' + grp + '="' + val + '">' + label + '</button>';
        };
        var counts = { dungeon: 0, arena: 0, tavern: 0 };
        (_rows || []).forEach(function (r) { counts[r.type] = (counts[r.type] || 0) + 1; });

        var h = '<div class="bld-bar">' +
            btn('view', 'table', 'Buildings', _view) + btn('view', 'split', 'TLM / shard split', _view) + '<span class="bld-sep"></span>' +
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
            '<p class="bld-note">Owner is whoever holds the land NFT the building stands on. Boost is shown as the in-game multiplier ' +
            '(boost score ÷ 100,000). Boost now is an estimate: it decays about ' + (DECAY_PER_HOUR * 24 / 100000).toFixed(3) + 'x a day and also as the building earns. Fights per day and unique visitors cover the ' +
            (_fightsFor === 168 ? 'last 7 days' : 'last 24 hours') + '. Hires and reveals don&rsquo;t record which tavern they ' +
            'were at, so taverns show how many players have them as an active tavern instead. TLM, credits and gems wait in the ' +
            'building until the owner claims them; shards are paid to the owner on every visit, so the shards figure is what it has ' +
            'earned since the last claim.</p>';

        if (!_rows) {
            el.innerHTML = h + '<div class="bld-empty">Loading…</div>';
            bind(el);
            return;
        }
        if (_view === 'split') { el.innerHTML = h + renderSplit(); bind(el); return; }
        if (_view === 'forsale') { el.innerHTML = h + renderForSale(); bind(el); return; }
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
        el.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { _view = b.getAttribute('data-view'); render(); }; });
        el.querySelectorAll('[data-minx]').forEach(function (b) { b.onclick = function () { _minX = Number(b.getAttribute('data-minx')); render(); }; });
        el.querySelectorAll('[data-fsl]').forEach(function (b) { b.onclick = function () { FS.onlyListed = b.getAttribute('data-fsl') === '1'; render(); }; });
        el.querySelectorAll('[data-fsr]').forEach(function (b) { b.onclick = function () { FS.sales = null; render(); }; });
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
        var head = ['building', 'planet', 'x', 'y', 'land_id', 'land', 'owner_tag', 'owner_wallet', 'boost_x_now_est',
                    'last_boost_utc', 'last_boost_by', 'last_boost_target_x', 'fights_per_day', 'unique_visitors', 'window_hours',
                    'tavern_users', 'tlm', 'shards', 'credits', 'gems', 'unclaimed_since_utc'];
        var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        var lines = [head.join(',')].concat(visible().map(function (r) {
            return [r.type, r.planet, r.x, r.y, r.landId, r.land, r.tag, r.owner, (r.boost / 100000).toFixed(2),
                    r.lastBoost ? iso(r.lastBoost.t) : '', r.lastBoost ? r.lastBoost.by : '', r.lastBoost ? (Number(r.lastBoost.target) / 100000).toFixed(2) : '',
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
