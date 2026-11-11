/* Stats tab of the PD hub (miss.pdef.html): what a wallet has put into Planetary
   Defense missions and what it got back, read from its chain history.

   How PD records it (checked on chain, Nov 2026). Since about October 2026:
     entry fee   core.pdef::spendbal(owner, quantity, …, "Mission N entry")   from the in-game balance
     reward      miss.pdef → core.pdef transfer, memo "credit:<owner>"        into the in-game balance
   Before that, straight between the wallet and miss.pdef:
     entry fee   wallet → miss.pdef transfer, memo "entry:N"
     reward      miss.pdef → wallet transfer, memo "Mission division reward"
   In both eras:
     chest/key   atomicassets mint by miss.pdef, schema "loot", to the owner
     withdrawal  core.pdef::withdrawbal; TLM pays 5% to pdef as "Withdrawal fee"
     shards      ptpxy.worlds::addpoints by magordefense into Alien Worlds user points
                 (uspts.worlds::userpoints), which also hold points from the rest of
                 Alien Worlds, so a PD-only total isn't on chain: shards are estimated
                 from claims on shard missions.
   Fees and rewards are inline transfers the history nodes don't index by wallet, so
   each claim/join transaction is opened once and remembered in this browser. */
(function () {
    var NODES = ['https://wax-history.eosdac.io', 'https://hyperion.wax.detroitledger.tech', 'https://history.waxsweden.org'];
    var AA = ['https://wax.api.atomicassets.io', 'https://wax-aa.eu.eosamsterdam.net', 'https://wax-atomic-api.eosphere.io'];
    var KEY = 'pd_stats_v2:';
    var T = { wallet: '', busy: false, step: '', done: 0, todo: 0, err: '', data: null, tpl: {}, sold: {}, started: false };

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function n(x, d) { return Number(x).toLocaleString('en', { maximumFractionDigits: d == null ? 0 : d }); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function amt(a) { var p = String(a || '').split(' '); return { n: parseFloat(p[0]) || 0, sym: p[1] || '' }; }
    function utc(s) { return Date.parse(/Z$/.test(s) ? s : s + 'Z'); }
    // page prices, declared with let on the page (bare names, not window properties)
    function prices() {
        var p = {};
        try { p.defInTlm = (typeof defPrice !== 'undefined' && defPrice > 0) ? defPrice : defInTlm; } catch (e) {}
        try { p.tlmInWax = tlmInWax; } catch (e) {}
        p.TLM = p.tlmInWax || 0; p.DEF = (p.defInTlm || 0) * (p.tlmInWax || 0);
        return p;
    }
    function me() {
        return window.pdWallet || (window.walletSession ? String(window.walletSession.actor) : '') || localStorage.getItem('naron_wallet') || '';
    }

    /* ── history nodes: polite, with fallback ── */
    var gapAt = {};
    async function hist(path) {
        var last;
        for (var k = 0; k < NODES.length * 2; k++) {
            var node = NODES[k % NODES.length];
            var wait = (gapAt[node] || 0) - Date.now();
            if (wait > 0) await sleep(wait);
            gapAt[node] = Date.now() + 260;
            try {
                var r = await fetch(node + path, { signal: AbortSignal.timeout(15000) });
                if (r.status === 429) { gapAt[node] = Date.now() + 4000; last = new Error('rate limited'); continue; }
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return await r.json();
            } catch (e) { last = e; }
        }
        throw last || new Error('history unavailable');
    }
    async function aaGet(path) {
        for (var i = 0; i < AA.length; i++) {
            try { var r = await fetch(AA[i] + path, { signal: AbortSignal.timeout(12000) }); if (r.ok) return await r.json(); } catch (e) {}
        }
        return null;
    }
    // every action of one kind for a wallet, newest first, stopping at what's known
    async function listActs(wallet, filter, known) {
        var out = [];
        for (var skip = 0; skip < 10000; skip += 100) {
            var j = await hist('/v2/history/get_actions?account=' + wallet + '&filter=' + filter + '&limit=100&skip=' + skip + '&sort=desc');
            var a = j.actions || [];
            var fresh = a.filter(function (x) { return !known || !known[x.trx_id]; });
            out = out.concat(fresh);
            if (a.length < 100 || (known && fresh.length < a.length)) break;
        }
        return out;
    }

    function load(wallet) {
        try { return JSON.parse(localStorage.getItem(KEY + wallet)) || null; } catch (e) { return null; }
    }
    function save() {
        try { localStorage.setItem(KEY + T.wallet, JSON.stringify(T.data)); } catch (e) {}
    }
    function blank() { return { txs: {}, rec: [], chests: [], wd: {}, at: 0 }; }

    // rec: [time, kind ('fee'|'reward'|'deposit'|'claim'), sym, amount, mission, 'w' paid by/to the wallet | 'b' the in-game balance]
    function parseTx(t, wallet, d) {
        var seen = {}, time = utc(t.actions && t.actions[0] ? t.actions[0]['@timestamp'] : new Date().toISOString());
        (t.actions || []).forEach(function (x) {
            if (seen[x.global_sequence]) return;
            seen[x.global_sequence] = 1;
            var a = x.act, dt = a.data || {};
            if (a.account === 'core.pdef' && a.name === 'spendbal' && dt.owner === wallet) {
                var q = amt(dt.quantity), m = /Mission (\d+)/.exec(dt.memo || '');
                d.rec.push([time, 'fee', q.sym, q.n, m ? Number(m[1]) : 0, 'b']);
            } else if (a.name === 'transfer' && dt.from === 'miss.pdef' && dt.to === 'core.pdef' && dt.memo === 'credit:' + wallet) {
                var r = amt(dt.quantity);
                d.rec.push([time, 'reward', r.sym, r.n, 0, 'b']);
            } else if (a.name === 'transfer' && dt.from === wallet && dt.to === 'miss.pdef' && /^entry:\d+/.test(dt.memo || '')) {
                var oq = amt(dt.quantity);
                d.rec.push([time, 'fee', oq.sym, oq.n, Number(dt.memo.split(':')[1]), 'w']);
            } else if (a.name === 'transfer' && dt.from === 'miss.pdef' && dt.to === wallet && dt.memo === 'Mission division reward') {
                var orw = amt(dt.quantity);
                d.rec.push([time, 'reward', orw.sym, orw.n, 0, 'w']);
            } else if (a.name === 'transfer' && dt.from === wallet && dt.to === 'core.pdef' && dt.memo === 'deposit') {
                var p = amt(dt.quantity);
                d.rec.push([time, 'deposit', p.sym, p.n, 0]);
            }
        });
        // claims in the tx, for runs per mission and the shard estimate
        (t.actions || []).forEach(function (x) {
            if (x.act.account === 'miss.pdef' && x.act.name === 'claim' && x.act.data.owner === wallet && !seen['c' + x.global_sequence]) {
                seen['c' + x.global_sequence] = 1;
                d.rec.push([time, 'claim', '', 1, Number(x.act.data.mission_id)]);
            }
        });
    }

    async function readAll() {
        if (T.busy || !T.wallet) return;
        var wallet = T.wallet;
        T.busy = true; T.err = ''; T.done = 0; T.todo = 0;
        T.data = load(wallet) || blank();
        paint();
        try {
            T.step = 'Listing your claims and joins…'; paint();
            var acts = (await listActs(wallet, 'miss.pdef:claim', T.data.txs)).concat(await listActs(wallet, 'miss.pdef:join', T.data.txs));
            var ids = {};
            acts.forEach(function (a) { if (!T.data.txs[a.trx_id]) ids[a.trx_id] = 1; });
            var todo = Object.keys(ids);
            T.todo = todo.length;
            T.step = 'Reading ' + todo.length + ' transaction' + (todo.length === 1 ? '' : 's') + ' for fees and rewards…'; paint();
            var next = 0;
            var worker = async function () {
                while (next < todo.length && wallet === T.wallet) {
                    var id = todo[next++];
                    try {
                        var t = await hist('/v2/history/get_transaction?id=' + id);
                        if (t && t.actions) { parseTx(t, wallet, T.data); T.data.txs[id] = 1; }
                    } catch (e) {}
                    T.done++;
                    if (T.done % 10 === 0) { save(); paint(); }
                }
            };
            await Promise.all([worker(), worker(), worker()]);
            save();

            T.step = 'Reading withdrawals and chests…'; paint();
            var wds = await listActs(wallet, 'core.pdef:withdrawbal', null);
            T.data.wd = {};
            wds.forEach(function (a) {
                var q = amt(a.act.data.quantity), f = q.sym === 'TLM' ? q.n * 0.05 : 0;
                T.data.wd[a.global_sequence] = [utc(a['@timestamp']), q.sym, q.n, f];
            });
            var mints = await listActs(wallet, 'atomicassets:logmint', null).catch(function () { return []; });
            T.data.chests = mints.filter(function (a) { return a.act.data.authorized_minter === 'miss.pdef' && a.act.data.new_asset_owner === wallet; })
                .map(function (a) { return [utc(a['@timestamp']), Number(a.act.data.template_id), a.act.data.schema_name]; });
            try {
                var br = await fetch('https://wax.greymass.com/v1/chain/get_table_rows', { method: 'POST',
                    body: JSON.stringify({ json: true, code: 'core.pdef', scope: wallet, table: 'balances', limit: 10 }) });
                T.data.bal = ((await br.json()).rows || []).map(function (b) { return b.balance; });
            } catch (e) {}
            T.data.at = Date.now();
            save();
            await chestInfo();
        } catch (e) { T.err = 'Could not read the history: ' + e.message; }
        T.busy = false; T.step = '';
        paint();
    }
    // template names and the last AtomicHub sale for each chest/key template
    async function chestInfo() {
        var tpls = {};
        T.data.chests.forEach(function (c) { tpls[c[1]] = 1; });
        var ids = Object.keys(tpls).filter(function (id) { return !T.tpl[id]; });
        if (ids.length) {
            var j = await aaGet('/atomicassets/v1/templates?collection_name=planetdefnft&ids=' + ids.join(',') + '&limit=100');
            ((j && j.data) || []).forEach(function (t) { T.tpl[t.template_id] = { name: (t.immutable_data && t.immutable_data.name) || ('#' + t.template_id), img: t.immutable_data && (t.immutable_data.img || t.immutable_data.image) }; });
        }
        for (var i = 0; i < Object.keys(tpls).length; i++) {
            var id = Object.keys(tpls)[i];
            if (T.sold[id]) continue;
            var s = await aaGet('/atomicmarket/v1/sales?state=3&collection_name=planetdefnft&template_id=' + id + '&sort=updated&order=desc&limit=1');
            var x = s && s.data && s.data[0];
            T.sold[id] = x ? { wax: Number(x.price.amount) / Math.pow(10, x.price.token_precision), sym: x.price.token_symbol, at: Number(x.updated_at_time) } : { none: true };
        }
    }

    /* ── summary ── */
    function sum() {
        var d = T.data, s = { fee: {}, reward: {}, deposit: {}, wdfee: { TLM: 0 }, withdraw: {}, runs: 0, byMission: {}, byDay: {},
                              toWallet: {}, toBal: {}, feeWallet: {}, feeBal: {}, firstBal: 0 };
        if (!d) return s;
        d.rec.forEach(function (r) {
            var kind = r[1], sym = r[2], x = r[3];
            if (kind === 'claim') {
                s.runs++;
                (s.byMission[r[4]] = s.byMission[r[4]] || { runs: 0, fee: {} }).runs++;
            } else {
                s[kind][sym] = (s[kind][sym] || 0) + x;
                var via = r[5] === 'w' ? (kind === 'reward' ? 'toWallet' : 'feeWallet') : (kind === 'reward' ? 'toBal' : kind === 'fee' ? 'feeBal' : '');
                if (via) s[via][sym] = (s[via][sym] || 0) + x;
                if (r[5] === 'b' && (!s.firstBal || r[0] < s.firstBal)) s.firstBal = r[0];
                if (kind === 'fee' && r[4]) { var bm = s.byMission[r[4]] = s.byMission[r[4]] || { runs: 0, fee: {} }; bm.fee[sym] = (bm.fee[sym] || 0) + x; }
            }
            if (kind === 'fee' || kind === 'reward' || kind === 'claim') {
                var day = new Date(r[0]).toISOString().slice(0, 10);
                var bd = s.byDay[day] = s.byDay[day] || { runs: 0, fee: {}, reward: {} };
                if (kind === 'claim') bd.runs++; else bd[kind][sym] = (bd[kind][sym] || 0) + x;
            }
        });
        Object.keys(d.wd).forEach(function (k) {
            var w = d.wd[k];
            s.withdraw[w[1]] = (s.withdraw[w[1]] || 0) + w[2];
            s.wdfee.TLM += w[3];
        });
        return s;
    }
    function wax(o, p) { var t = 0; Object.keys(o).forEach(function (k) { t += (o[k] || 0) * (p[k] || 0); }); return t; }
    function toks(o) {
        var k = Object.keys(o).filter(function (x) { return o[x]; });
        return k.length ? k.map(function (x) { return n(o[x], x === 'DEF' ? 3 : 2) + ' ' + x; }).join(' + ') : '–';
    }

    function paint() {
        var root = document.getElementById('pd-stats');
        if (!root) return;
        var h = '<div class="panel-h"><h2>Stats</h2><p>What a wallet has paid into Planetary Defense missions and what came back, read from its chain history.</p></div><div class="st-body">' +
            '<div class="pdd-head"><input id="st-wallet" type="text" placeholder="wallet" value="' + esc(T.wallet) + '" spellcheck="false">' +
            '<button class="pdd-btn" id="st-go"' + (T.busy ? ' disabled' : '') + '>' + (T.data && T.data.at ? 'Update' : 'Read history') + '</button>' +
            (T.data && T.data.at ? '<span class="pdd-hint">Last read ' + new Date(T.data.at).toLocaleString() + '</span>' : '') + '</div>';
        if (T.err) h += '<div class="pdd-msg bad">' + esc(T.err) + '</div>';
        if (T.busy) h += '<p class="pdd-hint">' + esc(T.step) + (T.todo ? ' ' + T.done + ' / ' + T.todo : '') + '</p>';
        if (!T.wallet) { root.innerHTML = h + '<div class="pdd-empty">Connect a wallet or type one above.</div></div>'; bind(); return; }
        if (!T.data || (!T.data.rec.length && !T.busy)) {
            root.innerHTML = h + (T.busy ? '' : '<div class="pdd-empty">Nothing read yet for ' + esc(T.wallet) + '. Read history goes through every mission claim and join once (a minute or two the first time; later visits only read new ones).</div>') + '</div>';
            bind(); return;
        }
        var p = prices(), s = sum();
        var mine = (window.walletSession ? String(window.walletSession.actor) : '') || localStorage.getItem('naron_wallet') || '';
        var own = mine && mine === T.wallet, who = own ? 'You' : esc(T.wallet);
        var spentWax = wax(s.fee, p) + s.wdfee.TLM * p.TLM, gotWax = wax(s.reward, p), diff = gotWax - spentWax;
        var cls = diff >= 0 ? 'st-pos' : 'st-neg';
        var chestEst = 0;
        (T.data.chests || []).forEach(function (c) { var so = T.sold[c[1]]; if (so && so.wax && so.sym === 'WAX') chestEst += so.wax; });
        h += '<p class="pdd-hint">Values in WAX at today\'s prices: 1 DEF ≈ ' + n(p.DEF, 4) + ' WAX, 1 TLM ≈ ' + n(p.TLM, 4) + ' WAX. Chests, keys and shards are counted separately and left out of these values.</p>';
        h += '<div class="st-grid">' +
            '<div class="st-card"><span>' + (own ? 'You spent' : 'Spent') + '</span><b>' + n(spentWax, 2) + ' WAX</b><small>entry fees ' + esc(toks(s.fee)) + (s.wdfee.TLM ? '<br>withdrawal fees ' + n(s.wdfee.TLM, 2) + ' TLM' : '') + '</small></div>' +
            '<div class="st-card"><span>' + (own ? 'You received' : 'Received') + '</span><b>' + n(gotWax, 2) + ' WAX</b><small>rewards ' + esc(toks(s.reward)) + '</small></div>' +
            '<div class="st-card ' + cls + '"><span>Difference</span><b>' + (diff >= 0 ? '+' : '') + n(diff, 2) + ' WAX</b><small>' + (spentWax ? (gotWax / spentWax * 100).toFixed(0) + '% back in tokens on what you spent' : '') +
                (chestEst ? '<br>plus ' + n((T.data.chests || []).length) + ' chests/keys, ~est. ' + n(chestEst, 0) + ' WAX at last sale (not counted)' : '') + '</small></div>' +
            '<div class="st-card"><span>Missions claimed</span><b>' + n(s.runs) + '</b><small>' + (own ? 'by you' : 'by ' + esc(T.wallet)) + '</small></div></div>';
        // where the rewards went: older missions paid the wallet, newer ones the in-game balance
        var balNow = {};
        (T.data.bal || []).forEach(function (b) { var a = amt(b); if (a.n) balNow[a.sym] = (balNow[a.sym] || 0) + a.n; });
        h += '<div class="st-flow"><h3 class="bas-h">Where the rewards went</h3><dl>' +
            '<dt>Paid straight to the wallet</dt><dd>' + esc(toks(s.toWallet)) + ' <small>missions before ' + (s.firstBal ? new Date(s.firstBal).toLocaleDateString() : 'the in-game balance') + ' paid out directly</small></dd>' +
            '<dt>Credited to the PD in-game balance</dt><dd>' + esc(toks(s.toBal)) + ' <small>missions since then pay into it</small></dd>' +
            '<dt>Entry fees from the wallet / from the balance</dt><dd>' + esc(toks(s.feeWallet)) + ' / ' + esc(toks(s.feeBal)) + '</dd>' +
            '<dt>Deposited into the balance</dt><dd>' + esc(toks(s.deposit)) + '</dd>' +
            '<dt>Withdrawn from the balance</dt><dd>' + esc(toks(s.withdraw)) + (s.wdfee.TLM ? ' <small>incl. ' + n(s.wdfee.TLM, 2) + ' TLM withdrawal fee</small>' : '') + '</dd>' +
            '<dt>In the balance right now</dt><dd>' + (T.data.bal ? esc(toks(balNow)) : '–') + '</dd></dl>' +
            '<p class="pdd-hint">' + who + (own ? ' get' : ' gets') + ' credit for a reward when it is earned, whether it was paid to the wallet or into the in-game balance, and whether or not it has been withdrawn since.</p></div>';

        // per token
        var syms = ['DEF', 'TLM'];
        h += '<div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="txt">Token</th><th class="num">Spent on entry</th><th class="num">Withdrawal fees</th><th class="num">Earned</th><th class="num">Net</th><th class="num">Net in WAX</th></tr></thead><tbody>' +
            syms.map(function (k) {
                var sp = (s.fee[k] || 0) + (k === 'TLM' ? s.wdfee.TLM : 0), er = s.reward[k] || 0, net = er - sp;
                return '<tr><td class="txt">' + k + '</td><td class="num">' + n(s.fee[k] || 0, 3) + '</td><td class="num">' + (k === 'TLM' ? n(s.wdfee.TLM, 2) : '–') + '</td>' +
                    '<td class="num">' + n(er, 3) + '</td><td class="num ' + (net >= 0 ? 'st-pos' : 'st-neg') + '">' + (net >= 0 ? '+' : '') + n(net, 3) + '</td>' +
                    '<td class="num ' + (net >= 0 ? 'st-pos' : 'st-neg') + '">' + (net >= 0 ? '+' : '') + n(net * (p[k] || 0), 2) + '</td></tr>';
            }).join('') + '</tbody></table></div>';

        // drops, not in the values
        var ch = {}, shards = 0;
        (T.data.chests || []).forEach(function (c) { ch[c[1]] = (ch[c[1]] || 0) + 1; });
        var shardMap = window.shardMap || {}, cfgOf = {};
        try { (allMissions || []).forEach(function (m) { cfgOf[m.id] = m.rwShards || 0; }); } catch (e) {}
        Object.keys(s.byMission).forEach(function (mid) { shards += (cfgOf[mid] || 0) * s.byMission[mid].runs; });
        var estTotal = 0;
        h += '<h3 class="bas-h">Drops <small>counted, not included in the values above</small></h3><div class="st-drops">' +
            (Object.keys(ch).length ? Object.keys(ch).map(function (id) {
                var t = T.tpl[id] || {}, so = T.sold[id] || {};
                if (so.wax && so.sym === 'WAX') estTotal += so.wax * ch[id];
                return '<div class="st-drop">' + (t.img ? '<img src="https://wsrv.nl/?url=ipfs.alienworlds.io/ipfs/' + esc(t.img) + '&w=96&output=webp" alt="" loading="lazy">' : '') +
                    '<div><b>' + n(ch[id]) + '× ' + esc(t.name || '#' + id) + '</b><small>' +
                    (so.wax ? '~est. ' + n(so.wax, 2) + ' ' + esc(so.sym) + ' each (last sold ' + new Date(so.at).toLocaleDateString() + ')' : so.none ? 'no sales found' : 'checking last sale…') + '</small></div></div>';
            }).join('') : '<div class="pdd-empty">No chests or keys from missions yet.</div>') +
            '<div class="st-drop"><div><b>' + (shards ? '~' + n(shards) : '0') + ' shards</b><small>estimated from claims on shard missions at today\'s shard rewards. Shards land in Alien Worlds user points (uspts.worlds), mixed with points from the rest of the game, so the chain has no PD-only total.</small></div></div></div>' +
            (estTotal ? '<p class="pdd-hint">Chests and keys at their last sale: ~est. ' + n(estTotal, 2) + ' WAX in total (not counted above).</p>' : '');

        // per mission
        var mids = Object.keys(s.byMission).sort(function (a, b) { return s.byMission[b].runs - s.byMission[a].runs; });
        var title = {};
        try { (allMissions || []).forEach(function (m) { title[m.id] = m.title; }); } catch (e) {}
        h += '<h3 class="bas-h">By mission</h3><div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="txt">Mission</th><th class="num">Claims</th><th class="num">Entry fees</th></tr></thead><tbody>' +
            mids.map(function (mid) { var m = s.byMission[mid]; return '<tr><td class="txt">#' + mid + ' ' + esc(title[mid] || '') + '</td><td class="num">' + n(m.runs) + '</td><td class="num">' + esc(toks(m.fee)) + '</td></tr>'; }).join('') +
            '</tbody></table></div>';

        // per day
        var days = Object.keys(s.byDay).sort().reverse().slice(0, 30);
        h += '<h3 class="bas-h">By day <small>UTC, last 30 days with activity</small></h3><div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="txt">Day</th><th class="num">Claims</th><th class="num">Spent</th><th class="num">Earned</th><th class="num">Net in WAX</th></tr></thead><tbody>' +
            days.map(function (d) {
                var x = s.byDay[d], net = wax(x.reward, p) - wax(x.fee, p);
                return '<tr><td class="txt">' + d + '</td><td class="num">' + n(x.runs) + '</td><td class="num">' + esc(toks(x.fee)) + '</td><td class="num">' + esc(toks(x.reward)) + '</td>' +
                    '<td class="num ' + (net >= 0 ? 'st-pos' : 'st-neg') + '">' + (net >= 0 ? '+' : '') + n(net, 2) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        h += '<p class="pdd-note">Entry fees and rewards come from each claim and join transaction; withdrawal fees are counted at the 5% seen on chain for TLM. ' +
            'Values use today\'s prices, not the price on the day.</p></div>';
        root.innerHTML = h;
        bind();
    }
    function bind() {
        var go = document.getElementById('st-go'), inp = document.getElementById('st-wallet');
        var start = function () { var w = (inp.value || '').trim().toLowerCase(); if (!w) return; if (w !== T.wallet) { T.wallet = w; T.data = load(w); } readAll(); };
        if (go) go.onclick = start;
        if (inp) inp.onkeydown = function (e) { if (e.key === 'Enter') start(); };
    }

    window.pdStatsOpen = function () {
        var w = me();
        if (!T.started || (w && w !== T.wallet && !T.busy)) {
            T.started = true;
            if (w) { T.wallet = w; T.data = load(w); }
            paint();
            if (T.data && T.data.chests && T.data.chests.length) chestInfo().then(paint);
            if (T.wallet && !T.busy) readAll();
        } else paint();
    };
})();
