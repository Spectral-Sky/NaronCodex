/* ── PLANETARY DEFENSE V3 PORTAL (miss.pdef.html) ─────────────────────────────
   A wallet's divisions and the full V3 loop around them:
     Divisions     what each division is on, when it's free, its best mission,
                   claim-and-resend one at a time or all in one signature, and
                   each division's cards as a deck (warlord face, units below)
     Stake & build stake and unstake NFTs, create divisions, add units with gear,
                   remove units and gear
     Forge & shop  forge level, the next unlock and its cost, the forge shop

   How V3 works, as read from chain (Oct 2026):
     core.pdef  divisions / divunits / divlocks / stakes / balances, scoped by owner;
                players (forge level) and assetstats (what each template is) at core.pdef
     miss.pdef  missions, entrycosts, rewardcfgs, rewardpools
     NFT categories (assetstats.category): 0 warlord · 1 mercenary · 2 equipment ·
                3 supplies · 4 creature · 5 services (Lava Lux, stat multipliers);
                each template has a minimum forge level to stake
     staking    atomicassets::transfer to core.pdef, memo "stake"
     unstake    core.pdef::unstake (one asset; returns it at once)
     divisions  creatediv(leader) · assign(unit + optional gear) ·
                unassign(one piece of gear) · removeunit(a whole unit)
     missions   a resend is miss.pdef::claim then miss.pdef::join; the entry fee is
                taken from the in-game balance by the contracts. A run locks the
                division for cooldown_base_sec + 10 s × its move cost (exact on all
                77 live locks checked)
     forge      TLM to forge.pdef, memo "forge:<level>"; shop: price token to
                forge.pdef, memo "shop:<item id>"
   Prices are the page's own live Alcor figures; NFT prices are the AtomicMarket
   median sale per template. */
(function () {
    'use strict';

    var RPC = ['https://wax.greymass.com', 'https://api.wax.alohaeos.com', 'https://wax.eosusa.io'];
    var AA = 'https://wax.api.atomicassets.io';
    var COLLECTION = 'planetdefnft';
    var MOVE_S_PER_POINT = 10;
    var CAT = ['Warlord', 'Mercenary', 'Equipment', 'Supplies', 'Creature', 'Lava Lux'];
    var GEAR = [['creature', 4], ['weapon', 2], ['supply', 3], ['lavalux', 5]];   // divunits field, category

    var S = { wallet: '', own: false, loading: false, data: null, pick: {}, idleToBest: true, msg: '',
              mode: 'same', tab: 'divs', open: {}, qty: {}, catFilter: -1, form: {}, b: null, pending: null };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function utc(s) { return Date.parse(String(s).replace(/Z?$/, 'Z')); }
    function amt(a) { var p = String(a || '').split(' '); return { n: parseFloat(p[0]) || 0, sym: p[1] || '' }; }
    function n(x, d) { return Number(x).toLocaleString('en', { maximumFractionDigits: d == null ? 0 : d }); }
    function dur(sec) {
        sec = Math.max(0, Math.round(sec));
        var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
        return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m ? m + 'm ' + String(s).padStart(2, '0') + 's' : s + 's';
    }
    function me() {
        return (window.walletSession ? String(window.walletSession.actor) : '') ||
               (window._pdWcw && window._pdWcw.userAccount) || localStorage.getItem('naron_wallet') || '';
    }
    function canSign() { return !!(window.walletSession || (window._pdWcw && window._pdWcw.api)); }
    function signable() { return S.own && canSign(); }
    /* Card art comes from IPFS. Checked Oct 2026: the AtomicHub resizer was returning
       500, and ipfs.io / dweb.link / nftstorage rate-limit; ipfs.alienworlds.io and
       pinata serve full 1 MB PNGs. wsrv.nl in front of ipfs.alienworlds.io shrinks a
       card to ~10 KB, so it goes first and each failure falls to the next source. */
    var IMG_SOURCES = [
        function (h, w) { return 'https://wsrv.nl/?url=ipfs.alienworlds.io/ipfs/' + h + '&w=' + w + '&output=webp'; },
        function (h, w) { return 'https://resizer.atomichub.io/images/v1/preview?ipfs=' + h + '&size=' + (w > 200 ? 370 : 200); },
        function (h) { return 'https://ipfs.alienworlds.io/ipfs/' + h; },
        function (h) { return 'https://gateway.pinata.cloud/ipfs/' + h; }
    ];
    function img(hash, size) { return hash ? IMG_SOURCES[0](hash, size || 370) : ''; }
    function imgTag(hash, size, cls) {
        if (!hash) return '';
        return '<img loading="lazy"' + (cls ? ' class="' + cls + '"' : '') + ' src="' + img(hash, size) + '" data-h="' + hash +
               '" data-w="' + (size || 370) + '" data-i="0" onerror="pdImgNext(this)" alt="">';
    }
    window.pdImgNext = function (el) {
        var i = Number(el.getAttribute('data-i')) + 1;
        if (i >= IMG_SOURCES.length) { el.onerror = null; el.style.visibility = 'hidden'; return; }
        el.setAttribute('data-i', i);
        el.src = IMG_SOURCES[i](el.getAttribute('data-h'), Number(el.getAttribute('data-w')));
    };

    // the page keeps these as top-level `let`: readable by name from here, not via window
    function pg() {
        return {
            defPrice: typeof defPrice !== 'undefined' ? defPrice : 0,
            defInTlm: typeof defInTlm !== 'undefined' ? defInTlm : null,
            tlmInWax: typeof tlmInWax !== 'undefined' ? tlmInWax : null,
            waxInUsd: typeof waxInUsd !== 'undefined' ? waxInUsd : null,
            valueIn: typeof valueIn !== 'undefined' ? valueIn : 'tlm',
            allMissions: typeof allMissions !== 'undefined' ? allMissions : []
        };
    }

    /* ── chain reads ────────────────────────────────────────────────────────── */
    async function post(path, body) {
        for (var i = 0; i < RPC.length; i++) {
            try {
                var r = await fetch(RPC[i] + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
                                                     body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
                if (r.ok) return await r.json();
            } catch (e) { /* next node */ }
        }
        throw new Error('chain unreachable');
    }
    async function table(code, scope, tbl) {
        var out = [], lb = '';
        for (var p = 0; p < 10; p++) {
            var d = await post('/v1/chain/get_table_rows', { json: true, code: code, scope: scope, table: tbl, limit: 500, lower_bound: lb || undefined });
            out = out.concat(d.rows || []);
            if (!d.more) break;
            lb = d.next_key;
        }
        return out;
    }
    async function bal(code, acct, sym) {
        try { var r = await post('/v1/chain/get_currency_balance', { code: code, account: acct, symbol: sym }); return amt((r || [])[0]).n; }
        catch (e) { return null; }
    }
    async function aaGet(path) {
        var r = await fetch(AA + path, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('AtomicAssets ' + r.status);
        return r.json();
    }
    // staked assets are held by core.pdef, so their details are fetched by id
    async function assetsById(ids) {
        var out = {};
        for (var i = 0; i < ids.length; i += 100) {
            try {
                var j = await aaGet('/atomicassets/v1/assets?ids=' + ids.slice(i, i + 100).join(',') + '&limit=100');
                (j.data || []).forEach(function (a) { out[a.asset_id] = a; });
            } catch (e) { /* cards fall back to ids */ }
        }
        return out;
    }
    async function walletAssets(w) {
        var out = [];
        for (var p = 1; p <= 10; p++) {
            var j = await aaGet('/atomicassets/v1/assets?owner=' + w + '&collection_name=' + COLLECTION + '&limit=500&page=' + p);
            out = out.concat(j.data || []);
            if ((j.data || []).length < 500) break;
        }
        return out;
    }
    async function templatePrices() {
        var out = {};
        for (var p = 1; p <= 5; p++) {
            try {
                var j = await aaGet('/atomicmarket/v1/prices/templates?collection_name=' + COLLECTION + '&limit=100&page=' + p);
                (j.data || []).forEach(function (t) {
                    if (t.token_symbol === 'WAX') out[t.template_id] = Number(t.median) / Math.pow(10, t.token_precision || 8);
                });
                if ((j.data || []).length < 100) break;
            } catch (e) { break; }
        }
        return out;
    }

    async function load(wallet) {
        S.loading = true; S.wallet = wallet; S.own = !!wallet && wallet === me(); S.msg = ''; S.qty = {}; if (S.b) S.b.targets = null;
        render();
        try {
            var got = await Promise.all([
                table('core.pdef', wallet, 'divisions'), table('core.pdef', wallet, 'divunits'),
                table('core.pdef', wallet, 'divlocks'), table('core.pdef', wallet, 'balances'),
                post('/v1/chain/get_table_rows', { json: true, code: 'core.pdef', scope: 'core.pdef', table: 'players', lower_bound: wallet, upper_bound: wallet, limit: 1 }),
                table('miss.pdef', 'miss.pdef', 'missions'), table('miss.pdef', 'miss.pdef', 'entrycosts'),
                table('miss.pdef', 'miss.pdef', 'rewardcfgs'), table('miss.pdef', 'miss.pdef', 'rewardpools'),
                bal('defensetoken', wallet, 'DEF'), bal('alien.worlds', wallet, 'TLM'),
                table('core.pdef', wallet, 'stakes'), table('core.pdef', 'core.pdef', 'assetstats'),
                walletAssets(wallet).catch(function () { return []; }), templatePrices(),
                table('forge.pdef', 'forge.pdef', 'forgelvls'), table('forge.pdef', 'forge.pdef', 'shopitems'),
                table('forge.pdef', 'forge.pdef', 'shopcats'), table('forge.pdef', 'forge.pdef', 'itemcats'),
                table('forge.pdef', wallet, 'powerups'),
                table('miss.pdef', 'miss.pdef', 'shardrews').catch(function () { return []; }),
                table('miss.pdef', 'miss.pdef', 'shardcaps').catch(function () { return []; })
            ]);
            var d = {
                divs: got[0], units: got[1], locks: got[2], inGame: got[3].map(function (b) { return b.balance; }),
                forge: (got[4].rows && got[4].rows[0]) ? Number(got[4].rows[0].forge_level) : null,
                missions: {}, costs: {}, cfgs: {}, pools: {}, defBal: got[9], tlmBal: got[10],
                stakes: got[11], stats: {}, wallet: got[13], prices: got[14],
                forgeLvls: got[15], shopItems: got[16], shopCats: {}, itemCat: {}, assets: {}, owned: {}
            };
            got[19].forEach(function (p) { d.owned[p.powerup_id] = Number(p.amount) || 0; });
            d.shards = {}; d.shardLeft = {};
            got[20].forEach(function (r) { d.shards[r.reward_config_id] = Number(r.shard_reward) / 10; });   // stored in tenths
            got[21].forEach(function (c) { d.shardLeft[c.mission_id] = Math.max(0, Number(c.max_joins) - Number(c.joins_consumed)); });
            got[5].forEach(function (m) { var meta = {}; try { meta = JSON.parse(m.meta || '{}'); } catch (e) {} m._meta = meta; d.missions[m.mission_id] = m; });
            got[6].forEach(function (c) { d.costs[c.mission_id] = amt(c.cost); });
            got[7].forEach(function (c) { d.cfgs[c.reward_config_id] = c; });
            got[8].forEach(function (p) { d.pools[p.mission_id] = p; });
            got[12].forEach(function (s) { d.stats[s.template_id] = s; });
            got[17].forEach(function (c) { d.shopCats[c.category_id] = c; });
            got[18].forEach(function (c) { d.itemCat[c.item_id] = c.category_id; });

            d.wallet.forEach(function (a) { d.assets[a.asset_id] = a; });
            var ids = {};
            d.divs.forEach(function (x) { ids[x.leader_asset_id] = 1; });
            d.units.forEach(function (u) { ['unit', 'creature', 'weapon', 'supply', 'lavalux'].forEach(function (k) { ids[u[k + '_asset_id']] = 1; }); });
            d.stakes.forEach(function (s) { ids[s.asset_id] = 1; });
            var need = Object.keys(ids).filter(function (id) { return id && id !== '0' && !d.assets[id]; });
            var fetched = await assetsById(need);
            Object.keys(fetched).forEach(function (k) { d.assets[k] = fetched[k]; });
            S.data = d;
        } catch (e) {
            S.data = null;
            S.msg = 'Could not read this wallet: ' + e.message;
        }
        S.loading = false;
        render();
    }

    function card(id) {
        var d = S.data, a = d.assets[id] || {};
        var tpl = a.template ? Number(a.template.template_id) : 0;
        var st = d.stats[tpl] || {};
        var data = a.data || (a.template && a.template.immutable_data) || {};
        return {
            id: String(id), tpl: tpl, name: data.name || a.name || ('#' + id), img: data.img || data.image || '',
            cat: st.category != null ? Number(st.category) : null, atk: Number(st.attack || 0), def: Number(st.defense || 0),
            move: Number(st.movecost || 0), slots: Number(st.slots_max || 0), forge: Number(st.min_forge_level || 0),
            red: Number(st.movecost_reduction || 0), am: Number(st.attack_mult_bp || 0), dm: Number(st.defense_mult_bp || 0),
            mm: Number(st.movecost_mult_bp || 0), price: d.prices[tpl] || null, known: st.category != null
        };
    }

    /* ── economics ──────────────────────────────────────────────────────────── */
    function toTlm(x, sym) {
        var p = pg();
        if (!x) return 0;
        if (sym === 'TLM') return x;
        if (sym === 'DEF') return x * (p.defPrice || p.defInTlm || 0);
        if (sym === 'WAX') return p.tlmInWax ? x / p.tlmInWax : 0;
        return 0;
    }
    function show(tlm) {
        var p = pg(), v = p.valueIn;
        if (v === 'tlm') return n(tlm, 2) + ' TLM';
        if (v === 'def') return p.defInTlm ? n(tlm / p.defInTlm, 3) + ' DEF' : '–';
        if (v === 'wax') return p.tlmInWax ? n(tlm * p.tlmInWax, 2) + ' WAX' : '–';
        if (v === 'usd') return (p.tlmInWax && p.waxInUsd) ? '$' + n(tlm * p.tlmInWax * p.waxInUsd, 3) : '–';
        return n(tlm, 2);
    }
    // shards are paid on top of the reward until the mission's shard joins run out; no market price, so no TLM value
    function shardLabel(m, d) {
        var sh = d.shards && d.shards[m.reward_config_id];
        if (!sh) return '';
        var left = d.shardLeft[m.mission_id];
        return ' + ' + n(sh, 1) + ' shards' + (left === 0 ? ' (shard cap reached)' : left != null ? ' (' + n(left) + ' joins left)' : '');
    }
    function rewardFor(m, div, d) {
        var r = rewardBase(m, div, d);
        r.label += shardLabel(m, d);
        return r;
    }
    function rewardBase(m, div, d) {
        var cfg = d.cfgs[m.reward_config_id];
        if (!cfg) return { tlm: 0, label: '–' };
        if (cfg.nft_reward_count > 0) {
            var parsed = pg().allMissions.find(function (x) { return x.id === m.mission_id; });
            var wax = parsed && parsed.chestFloorWax ? parsed.chestFloorWax * cfg.nft_reward_count : 0;
            return { tlm: toTlm(wax, 'WAX'), est: true, label: cfg.nft_reward_count + ' chest' + (cfg.nft_reward_count > 1 ? 's' : '') };
        }
        var tier = null;
        (cfg.tiers || []).forEach(function (t) { if (Number(div.atk_cached) >= Number(t.min_atk || 0) && (!tier || Number(t.min_atk) >= Number(tier.min_atk))) tier = t; });
        if (!tier) return { tlm: 0, label: 'below every reward tier' };
        var a = amt(tier.reward_asset);
        return { tlm: toTlm(a.n, a.sym), label: n(a.n, a.sym === 'DEF' ? 3 : 2) + ' ' + a.sym };
    }
    // per hour, with ~ when the reward is chests (valued at the market floor, so an estimate)
    function perH(e) { return (e.reward && e.reward.est ? '~' : '') + show(e.perHour); }
    function evaluate(m, div, d) {
        var ok = m.status === 1 && utc(m.end_base) > Date.now() &&
                 Number(div.atk_cached) >= Number(m.min_div_attack || 0) &&
                 Number(div.def_cached) >= Number(m.min_div_defense || 0);
        var pool = d.pools[m.mission_id];
        if (pool && amt(pool.tlm_pool).n <= 0 && Number(pool.shards_pool || 0) <= 0 && !(pool.nft_asset_ids || []).length) ok = false;
        var rw = rewardFor(m, div, d), cost = d.costs[m.mission_id] || { n: 0, sym: '' };
        var secs = Number(m.cooldown_base_sec || 0) + MOVE_S_PER_POINT * Number(div.movecost_cached || 0);
        var net = rw.tlm - toTlm(cost.n, cost.sym);
        return { m: m, ok: ok, reward: rw, cost: cost, secs: secs, net: net, perHour: secs ? net / (secs / 3600) : 0 };
    }
    function divisionState(div, d) {
        var lock = d.locks.find(function (l) { return String(l.division_id) === String(div.division_id); });
        var until = lock ? utc(lock.locked_until) : 0;
        var opts = Object.keys(d.missions).map(function (k) { return evaluate(d.missions[k], div, d); })
            .filter(function (e) { return e.ok; }).sort(function (a, b) { return b.perHour - a.perHour; });
        var cur = lock && d.missions[lock.mission_id] ? evaluate(d.missions[lock.mission_id], div, d) : null;
        return {
            div: div, lock: lock, until: until,
            status: !lock ? 'idle' : until <= Date.now() ? 'ready' : 'running',
            units: d.units.filter(function (u) { return String(u.division_id) === String(div.division_id); }),
            cur: cur, opts: opts, best: opts[0] || null
        };
    }
    function target(st) {
        var p = S.pick[st.div.division_id];
        if (p && st.opts.some(function (o) { return String(o.m.mission_id) === String(p); })) return Number(p);
        if (S.mode === 'same' && st.cur && st.cur.ok) return Number(st.lock.mission_id);
        return st.best ? Number(st.best.m.mission_id) : (st.cur && st.cur.ok ? Number(st.lock.mission_id) : null);
    }
    function states() { return S.data.divs.map(function (x) { return divisionState(x, S.data); }); }

    /* ── signing ────────────────────────────────────────────────────────────── */
    async function sign(actions) {
        if (window.walletSession) return window.walletSession.transact({ actions: actions });
        if (window._pdWcw && window._pdWcw.api) return window._pdWcw.api.transact({ actions: actions }, { blocksBehind: 3, expireSeconds: 60 });
        throw new Error('Connect your wallet first.');
    }
    function act(account, name, data) {
        return { account: account, name: name, authorization: [{ actor: S.wallet, permission: 'active' }], data: data };
    }
    function plan(st) {
        var w = S.wallet, to = target(st);
        if (to == null) return null;
        var acts = [];
        if (st.status === 'ready') acts.push(act('miss.pdef', 'claim', { owner: w, mission_id: Number(st.lock.mission_id), division_id: Number(st.div.division_id) }));
        else if (st.status !== 'idle') return null;
        acts.push(act('miss.pdef', 'join', { owner: w, mission_id: to, division_ids: [Number(st.div.division_id)] }));
        return { acts: acts, to: to, fee: S.data.costs[to] || { n: 0, sym: '' } };
    }
    async function run(acts, label, fees) {
        if (!acts.length) return;
        S.msg = 'Waiting for your wallet… ' + label;
        render();
        try {
            await sign(acts);
            S.msg = '✓ ' + label + (fees && Object.keys(fees).length ? ' · entry fees ' +
                Object.keys(fees).map(function (k) { return n(fees[k], 4) + ' ' + k; }).join(' + ') : '');
            render();
            setTimeout(function () { load(S.wallet); }, 2500);
        } catch (e) {
            var raw = (e && e.message) || String(e);
            var m = raw.match(/assertion failure with message: ([^\n"]+)/i);
            S.msg = '✗ ' + (m ? m[1] : raw.slice(0, 180));
            render();
        }
    }
    function runPlans(plans, label) {
        var acts = [], fees = {};
        plans.forEach(function (p) { acts = acts.concat(p.acts); if (p.fee.n) fees[p.fee.sym] = (fees[p.fee.sym] || 0) + p.fee.n; });
        run(acts, label, fees);
    }

    /* ── cards ──────────────────────────────────────────────────────────────── */
    function cardHtml(c, opts) {
        opts = opts || {};
        var stats = [];
        if (c.atk) stats.push('ATK ' + n(c.atk));
        if (c.def) stats.push('DEF ' + n(c.def));
        if (c.move) stats.push('MOVE ' + n(c.move));
        if (c.cat === 0 && c.slots) stats.push(c.slots + ' slots');
        var size = opts.size || 'm';
        var many = opts.count > 1, picked = opts.pick ? S.qty[opts.pick] || 0 : 0;
        var cls = (opts.cls ? ' ' + opts.cls : '') + (many ? ' pdc-stack' : '') +
            (opts.pick ? (opts.disabled ? ' pdc-nopick' : ' pdc-pick') + (picked ? ' on' : '') : '');
        return '<div class="pdc pdc-' + size + cls + '"' + (opts.pick && !opts.disabled ? ' data-pick="' + opts.pick + '|' + (opts.count || 1) + '"' : '') + ' title="' +
            esc(c.name + (c.cat != null ? ' · ' + CAT[c.cat] : '') + (many ? ' · ' + opts.count + ' copies' : ' · #' + c.id)) + '">' +
            (many ? '<span class="pdc-count">×' + opts.count + '</span>' : '') +
            (picked ? '<span class="pdc-tick">✓</span>' : '') +
            '<div class="pdc-img">' + (c.img ? imgTag(c.img, size === 'l' ? 380 : size === 'xs' ? 100 : 220) : '<span>' + esc(c.name) + '</span>') + '</div>' +
            '<div class="pdc-name">' + esc(c.name) + '</div>' +
            (stats.length && size !== 'xs' ? '<div class="pdc-stats">' + stats.join(' · ') + '</div>' : '') +
            (size !== 'xs' && (c.price || c.forge) ? '<div class="pdc-meta">' + (c.price ? '≈ ' + n(c.price, c.price < 10 ? 2 : 0) + ' WAX' : '') +
                (c.forge ? ' <span class="pdc-forge' + (S.data.forge != null && c.forge > S.data.forge ? ' locked' : '') + '">forge ' + c.forge + '</span>' : '') + '</div>' : '') +
            (opts.pick && many && !opts.disabled ? '<div class="pdc-step"><button data-step="' + opts.pick + '|-1|' + opts.count + '"' + (picked ? '' : ' disabled') + '>−</button>' +
                '<span><b>' + picked + '</b> / ' + opts.count + '</span><button data-step="' + opts.pick + '|1|' + opts.count + '"' + (picked < opts.count ? '' : ' disabled') + '>+</button></div>' : '') +
            (opts.extra || '') + '</div>';
    }

    // identical cards (same template) shown as one stack; sec keeps wallet and staked picks apart
    function stacks(list, sec) {
        var by = {}, out = [];
        list.forEach(function (c) {
            var k = sec + ':' + (c.tpl || c.id);
            if (!by[k]) { by[k] = { key: k, top: c, ids: [] }; out.push(by[k]); }
            by[k].ids.push(c.id);
        });
        return out;
    }
    // selected staked warlords: none of them leads a division yet, so each can head a new one
    function pickedLeaders() {
        var free = inventory().free, ids = pickedIds(free, 'f');
        return ids.filter(function (id) { var c = free.find(function (x) { return x.id === id; }); return c && c.cat === 0; });
    }
    function pickedIds(list, sec) {
        var ids = [];
        stacks(list, sec).forEach(function (s) { ids = ids.concat(s.ids.slice(0, S.qty[s.key] || 0)); });
        return ids;
    }

    // a division as a deck: the warlord large, every unit below with its gear
    function deckHtml(st, withControls) {
        var x = st.div, ctl = withControls && signable();
        var lead = card(x.leader_asset_id);
        var units = st.units.map(function (u) {
            var gear = GEAR.map(function (g) {
                var gid = u[g[0] + '_asset_id'];
                if (!gid || gid === '0') return '';
                return cardHtml(card(gid), { size: 'xs', extra: ctl ? '<button class="pdc-x" data-unassign="' + x.division_id + '|' + u.unit_asset_id + '|' + gid + '" title="Take this off the unit">×</button>' : '' });
            }).join('');
            return '<div class="pdd-unit">' + cardHtml(card(u.unit_asset_id), { size: 's', extra: ctl ? '<button class="pdc-rm" data-removeunit="' + u.unit_asset_id + '">Remove unit</button>' : '' }) +
                (gear ? '<div class="pdd-gear">' + gear + '</div>' : '') + '</div>';
        }).join('');
        return '<div class="pdd-deck"><div class="pdd-face">' + cardHtml(lead, { size: 'l' }) +
            '<div class="pdd-face-stats">Division #' + x.division_id + '<br>ATK <b>' + n(x.atk_cached) + '</b> · DEF <b>' + n(x.def_cached) +
            '</b> · MOVE <b>' + n(x.movecost_cached) + '</b><br>' + st.units.length + ' of ' + x.slots_max + ' slots</div></div>' +
            '<div class="pdd-units">' + (units || '<div class="pdd-empty">No units yet.</div>') + '</div></div>';
    }

    /* ── views ──────────────────────────────────────────────────────────────── */
    function render() {
        var el = document.getElementById('pd-divs');
        if (!el) return;
        var mine = me();
        var h = '<div class="pdd-head"><span class="pdd-title">&#9672; My Planetary Defense</span>' +
            '<input id="pdd-wallet" type="text" placeholder="View any wallet…" value="' + esc(S.wallet) + '" spellcheck="false">' +
            '<button class="pdd-btn" id="pdd-view">View</button>' +
            (mine && mine !== S.wallet ? '<button class="pdd-btn" id="pdd-mine">My wallet</button>' : '') +
            (!canSign() ? '<button class="pdd-btn" id="pdd-wcw" title="Sign with WAX Cloud Wallet">&#9729; Cloud Wallet</button>' : '') +
            '<span class="pdd-mode">' + (S.wallet ? (signable() ? 'Signed in as ' + esc(S.wallet) : 'Read-only view of ' + esc(S.wallet)) : '') + '</span></div>';
        if (S.msg) h += '<div class="pdd-msg' + (/^✗|Could not/.test(S.msg) ? ' bad' : '') + '">' + esc(S.msg) + '</div>';
        if (!S.wallet) { el.innerHTML = h + '<div class="pdd-empty">Connect your wallet, or type any wallet above to see its divisions.</div>'; bind(el); return; }
        if (S.loading) { el.innerHTML = h + '<div class="pdd-empty">Reading divisions, stakes and cards from chain…</div>'; bind(el); return; }
        if (!S.data) { el.innerHTML = h; bind(el); return; }

        var tab = function (k, label) { return '<button class="pdd-tab' + (S.tab === k ? ' on' : '') + '" data-tab="' + k + '">' + label + '</button>'; };
        h += '<div class="pdd-tabs">' + tab('divs', 'Divisions (' + S.data.divs.length + ')') + tab('stake', 'Stake &amp; build') + tab('forge', 'Forge &amp; shop') + '</div>';
        h += S.tab === 'stake' ? stakeView() : S.tab === 'forge' ? forgeView() : divsView();
        el.innerHTML = h;
        bind(el);
    }

    function chip(k, v) { return '<div class="pdd-chip"><span>' + k + '</span><b>' + v + '</b></div>'; }

    function divsView() {
        var d = S.data;
        var all = states();
        var ready = all.filter(function (s) { return s.status === 'ready'; });
        var idle = all.filter(function (s) { return s.status === 'idle' && s.best; });
        var tAtk = 0, tDef = 0;
        d.divs.forEach(function (x) { tAtk += Number(x.atk_cached); tDef += Number(x.def_cached); });
        var bundle = ready.concat(S.idleToBest ? idle : []).map(plan).filter(Boolean);

        var h = '<div class="pdd-chips">' +
            chip('Forge level', d.forge == null ? '–' : d.forge) + chip('Divisions', d.divs.length) +
            chip('Total ATK', n(tAtk)) + chip('Total DEF', n(tDef)) +
            chip('Ready now', ready.length + (idle.length ? ' <small>+' + idle.length + ' idle</small>' : '')) +
            chip('Wallet DEF', d.defBal == null ? '–' : n(d.defBal, 3)) + chip('Wallet TLM', d.tlmBal == null ? '–' : n(d.tlmBal, 2)) +
            chip('In-game balance', d.inGame.length ? d.inGame.join(' · ') : 'none') + '</div>';
        if (!d.divs.length)
            return h + '<div class="pdd-empty">No divisions yet' + (d.forge != null ? ' (forge level ' + d.forge + ')' : '') +
                '. Use <b>Stake &amp; build</b> to stake a warlord and create one.</div>';

        h += '<div class="pdd-bundle">' +
            '<button class="pdd-go" id="pdd-all"' + (signable() && bundle.length ? '' : ' disabled') + '>&#10227; Claim &amp; resend all ready (' + bundle.length + ')</button>' +
            '<span class="pdd-seg"><span>Resend to</span>' +
                '<button class="pdd-segb' + (S.mode === 'same' ? ' on' : '') + '" data-mode="same">same mission</button>' +
                '<button class="pdd-segb' + (S.mode === 'best' ? ' on' : '') + '" data-mode="best">best mission</button></span>' +
            '<label class="pdd-chk"><input type="checkbox" id="pdd-idle"' + (S.idleToBest ? ' checked' : '') + '> also send idle divisions to their best mission</label>' +
            '<span class="pdd-hint">' + (signable() ? 'One signature for every division listed.' : (S.own ? 'Connect a wallet to sign.' : 'Viewing someone else’s wallet: buttons are off.')) + '</span></div>';

        h += '<div class="pdd-wrap"><table class="pdd-table"><thead><tr>' +
            '<th class="txt">Division</th><th class="num">Units</th><th class="num">ATK</th><th class="num">DEF</th><th class="num">Move</th>' +
            '<th class="txt">On mission</th><th class="txt">Status</th><th class="num">That mission / h</th><th class="txt">Best for it</th>' +
            '<th class="txt">Next mission (best / h first)</th><th class="txt"></th></tr></thead><tbody>';
        all.forEach(function (st) {
            var x = st.div, to = target(st), p = plan(st);
            var curM = st.lock ? d.missions[st.lock.mission_id] : null;
            var status = st.status === 'ready' ? '<span class="pdd-ready">READY</span>'
                : st.status === 'idle' ? '<span class="pdd-idle">idle</span>'
                : '<span class="pdd-run" data-until="' + st.until + '">' + dur((st.until - Date.now()) / 1000) + '</span>';
            var sel = '<select class="pdd-sel" data-div="' + x.division_id + '"' + (st.opts.length ? '' : ' disabled') + '>' +
                (st.opts.length ? st.opts.slice(0, 15).map(function (o) {
                    return '<option value="' + o.m.mission_id + '"' + (Number(o.m.mission_id) === to ? ' selected' : '') + '>' +
                        esc('#' + o.m.mission_id + ' ' + (o.m._meta.title || '') + ' · ' + perH(o) + '/h · ' + dur(o.secs)) + '</option>';
                }).join('') : '<option>no mission it qualifies for</option>') + '</select>';
            var actBtn = !signable() ? '' : st.status === 'running' ? '<button class="pdd-btn" disabled>busy</button>'
                : p ? '<button class="pdd-btn pdd-one" data-div="' + x.division_id + '">' + (st.status === 'ready' ? 'Claim &amp; resend' : 'Send') + '</button>' : '';
            var better = st.best && (!st.cur || st.best.perHour > st.cur.perHour + 0.01);
            var lead = card(x.leader_asset_id);
            h += '<tr class="pdd-row pdd-' + st.status + (S.open[x.division_id] ? ' open' : '') + '" data-open="' + x.division_id + '">' +
                '<td class="txt"><span class="pdd-caret">' + (S.open[x.division_id] ? '&#9662;' : '&#9656;') + '</span>' +
                (lead.img ? imgTag(lead.img, 80, 'pdd-thumb') : '') +
                '<b>#' + x.division_id + '</b> <small>' + esc(lead.name) + '</small></td>' +
                '<td class="num">' + st.units.length + '<small>/' + x.slots_max + '</small></td><td class="num">' + n(x.atk_cached) + '</td>' +
                '<td class="num">' + n(x.def_cached) + '</td><td class="num">' + n(x.movecost_cached) + '</td>' +
                '<td class="txt">' + (curM ? esc('#' + curM.mission_id + ' ' + (curM._meta.title || '')) + ' <small>' + esc(curM._meta.planet || '') + '</small>' : '<span class="pdd-dim">–</span>') + '</td>' +
                '<td class="txt">' + status + '</td><td class="num">' + (st.cur ? perH(st.cur) : '–') + '</td>' +
                '<td class="txt">' + (st.best ? '<span class="' + (better ? 'pdd-better' : 'pdd-same') + '" title="' +
                    esc((st.best.m._meta.title || '') + ' · reward ' + st.best.reward.label + ' · entry ' + (st.best.cost.n ? n(st.best.cost.n, 4) + ' ' + st.best.cost.sym : 'free') + ' · locks ' + dur(st.best.secs)) + '">#' +
                    st.best.m.mission_id + ' ' + perH(st.best) + '/h</span>' +
                    (st.cur && better && String(st.best.m.mission_id) !== String(st.lock.mission_id) ? ' <small>+' + (st.best.reward.est || st.cur.reward.est ? '~' : '') + show(st.best.perHour - st.cur.perHour) + '</small>' : '')
                    : '<span class="pdd-dim">none</span>') + '</td>' +
                '<td class="txt">' + sel + '</td><td class="txt">' + actBtn + '</td></tr>';
            if (S.open[x.division_id]) h += '<tr class="pdd-deckrow"><td colspan="11">' + deckHtml(st, true) + '</td></tr>';
        });
        return h + '</tbody></table></div>' +
            '<p class="pdd-note">Click a division to see its cards. A run locks the division for the mission’s base cooldown plus 10 s per point of move cost; ' +
            'per-hour values are the reward minus the entry fee over that time, at live Alcor prices, in the currency chosen above. ' +
            'Entry fees come out of the in-game balance.</p>';
    }

    function inventory() {
        var d = S.data, inDiv = {};
        d.divs.forEach(function (x) { inDiv[x.leader_asset_id] = x.division_id; });
        d.units.forEach(function (u) {
            ['unit', 'creature', 'weapon', 'supply', 'lavalux'].forEach(function (k) { var id = u[k + '_asset_id']; if (id && id !== '0') inDiv[id] = u.division_id; });
        });
        var wallet = d.wallet.map(function (a) { return card(a.asset_id); }).filter(function (c) { return c.known; });
        var free = [], used = [];
        d.stakes.forEach(function (s) {
            var c = card(s.asset_id);
            if (inDiv[s.asset_id] || (s.division_id && String(s.division_id) !== '0')) { c.div = inDiv[s.asset_id] || s.division_id; used.push(c); }
            else free.push(c);
        });
        return { wallet: wallet, free: free, used: used };
    }

    /* ── division builder ───────────────────────────────────────────────────────
       How core.pdef totals a division (matches atk/def/movecost_cached on every
       division checked): per unit, ATK and DEF are the mercenary + creature +
       equipment + supplies, times the Lava Lux multiplier, rounded down; its move
       is the mercenary's minus the gear's reductions, times Lava Lux's move
       multiplier. The division's move is the units' total minus the warlord's
       reduction, never below 0. Equipment, supplies and Lava Lux are capped per
       wallet by the slots bought in the forge shop. */
    var BGEAR = [['c', 'creature', 4, null], ['w', 'weapon', 2, 'eqpslot'], ['s', 'supply', 3, 'supslot'], ['l', 'lavalux', 5, 'lavaslot']];
    function unitTotals(u) {
        var a = u.m.atk, df = u.m.def, mv = u.m.move, red = 0;
        ['c', 'w', 's'].forEach(function (k) { if (u[k]) { a += u[k].atk; df += u[k].def; mv += u[k].move; red += u[k].red; } });
        mv = Math.max(0, mv - red);
        if (u.l) {
            a = Math.floor(a * (u.l.am || 10000) / 10000); df = Math.floor(df * (u.l.dm || 10000) / 10000);
            mv = Math.floor(mv * (u.l.mm || 10000) / 10000);
        }
        return { atk: a, def: df, move: mv };
    }
    function deckTotals(leader, units) {
        var t = { atk: 0, def: 0, move: 0 };
        units.forEach(function (u) { var x = unitTotals(u); t.atk += x.atk; t.def += x.def; t.move += x.move; });
        t.move = Math.max(0, t.move - (leader ? leader.red : 0));
        return t;
    }
    function strength(c) { return c ? c.atk + c.def + (c.am + c.dm) / 100 : 0; }
    // a warlord on the builder: a free staked one (new division) or an existing division with room
    function builderLeaders() {
        var d = S.data, out = [];
        inventory().free.filter(function (c) { return c.cat === 0; }).forEach(function (c) {
            out.push({ key: 'n:' + c.id, lead: c, div: null, base: [], room: c.slots });
        });
        d.divs.forEach(function (x) {
            var base = d.units.filter(function (u) { return String(u.division_id) === String(x.division_id); }).map(function (u) {
                var g = function (k) { var id = u[k + '_asset_id']; return id && id !== '0' ? card(id) : null; };
                return { m: card(u.unit_asset_id), c: g('creature'), w: g('weapon'), s: g('supply'), l: g('lavalux') };
            });
            var room = Number(x.slots_max) - base.length;
            if (room > 0) out.push({ key: 'd:' + x.division_id, lead: card(x.leader_asset_id), div: x, base: base, room: room });
        });
        return out;
    }
    // free cards of each kind, and how many more of each gear type the wallet may fit
    function builderPools() {
        var d = S.data, free = inventory().free, used = { weapon: 0, supply: 0, lavalux: 0 };
        d.units.forEach(function (u) { ['weapon', 'supply', 'lavalux'].forEach(function (k) { if (u[k + '_asset_id'] && u[k + '_asset_id'] !== '0') used[k]++; }); });
        var by = function (cat) { return free.filter(function (c) { return c.cat === cat; }).sort(function (a, b) { return strength(b) - strength(a); }); };
        var caps = {};
        BGEAR.forEach(function (g) { caps[g[0]] = g[3] ? Math.max(0, (d.owned[g[3]] || 0) - used[g[1]]) : Infinity; });
        return { m: by(1), c: by(4), w: by(2), s: by(3), l: by(5), caps: caps };
    }
    // every free card it can fit, strongest first: if this can't reach a target, nothing can
    function fillAll(L, P) {
        var units = P.m.slice(0, L.room).map(function (m) { return { m: m }; });
        BGEAR.forEach(function (g) {
            var k = g[0], list = P[k].slice(0, Math.min(P[k].length, P.caps[k], units.length));
            list.forEach(function (c, i) { units[i][k] = c; });
        });
        return units;
    }
    function meets(t, need) { return t.atk >= need.atk && t.def >= need.def; }
    // then take back what isn't needed, strongest first, so the best cards stay free
    function trim(L, units, need) {
        units = units.map(function (u) { return Object.assign({}, u); });
        var total = function () { return deckTotals(L.lead, L.base.concat(units)); };
        var gear = [];
        units.forEach(function (u) { BGEAR.forEach(function (g) { if (u[g[0]]) gear.push([u, g[0]]); }); });
        gear.sort(function (a, b) { return strength(b[0][b[1]]) - strength(a[0][a[1]]); });
        gear.forEach(function (x) { var c = x[0][x[1]]; delete x[0][x[1]]; if (!meets(total(), need)) x[0][x[1]] = c; });
        units.slice().sort(function (a, b) { return strength(b.m) - strength(a.m); }).forEach(function (u) {
            var i = units.indexOf(u); units.splice(i, 1);
            if (!meets(total(), need)) units.splice(i, 0, u);
        });
        return units;
    }
    // targets: each live mission, and each reward tier of it, this warlord can reach
    function builderTargets(L) {
        var d = S.data, P = builderPools(), all = fillAll(L, P), max = deckTotals(L.lead, L.base.concat(all)), out = [], seen = {};
        Object.keys(d.missions).forEach(function (k) {
            var m = d.missions[k], cfg = d.cfgs[m.reward_config_id];
            var mins = { atk: Number(m.min_div_attack || 0), def: Number(m.min_div_defense || 0) };
            var needs = (cfg && cfg.tiers && cfg.tiers.length && !(cfg.nft_reward_count > 0))
                ? cfg.tiers.map(function (t) { return { atk: Math.max(mins.atk, Number(t.min_atk || 0)), def: mins.def }; }) : [mins];
            needs.forEach(function (need) {
                if (!meets(max, need)) {
                    // out of reach: priced as if it got there, with what's missing
                    var evx = evaluate(m, { atk_cached: need.atk, def_cached: need.def, movecost_cached: max.move }, d);
                    var kx = m.mission_id + '|' + evx.reward.label;
                    if (!evx.ok || seen[kx]) return;
                    seen[kx] = 1;
                    out.push({ key: kx, m: m, need: need, units: all, t: max, ev: evx, short: { atk: Math.max(0, need.atk - max.atk), def: Math.max(0, need.def - max.def) } });
                    return;
                }
                var units = trim(L, all, need);
                if (L.div && !units.length) return;                  // it already qualifies as it is
                var t = deckTotals(L.lead, L.base.concat(units));
                var ev = evaluate(m, { atk_cached: t.atk, def_cached: t.def, movecost_cached: t.move }, d);
                var key = m.mission_id + '|' + ev.reward.label;
                if (!ev.ok || seen[key]) return;
                seen[key] = 1;
                out.push({ key: key, m: m, need: need, units: units, t: t, ev: ev });
            });
        });
        var byHour = function (a, b) { return b.ev.perHour - a.ev.perHour; };
        return out.filter(function (o) { return !o.short; }).sort(byHour).slice(0, 30)
            .concat(out.filter(function (o) { return o.short; }).sort(byHour).slice(0, 20));
    }
    function builderView() {
        var d = S.data, can = signable(), B = S.b, leaders = builderLeaders();
        var h = '<div class="pdd-sec pdd-build"><div class="pdd-sech"><b>Build a division</b> <small>pick a warlord, then a target: it fills the slots with the weakest free cards that reach it</small></div>';
        if (S.pending) {
            var nd = d.divs.find(function (x) { return String(x.leader_asset_id) === S.pending.leader; });
            h += '<div class="pdd-bundle">' + (nd
                ? '<button class="pdd-go" id="pdd-step2"' + (can ? '' : ' disabled') + '>Step 2 of 2 · assign ' + S.pending.units.length + ' unit' + (S.pending.units.length === 1 ? '' : 's') + ' to division #' + nd.division_id + '</button>'
                : '<span class="pdd-hint">Waiting for the new division to show on chain… <button class="pdd-btn pdd-sm" id="pdd-reload">Check again</button></span>') +
                '<button class="pdd-btn pdd-sm" id="pdd-cancel2">Cancel</button></div></div>';
            return h;
        }
        if (!leaders.length) return h + '<div class="pdd-empty">No free warlord and no division with room. Stake a warlord below.</div></div>';
        h += '<div class="pdd-grid pdd-leads">' + leaders.map(function (L) {
            var on = B && B.leader === L.key;
            return '<div class="pdc pdc-s pdc-pick' + (on ? ' on' : '') + '" data-lead="' + L.key + '" title="' + esc(L.lead.name) + '">' +
                (on ? '<span class="pdc-tick">✓</span>' : '') +
                '<div class="pdc-img">' + (L.lead.img ? imgTag(L.lead.img, 220) : '<span>' + esc(L.lead.name) + '</span>') + '</div>' +
                '<div class="pdc-name">' + esc(L.lead.name) + '</div><div class="pdc-meta">' +
                (L.div ? 'Division #' + L.div.division_id + ' · ' + L.base.length + '/' + L.div.slots_max : 'new · ' + L.room + ' slots') +
                (L.lead.red ? '<br>−' + L.lead.red + ' move' : '') + '</div></div>';
        }).join('') + '</div>';
        var L = B && leaders.find(function (x) { return x.key === B.leader; });
        if (!L) return h + '</div>';

        if (!B.targets) B.targets = builderTargets(L);
        var opt = function (o) {
            var miss = o.short ? [o.short.atk ? n(o.short.atk) + ' ATK' : '', o.short.def ? n(o.short.def) + ' DEF' : ''].filter(Boolean).join(' + ') : '';
            return '<option value="' + o.key + '"' + (o.short ? ' class="pdd-opt-short"' : '') + (B.target === o.key ? ' selected' : '') + '>' +
                esc((o.short ? '✗ ' : '') + '#' + o.m.mission_id + ' ' + (o.m._meta.title || '') + ' · needs ATK ' + n(o.need.atk) + ' / DEF ' + n(o.need.def) +
                    (o.short ? ' · short ' + miss : '') + ' · ' + o.ev.reward.label + ' · ' + perH(o.ev) + '/h · locks ' + dur(o.ev.secs) +
                    (o.short ? '' : ' · ' + o.units.length + ' unit' + (o.units.length === 1 ? '' : 's'))) + '</option>';
        };
        var reach = B.targets.filter(function (o) { return !o.short; }), out = B.targets.filter(function (o) { return o.short; });
        var opts = '<option value="">— by hand, no target —</option>' + reach.map(opt).join('') +
            (out.length ? '<optgroup label="Not enough ATK / DEF with your free cards">' + out.map(opt).join('') + '</optgroup>' : '');
        var tgt = B.targets.find(function (o) { return o.key === B.target; });
        h += '<div class="pdd-form"><label>Target ' + '<select class="pdd-sel pdd-wide' + (tgt && tgt.short ? ' pdd-sel-short' : '') + '" id="pdd-target">' + opts + '</select></label></div>' +
            (reach.length ? '' : '<p class="pdd-note">No live mission is reachable with this warlord and your free cards.</p>');

        // the deck being built
        var units = B.units, P = builderPools(), t = deckTotals(L.lead, L.base.concat(units));
        var inUse = {};
        units.forEach(function (u) { ['m', 'c', 'w', 's', 'l'].forEach(function (k) { if (u[k]) inUse[u[k].id] = 1; }); });
        var spare = function (k) { return P[k].filter(function (c) { return !inUse[c.id]; }); };
        var gearLeft = {};
        BGEAR.forEach(function (g) { gearLeft[g[0]] = P.caps[g[0]] - units.filter(function (u) { return u[g[0]]; }).length; });
        var ev = tgt ? evaluate(tgt.m, { atk_cached: t.atk, def_cached: t.def, movecost_cached: t.move }, d) : null;
        var ok = tgt ? meets(t, tgt.need) : true;
        h += '<div class="pdd-chips">' + chip('ATK', n(t.atk) + (tgt ? ' <small>/ ' + n(tgt.need.atk) + '</small>' : '')) +
            chip('DEF', n(t.def) + (tgt ? ' <small>/ ' + n(tgt.need.def) + '</small>' : '')) + chip('Move', n(t.move)) +
            chip('Units', (L.base.length + units.length) + ' <small>/ ' + (L.div ? L.div.slots_max : L.room) + '</small>') +
            (ev ? chip('Lock', dur(ev.secs)) + chip('Earns', (ev.ok ? perH(ev) + '/h' : '<span class="pdd-bad">doesn’t qualify</span>')) : '') + '</div>';
        // one Auto per gear type: the best spare cards onto the strongest units without one
        var empty = function (k) { return units.filter(function (u) { return !u[k]; }).length; };
        h += '<div class="pdd-autos"><span class="pdd-hint">Suggested gear:</span>' + BGEAR.map(function (g) {
            var k = g[0], nsp = spare(k).length, can2 = Math.min(nsp, gearLeft[k], empty(k));
            return '<button class="pdd-btn pdd-sm" data-bauto="' + k + '"' + (can2 > 0 ? '' : ' disabled') + ' title="' +
                esc(nsp + ' spare · ' + fmtCap(gearLeft[k]) + ' slot' + (gearLeft[k] === 1 ? '' : 's') + ' left · ' + empty(k) + ' unit' + (empty(k) === 1 ? '' : 's') + ' without one') + '">' +
                CAT[g[2]] + ' <small>(auto' + (can2 > 0 ? ' +' + can2 : '') + ')</small></button>';
        }).join('') + '</div>';
        h += '<div class="pdd-deck"><div class="pdd-face">' + cardHtml(L.lead, { size: 'l' }) + '</div><div class="pdd-units pdd-bunits">' +
            (L.base.length ? '<div class="pdd-hint pdd-full">' + L.base.length + ' unit' + (L.base.length === 1 ? '' : 's') + ' already in this division stay as they are.</div>' : '') +
            units.map(function (u, i) {
                var slots = BGEAR.map(function (g) {
                    var k = g[0], c = u[k], picking = B.pick === i + '|' + k;
                    if (c) return '<button class="pdd-slot full" data-bgear="' + i + '|' + k + '" title="' + esc(c.name + ' · ATK ' + c.atk + ' DEF ' + c.def + ' · click to take it off') + '">' +
                        (c.img ? imgTag(c.img, 80) : '<small>' + esc(c.name.slice(0, 3)) + '</small>') + '</button>';
                    var none = !spare(k).length ? 'no spare ' + CAT[g[2]] : gearLeft[k] <= 0 ? 'no ' + CAT[g[2]] + ' slots left: buy more in Forge & shop' : '';
                    return '<button class="pdd-slot' + (picking ? ' on' : '') + '" data-bslot="' + i + '|' + k + '"' + (none ? ' disabled title="' + esc(none) + '"' : ' title="Add ' + CAT[g[2]] + '"') + '>+<small>' + CAT[g[2]].slice(0, 3) + '</small></button>';
                }).join('');
                var ut = unitTotals(u);
                return '<div class="pdd-bunit">' + cardHtml(u.m, { size: 's', extra: '<div class="pdc-meta">unit ' + ut.atk + ' / ' + ut.def + '</div><button class="pdc-rm" data-bunit="' + i + '">Remove</button>' }) +
                    '<div class="pdd-slots">' + slots + '</div></div>';
            }).join('') +
            (spare('m').length && L.base.length + units.length < (L.div ? Number(L.div.slots_max) : L.room)
                ? '<label class="pdd-addu">Add a mercenary <select class="pdd-sel" id="pdd-baddunit"><option value="">choose…</option>' +
                  spare('m').map(function (c) { return '<option value="' + c.id + '">' + esc(c.name + ' · ATK ' + c.atk + ' DEF ' + c.def + ' · move ' + c.move) + '</option>'; }).join('') + '</select></label>' : '') +
            '</div></div>';
        // the + of a slot opens the spare cards of that kind, strongest first
        if (B.pick) {
            var pp = B.pick.split('|'), pu = units[pp[0]], pg2 = BGEAR.find(function (g) { return g[0] === pp[1]; });
            if (pu && pg2) h += '<div class="pdd-picker"><div class="pdd-sech"><b>Choose ' + CAT[pg2[2]] + '</b> <small>for ' + esc(pu.m.name) + '</small>' +
                '<button class="pdd-btn pdd-sm" id="pdd-pickx">Cancel</button></div><div class="pdd-grid">' +
                spare(pp[1]).map(function (c) { return '<div class="pdd-pickc" data-bput="' + c.id + '">' + cardHtml(c, { size: 's', cls: 'pdc-pick' }) + '</div>'; }).join('') + '</div></div>';
        }
        var steps = L.div ? '' : ' (2 signatures: create, then assign)';
        h += '<div class="pdd-bundle"><button class="pdd-go" id="pdd-build"' + (can && (units.length || !L.div) && ok ? '' : ' disabled') + '>' +
            (L.div ? 'Add ' + units.length + ' unit' + (units.length === 1 ? '' : 's') + ' to division #' + L.div.division_id : 'Create division' + (units.length ? ' with ' + units.length + ' unit' + (units.length === 1 ? '' : 's') : '')) + '</button>' +
            '<span class="pdd-hint">' + (!ok ? '<span class="pdd-bad">Short ' + [t.atk < tgt.need.atk ? n(tgt.need.atk - t.atk) + ' ATK' : '', t.def < tgt.need.def ? n(tgt.need.def - t.def) + ' DEF' : ''].filter(Boolean).join(' + ') + '</span>: stake stronger cards or more gear, or pick a lower target.' : steps) +
            ' Gear left to fit: equipment ' + fmtCap(gearLeft.w) + ', supplies ' + fmtCap(gearLeft.s) + ', Lava Lux ' + fmtCap(gearLeft.l) + '.</span></div>';
        return h + '</div>';
    }
    function fmtCap(x) { return x === Infinity ? 'any' : Math.max(0, x); }
    function builderPick(key) {
        S.b = { leader: key, target: '', targets: null, units: [] };
        var L = builderLeaders().find(function (x) { return x.key === key; });
        if (L) { S.b.targets = builderTargets(L); var first = S.b.targets.find(function (o) { return !o.short; }); if (first) { S.b.target = first.key; S.b.units = first.units; } }
    }
    /* As the game does it: addunit puts each mercenary in the division (assign fails
       with "Unit not found" before that), then one assign per piece of gear with the
       other gear fields 0. All in one signature. */
    function assignActs(divId, units) {
        var acts = units.map(function (u) { return act('core.pdef', 'addunit', { owner: S.wallet, division_id: divId, unit_asset_id: u.m.id }); });
        units.forEach(function (u) {
            BGEAR.forEach(function (g) {
                if (!u[g[0]]) return;
                var data = { owner: S.wallet, division_id: divId, unit_asset_id: u.m.id, creature_asset_id: '0', weapon_asset_id: '0', supply_asset_id: '0', lavalux_asset_id: '0' };
                data[g[1] + '_asset_id'] = u[g[0]].id;
                acts.push(act('core.pdef', 'assign', data));
            });
        });
        return acts;
    }

    function stakeView() {
        var d = S.data, inv = inventory(), can = signable(), f = S.catFilter;
        var match = function (c) { return f < 0 || c.cat === f; };
        var nW = pickedIds(inv.wallet, 'w').length, nF = pickedIds(inv.free, 'f').length, nL = pickedLeaders().length;
        var lockedW = function (c) { return d.forge != null && c.forge > d.forge; };
        var pills = '<div class="pdd-cats">' + [-1, 0, 1, 2, 3, 4, 5].map(function (k) {
            return '<button class="pdd-segb' + (f === k ? ' on' : '') + '" data-cat="' + k + '">' + (k < 0 ? 'All' : CAT[k]) + '</button>';
        }).join('') + '</div>';
        var w = inv.wallet.filter(match), free = inv.free.filter(match);

        var h = builderView() + pills +
            '<div class="pdd-sec"><div class="pdd-sech"><b>In your wallet</b> <small>' + inv.wallet.length + ' Planetary Defense cards, not staked</small>' +
            (nW ? '<button class="pdd-btn pdd-sm" data-clear="w">Clear</button>' : '') +
            '<button class="pdd-go pdd-sm" id="pdd-stake"' + (can && nW ? '' : ' disabled') + '>Stake selected (' + nW + ')</button></div>' +
            (w.length ? '<div class="pdd-grid">' + stacks(w, 'w').map(function (s) {
                return cardHtml(s.top, { pick: can ? s.key : '', count: s.ids.length, disabled: lockedW(s.top) });
            }).join('') + '</div>'
                      : '<div class="pdd-empty">Nothing here.</div>') +
            (inv.wallet.some(lockedW) ? '<p class="pdd-note">Cards with a red forge tag need a higher forge level before they can be staked: see Forge &amp; shop.</p>' : '') + '</div>';

        h += '<div class="pdd-sec"><div class="pdd-sech"><b>Staked, not in a division</b> <small>' + inv.free.length + '</small>' +
            (nF ? '<button class="pdd-btn pdd-sm" data-clear="f">Clear</button>' : '') +
            '<button class="pdd-go pdd-sm" id="pdd-mkdivs"' + (can && nL ? '' : ' disabled') + ' title="One division per selected warlord, in one signature">Create divisions (' + nL + ')</button>' +
            '<button class="pdd-btn" id="pdd-unstake"' + (can && nF ? '' : ' disabled') + '>Unstake selected (' + nF + ')</button></div>' +
            (free.length ? '<div class="pdd-grid">' + stacks(free, 'f').map(function (s) {
                var c = s.top;
                return cardHtml(c, { pick: can ? s.key : '', count: s.ids.length,
                    extra: can && c.cat === 0 ? '<button class="pdc-rm" data-creatediv="' + c.id + '">Create division</button>' : '' });
            }).join('') + '</div>' : '<div class="pdd-empty">Nothing staked and free.</div>') + '</div>';

        var used = inv.used.filter(match);
        h += '<div class="pdd-sec"><div class="pdd-sech"><b>In a division</b> <small>' + inv.used.length + ': remove units and gear from a division’s deck on the Divisions tab</small></div>' +
            (used.length ? '<div class="pdd-grid">' + used.map(function (c) {
                return cardHtml(c, { extra: '<div class="pdc-meta">in division #' + c.div + '</div>' });
            }).join('') + '</div>' : '<div class="pdd-empty">None.</div>') + '</div>';
        return h;
    }

    function forgeView() {
        var d = S.data, can = signable(), lvl = d.forge || 0;
        var levels = d.forgeLvls.slice().sort(function (a, b) { return a.level - b.level; });
        var next = levels.find(function (l) { return Number(l.level) === lvl + 1; });
        var unlocks = {};
        Object.keys(d.stats).forEach(function (t) { var s = d.stats[t]; unlocks[s.min_forge_level] = (unlocks[s.min_forge_level] || 0) + 1; });
        var cost = function (l) {
            var parts = [];
            if (amt(l.tlm_cost).n) parts.push(n(amt(l.tlm_cost).n) + ' TLM');
            if (amt(l.def_cost).n) parts.push(n(amt(l.def_cost).n, 2) + ' DEF');
            if (Number(l.nft_count)) parts.push(l.nft_count + ' NFT' + (l.nft_count > 1 ? 's' : ''));
            return parts.join(' + ') || 'free';
        };
        var h = '<div class="pdd-chips">' + chip('Forge level', d.forge == null ? 'not registered' : lvl) +
            chip('Next level', next ? (lvl + 1) + ' · ' + cost(next) : 'maxed') +
            chip('Wallet TLM', d.tlmBal == null ? '–' : n(d.tlmBal, 2)) + chip('Wallet DEF', d.defBal == null ? '–' : n(d.defBal, 3)) + '</div>';
        if (next) {
            var simple = !Number(next.nft_count) && !amt(next.def_cost).n;
            h += '<div class="pdd-bundle"><button class="pdd-go" id="pdd-forge"' + (can && simple ? '' : ' disabled') + '>Upgrade forge to level ' + (lvl + 1) + ' · ' + cost(next) + '</button>' +
                '<span class="pdd-hint">' + (simple ? 'Sends ' + cost(next) + ' to forge.pdef with memo forge:' + (lvl + 1) + ', the way the game does.'
                                                    : 'This level also costs DEF or NFTs: upgrade it in the game for now.') + '</span></div>';
        }
        h += '<div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="txt">Level</th><th class="txt">Cost</th><th class="num">Card templates it unlocks</th><th class="txt"></th></tr></thead><tbody>' +
            levels.map(function (l) {
                var L = Number(l.level);
                return '<tr' + (L <= lvl ? ' class="pdd-done"' : '') + '><td class="txt">' + L + '</td><td class="txt">' + cost(l) + '</td><td class="num">' + (unlocks[L] || 0) +
                    '</td><td class="txt">' + (L <= lvl ? '<span class="pdd-ready">unlocked</span>' : L === lvl + 1 ? 'next' : '') + '</td></tr>';
            }).join('') + '</tbody></table></div>';

        /* The shop is four price ladders, one per kind of slot: a wallet's purchases
           are counted in forge.pdef::powerups, so its next buy is the next rung. */
        var LADDERS = [['divslot', 'Division slots', 'more divisions'], ['eqpslot', 'Equipment slots', 'more units carrying equipment'],
                       ['supslot', 'Supply slots', 'more units carrying supplies'], ['lavaslot', 'Lava Lux slots', 'more units carrying Lava Lux']];
        var rows = LADDERS.map(function (L) {
            var steps = d.shopItems.filter(function (it) { return it.reward_powerup === L[0]; }).sort(function (a, b) { return a.id - b.id; });
            var owned = d.owned[L[0]] || 0, next = steps[owned];
            var total = 0;
            steps.slice(owned, owned + 5).forEach(function (it) { total += amt(it.price).n; });
            var locked = next && d.forge != null && Number(next.min_forge_level) > lvl;
            return '<tr><td class="txt"><b>' + L[1] + '</b> <small>' + L[2] + '</small></td><td class="num">' + owned + ' <small>of ' + steps.length + '</small></td>' +
                '<td class="num">' + (next ? n(amt(next.price).n, 2) + ' ' + amt(next.price).sym : '–') + '</td>' +
                '<td class="num">' + (next ? next.min_forge_level : '–') + '</td>' +
                '<td class="num">' + (next && steps.length > owned + 1 ? n(total, 2) + ' ' + amt(next.price).sym : '–') + '</td><td class="txt">' +
                (!next ? '<span class="pdd-ready">all bought</span>' : can ? '<button class="pdd-btn" data-buy="' + next.id + '"' +
                    (locked ? ' disabled title="Needs forge level ' + next.min_forge_level + '"' : '') + '>Buy #' + next.id + '</button>' : '') + '</td></tr>';
        }).join('');
        var other = d.shopItems.filter(function (it) { return !LADDERS.some(function (L) { return L[0] === it.reward_powerup; }); });
        h += '<div class="pdd-sec"><div class="pdd-sech"><b>Forge shop</b> <small>slots are bought one at a time, each costing more than the last</small></div>' +
            '<div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="txt">Slot</th><th class="num">Owned</th><th class="num">Next costs</th>' +
            '<th class="num">Needs forge</th><th class="num">Next 5 together</th><th class="txt"></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
            (other.length ? '<p class="pdd-note">' + other.length + ' other shop item' + (other.length === 1 ? '' : 's') + ' not shown.</p>' : '') + '</div>';
        return h;
    }

    /* ── events ─────────────────────────────────────────────────────────────── */
    function bind(el) {
        var inp = el.querySelector('#pdd-wallet');
        var go = function () { var w = (inp.value || '').trim().toLowerCase(); if (w) load(w); };
        var v = el.querySelector('#pdd-view'); if (v) v.onclick = go;
        if (inp) inp.onkeydown = function (e) { if (e.key === 'Enter') go(); };
        var mb = el.querySelector('#pdd-mine'); if (mb) mb.onclick = function () { load(me()); };
        var wc = el.querySelector('#pdd-wcw'); if (wc) wc.onclick = wcwLogin;
        el.querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { S.tab = b.getAttribute('data-tab'); render(); }; });
        el.querySelectorAll('[data-mode]').forEach(function (b) { b.onclick = function () { S.mode = b.getAttribute('data-mode'); S.pick = {}; render(); }; });
        el.querySelectorAll('[data-cat]').forEach(function (b) { b.onclick = function () { S.catFilter = Number(b.getAttribute('data-cat')); render(); }; });
        var ic = el.querySelector('#pdd-idle'); if (ic) ic.onchange = function () { S.idleToBest = ic.checked; render(); };
        el.querySelectorAll('.pdd-sel[data-div]').forEach(function (s) {
            s.onclick = function (e) { e.stopPropagation(); };
            s.onchange = function () { S.pick[s.getAttribute('data-div')] = s.value; render(); };
        });
        el.querySelectorAll('.pdd-sel[data-form]').forEach(function (s) { s.onchange = function () { S.form[s.getAttribute('data-form')] = s.value; }; });
        // a card's frame toggles it (a stack: all or none); − / + set how many of a stack
        el.querySelectorAll('[data-pick]').forEach(function (f) {
            f.onclick = function (e) {
                if (e.target.closest('button, a, select, input')) return;
                var p = f.getAttribute('data-pick').split('|');
                S.qty[p[0]] = S.qty[p[0]] ? 0 : Number(p[1]); render();
            };
        });
        el.querySelectorAll('[data-step]').forEach(function (b) {
            b.onclick = function (e) {
                e.stopPropagation();
                var p = b.getAttribute('data-step').split('|');
                S.qty[p[0]] = Math.max(0, Math.min(Number(p[2]), (S.qty[p[0]] || 0) + Number(p[1]))); render();
            };
        });
        el.querySelectorAll('[data-clear]').forEach(function (b) {
            b.onclick = function () {
                var pre = b.getAttribute('data-clear') + ':';
                Object.keys(S.qty).forEach(function (k) { if (k.indexOf(pre) === 0) delete S.qty[k]; }); render();
            };
        });
        el.querySelectorAll('tr.pdd-row').forEach(function (tr) {
            tr.onclick = function (e) {
                if (e.target.closest('button, select, input, a')) return;
                var k = tr.getAttribute('data-open'); S.open[k] = !S.open[k]; render();
            };
        });
        el.querySelectorAll('.pdd-one').forEach(function (b) {
            b.onclick = function (e) {
                e.stopPropagation();
                var st = states().find(function (s) { return String(s.div.division_id) === b.getAttribute('data-div'); });
                var p = st && plan(st);
                if (p) runPlans([p], 'division #' + st.div.division_id + ' → mission #' + p.to);
            };
        });
        var all = el.querySelector('#pdd-all');
        if (all) all.onclick = function () {
            var list = states().filter(function (s) { return s.status === 'ready' || (S.idleToBest && s.status === 'idle' && s.best); }).map(plan).filter(Boolean);
            runPlans(list, list.length + ' division' + (list.length === 1 ? '' : 's') + ' resent');
        };
        var w = S.wallet;
        var stake = el.querySelector('#pdd-stake');
        if (stake) stake.onclick = function () {
            var ids = pickedIds(inventory().wallet, 'w');
            // the game sends at most 50 cards per transfer, several transfers in one signature
            var acts = [];
            for (var i = 0; i < ids.length; i += 50)
                acts.push(act('atomicassets', 'transfer', { from: w, to: 'core.pdef', asset_ids: ids.slice(i, i + 50), memo: 'stake' }));
            run(acts, 'staked ' + ids.length + ' card' + (ids.length === 1 ? '' : 's'));
        };
        var uns = el.querySelector('#pdd-unstake');
        if (uns) uns.onclick = function () {
            var ids = pickedIds(inventory().free, 'f');
            run(ids.map(function (id) { return act('core.pdef', 'unstake', { owner: w, asset_id: id }); }), 'unstaked ' + ids.length + ' card' + (ids.length === 1 ? '' : 's'));
        };
        var mk = el.querySelector('#pdd-mkdivs');
        if (mk) mk.onclick = function () {
            var ids = pickedLeaders();
            run(ids.map(function (id) { return act('core.pdef', 'creatediv', { owner: w, leader_asset_id: id }); }),
                ids.length + ' division' + (ids.length === 1 ? '' : 's') + ' created');
        };
        el.querySelectorAll('[data-creatediv]').forEach(function (b) {
            b.onclick = function () { run([act('core.pdef', 'creatediv', { owner: w, leader_asset_id: b.getAttribute('data-creatediv') })], 'division created'); };
        });
        el.querySelectorAll('[data-lead]').forEach(function (f) {
            f.onclick = function () { var k = f.getAttribute('data-lead'); if (S.b && S.b.leader === k) S.b = null; else builderPick(k); render(); };
        });
        var tg = el.querySelector('#pdd-target');
        if (tg) tg.onchange = function () {
            var o = S.b.targets.find(function (x) { return x.key === tg.value; });
            S.b.target = tg.value; S.b.pick = null; S.b.units = o ? o.units.map(function (u) { return Object.assign({}, u); }) : []; render();
        };
        var findFree = function (id) { return inventory().free.find(function (c) { return c.id === id; }); };
        el.querySelectorAll('[data-bunit]').forEach(function (b) { b.onclick = function () { S.b.units.splice(Number(b.getAttribute('data-bunit')), 1); S.b.pick = null; render(); }; });
        el.querySelectorAll('[data-bgear]').forEach(function (b) {
            b.onclick = function () { var p = b.getAttribute('data-bgear').split('|'); S.b.units[p[0]] = Object.assign({}, S.b.units[p[0]]); delete S.b.units[p[0]][p[1]]; S.b.pick = null; render(); };
        });
        el.querySelectorAll('[data-bslot]').forEach(function (b) {
            b.onclick = function () { var k = b.getAttribute('data-bslot'); S.b.pick = S.b.pick === k ? null : k; render(); };
        });
        var px = el.querySelector('#pdd-pickx'); if (px) px.onclick = function () { S.b.pick = null; render(); };
        el.querySelectorAll('[data-bput]').forEach(function (f) {
            f.onclick = function () {
                var p = S.b.pick.split('|'), c = findFree(f.getAttribute('data-bput'));
                if (c) { S.b.units[p[0]] = Object.assign({}, S.b.units[p[0]]); S.b.units[p[0]][p[1]] = c; }
                S.b.pick = null; render();
            };
        });
        el.querySelectorAll('[data-bauto]').forEach(function (b) {
            b.onclick = function () {
                var k = b.getAttribute('data-bauto'), P = builderPools(), used = {};
                S.b.units.forEach(function (u) { ['m', 'c', 'w', 's', 'l'].forEach(function (x) { if (u[x]) used[u[x].id] = 1; }); });
                var left = P.caps[k] - S.b.units.filter(function (u) { return u[k]; }).length;
                var pool = P[k].filter(function (c) { return !used[c.id]; });         // strongest first
                var order = S.b.units.map(function (u, i) { return i; }).filter(function (i) { return !S.b.units[i][k]; })
                    .sort(function (x, y) { var a = unitTotals(S.b.units[x]), c = unitTotals(S.b.units[y]); return (c.atk + c.def) - (a.atk + a.def); });
                order.forEach(function (i) {
                    if (left <= 0 || !pool.length) return;
                    S.b.units[i] = Object.assign({}, S.b.units[i]); S.b.units[i][k] = pool.shift(); left--;
                });
                S.b.pick = null; render();
            };
        });
        var au = el.querySelector('#pdd-baddunit');
        if (au) au.onchange = function () { var c = findFree(au.value); if (c) S.b.units.push({ m: c }); render(); };
        var bd = el.querySelector('#pdd-build');
        if (bd) bd.onclick = function () {
            var L = builderLeaders().find(function (x) { return x.key === S.b.leader; }), units = S.b.units.slice();
            if (!L) return;
            if (L.div) { run(assignActs(L.div.division_id, units), units.length + ' unit' + (units.length === 1 ? '' : 's') + ' added to division #' + L.div.division_id); S.b = null; return; }
            // a new division's id only exists once it's created, so its units go in a second signature
            if (units.length) S.pending = { leader: L.lead.id, units: units };
            S.b = null;
            run([act('core.pdef', 'creatediv', { owner: w, leader_asset_id: L.lead.id })], 'division created' + (units.length ? ': now sign step 2 to add its units' : ''))
                .then(function () { if (/^✗/.test(S.msg)) { S.pending = null; render(); } });
        };
        var s2 = el.querySelector('#pdd-step2');
        if (s2) s2.onclick = function () {
            var nd = S.data.divs.find(function (x) { return String(x.leader_asset_id) === S.pending.leader; }), units = S.pending.units;
            S.pending = null;
            run(assignActs(nd.division_id, units), units.length + ' unit' + (units.length === 1 ? '' : 's') + ' added to division #' + nd.division_id);
        };
        var rl = el.querySelector('#pdd-reload'); if (rl) rl.onclick = function () { load(S.wallet); };
        var c2 = el.querySelector('#pdd-cancel2'); if (c2) c2.onclick = function () { S.pending = null; render(); };
        el.querySelectorAll('[data-removeunit]').forEach(function (b) {
            b.onclick = function () { run([act('core.pdef', 'removeunit', { owner: w, unit_asset_id: b.getAttribute('data-removeunit') })], 'unit removed'); };
        });
        el.querySelectorAll('[data-unassign]').forEach(function (b) {
            b.onclick = function () {
                var p = b.getAttribute('data-unassign').split('|');
                run([act('core.pdef', 'unassign', { owner: w, division_id: p[0], unit_asset_id: p[1], gear_asset_id: p[2] })], 'gear taken off');
            };
        });
        var fg = el.querySelector('#pdd-forge');
        if (fg) fg.onclick = function () {
            var lvl = (S.data.forge || 0) + 1;
            var next = S.data.forgeLvls.find(function (l) { return Number(l.level) === lvl; });
            run([act('alien.worlds', 'transfer', { from: w, to: 'forge.pdef', quantity: next.tlm_cost, memo: 'forge:' + lvl })], 'forge upgraded to level ' + lvl);
        };
        el.querySelectorAll('[data-buy]').forEach(function (b) {
            b.onclick = function () {
                var it = S.data.shopItems.find(function (x) { return String(x.id) === b.getAttribute('data-buy'); });
                var sym = amt(it.price).sym;
                var contract = it.price_contract || (sym === 'DEF' ? 'defensetoken' : 'alien.worlds');
                run([act(contract, 'transfer', { from: w, to: 'forge.pdef', quantity: it.price, memo: 'shop:' + it.id })], 'bought shop item #' + it.id);
            };
        });
    }

    async function wcwLogin() {
        try {
            if (!window.waxjs) throw new Error('Cloud Wallet library not loaded');
            window._pdWcw = window._pdWcw || new waxjs.WaxJS({ rpcEndpoint: 'https://wax.greymass.com', tryAutoLogin: false });
            var acct = await window._pdWcw.login();
            localStorage.setItem('naron_wallet', acct);
            if (typeof window.checkWalletState === 'function') window.checkWalletState();
            load(acct);
        } catch (e) { S.msg = '✗ Cloud Wallet: ' + (e.message || e); render(); }
    }

    /* ── the mission popup: the viewed wallet's divisions on it, as decks ────── */
    function wrapLore() {
        var orig = window.openLore;
        if (typeof orig !== 'function' || orig._pd) return;
        window.openLore = function (id) {
            var r = orig.apply(this, arguments);
            var body = document.getElementById('lore-body');
            var box = document.getElementById('lore-divs');
            if (!box && body) { box = document.createElement('div'); box.id = 'lore-divs'; body.insertAdjacentElement('afterend', box); }
            if (!box) return r;
            if (!S.data) { box.innerHTML = ''; return r; }
            var on = states().filter(function (st) { return st.lock && Number(st.lock.mission_id) === Number(id); });
            box.innerHTML = on.length
                ? '<div class="pdd-lore-h">' + esc(S.wallet) + '’s divisions on this mission (' + on.length + ')</div>' +
                  on.map(function (st) { return deckHtml(st, false); }).join('')
                : '<div class="pdd-lore-h">' + esc(S.wallet) + ' has no divisions on this mission.</div>';
            return r;
        };
        window.openLore._pd = 1;
    }

    setInterval(function () {
        var flip = false;
        document.querySelectorAll('#pd-divs [data-until]').forEach(function (s) {
            var left = (Number(s.getAttribute('data-until')) - Date.now()) / 1000;
            if (left <= 0) flip = true; else s.textContent = dur(left);
        });
        if (flip) render();
    }, 1000);

    ['setValueIn', 'onDefPriceChange'].forEach(function (fn) {
        var orig = window[fn];
        if (typeof orig === 'function') window[fn] = function () { var r = orig.apply(this, arguments); render(); return r; };
    });
    var priceWait = setInterval(function () { var p = pg(); if (p.tlmInWax && p.defInTlm) { clearInterval(priceWait); render(); } }, 1500);

    var origCheck = window.checkWalletState;
    window.checkWalletState = function () {
        if (typeof origCheck === 'function') origCheck.apply(this, arguments);
        var w = me();
        if (w && w !== S.wallet && (!S.wallet || S.own)) load(w);
        else render();
    };
    window.pdDivisionsInit = function () { wrapLore(); var w = me(); if (w && w !== S.wallet) load(w); else render(); };
    document.addEventListener('DOMContentLoaded', window.pdDivisionsInit);
})();
