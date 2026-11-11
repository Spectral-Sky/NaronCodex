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
    var KEY = 'pd_stats_v3:';
    var MONTH = 30.44 * 86400000, SEC_PER_TX = 0.55;
    // log: the progress box, one line per step ('run' | 'ok' | 'stop' | 'err')
    var T = { wallet: '', busy: false, stop: false, done: 0, todo: 0, err: '', data: null, tpl: {}, sold: {}, started: false, log: [], next: null };

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
    // every action of one kind for a wallet between two times, newest first; the page
    // cursor is the last timestamp seen, so it isn't capped by the node's 10,000-row skip
    async function listActs(wallet, filter, after, before, onPage) {
        var out = [], seen = {}, cur = before;
        for (var guard = 0; guard < 400 && !T.stop; guard++) {
            var j = await hist('/v2/history/get_actions?account=' + wallet + '&filter=' + filter + '&limit=100&sort=desc' +
                (after ? '&after=' + new Date(after).toISOString() : '') + (cur ? '&before=' + new Date(cur).toISOString() : ''));
            var a = (j.actions || []).filter(function (x) { if (seen[x.global_sequence]) return false; seen[x.global_sequence] = 1; return true; });
            out = out.concat(a);
            if (onPage) onPage(out.length);
            if ((j.actions || []).length < 100 || !a.length) break;
            cur = utc(a[a.length - 1]['@timestamp']) + 1;      // inclusive of the same second; duplicates are dropped
        }
        return out;
    }
    function logStep(text, state) { T.log.push({ text: text, state: state || 'run' }); paintLog(); return T.log.length - 1; }
    function logSet(i, text, state) { if (T.log[i]) { T.log[i].text = text; if (state) T.log[i].state = state; } paintLog(); }
    function fmtD(t) { return new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }); }
    function eta(n2) { var sec = n2 * SEC_PER_TX; return sec < 90 ? 'under 2 min' : 'about ' + Math.round(sec / 60) + ' min'; }

    function load(wallet) {
        try { return JSON.parse(localStorage.getItem(KEY + wallet)) || null; } catch (e) { return null; }
    }
    function save() {
        try { localStorage.setItem(KEY + T.wallet, JSON.stringify(T.data)); } catch (e) {}
    }
    function blank() { return { txs: {}, rec: [], mint: {}, wd: {}, at: 0, from: 0, all: false }; }

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

    async function readAll(mode) {
        if (!T.wallet) return;
        if (T.busy) { T.stop = true; T.next = mode || 'update'; return; }   // a new request stops the running one first
        var wallet = T.wallet;
        T.busy = true; T.stop = false; T.err = ''; T.done = 0; T.todo = 0; T.log = [];
        T.data = load(wallet) || blank();
        if (!T.data.mint) T.data.mint = {};
        var now = Date.now(), d = T.data, after, before, newFrom;
        if (mode === 'all') { after = 0; before = d.from || now; newFrom = 0; }
        else if (mode === 'older') { before = d.from || now; after = Math.max(0, before - 6 * MONTH); newFrom = after; }
        else { after = d.all ? 0 : (d.from || now - 6 * MONTH); before = 0; newFrom = after; }
        paint();
        var span = (after ? fmtD(after) : 'the start') + ' → ' + (before ? fmtD(before) : 'now');
        try {
            var L = logStep('Listing claims and joins, ' + span + '…');
            var acts = (await listActs(wallet, 'miss.pdef:claim', after, before, function (k) { logSet(L, 'Listing claims, ' + span + '… ' + k); }))
                .concat(await listActs(wallet, 'miss.pdef:join', after, before, function (k) { logSet(L, 'Listing joins, ' + span + '… ' + k); }));
            var ids = {};
            acts.forEach(function (x) { if (!d.txs[x.trx_id]) ids[x.trx_id] = 1; });
            var todo = Object.keys(ids);
            T.todo = todo.length;
            logSet(L, 'Found ' + acts.length + ' claims and joins, ' + todo.length + ' transaction' + (todo.length === 1 ? '' : 's') + ' to read', 'ok');
            if (T.stop) throw 'stop';
            var R = logStep('Reading transactions for fees and rewards… 0 / ' + todo.length + (todo.length > 150 ? ' (' + eta(todo.length) + '; you can stop and continue later)' : ''));
            var next = 0;
            var worker = async function () {
                while (next < todo.length && !T.stop) {
                    var id = todo[next++];
                    try {
                        var t = await hist('/v2/history/get_transaction?id=' + id);
                        if (t && t.actions) { parseTx(t, wallet, d); d.txs[id] = 1; }
                    } catch (e) {}
                    T.done++;
                    if (T.done % 10 === 0 || T.done === todo.length) {
                        save();
                        logSet(R, 'Reading transactions for fees and rewards… ' + T.done + ' / ' + todo.length + (todo.length - T.done > 150 ? ' (' + eta(todo.length - T.done) + ' left)' : ''));
                    }
                }
            };
            await Promise.all([worker(), worker(), worker()]);
            save();
            if (T.stop) { logSet(R, 'Stopped at ' + T.done + ' / ' + todo.length + ' transactions. Update carries on from here.', 'stop'); throw 'stop'; }
            logSet(R, 'Read ' + todo.length + ' transaction' + (todo.length === 1 ? '' : 's') + ' for fees and rewards', 'ok');

            var W = logStep('Listing withdrawals…');
            var wds = await listActs(wallet, 'core.pdef:withdrawbal', after, before);
            wds.forEach(function (x) {
                var q = amt(x.act.data.quantity), f = q.sym === 'TLM' ? q.n * 0.05 : 0;
                d.wd[x.global_sequence] = [utc(x['@timestamp']), q.sym, q.n, f];
            });
            logSet(W, wds.length + ' withdrawal' + (wds.length === 1 ? '' : 's'), 'ok');
            var M = logStep('Listing chest and key mints…');
            var mints = await listActs(wallet, 'atomicassets:logmint', after, before).catch(function () { return []; });
            var found = 0;
            mints.forEach(function (x) {
                var dt = x.act.data;
                if (dt.authorized_minter === 'miss.pdef' && dt.new_asset_owner === wallet) { d.mint[dt.asset_id] = [utc(x['@timestamp']), Number(dt.template_id), dt.schema_name]; found++; }
            });
            logSet(M, found + ' chest/key mint' + (found === 1 ? '' : 's') + ' from missions', 'ok');
            if (T.stop) throw 'stop';
            var B2 = logStep('Reading the in-game balance…');
            try {
                var br = await fetch('https://wax.greymass.com/v1/chain/get_table_rows', { method: 'POST',
                    body: JSON.stringify({ json: true, code: 'core.pdef', scope: wallet, table: 'balances', limit: 10 }) });
                d.bal = ((await br.json()).rows || []).map(function (x) { return x.balance; });
                logSet(B2, 'In-game balance read', 'ok');
            } catch (e) { logSet(B2, 'In-game balance unavailable', 'err'); }
            // the covered span only grows once a range has been read in full
            if (mode === 'all') { d.all = true; d.from = 0; }
            else if (!d.from || newFrom < d.from) d.from = newFrom;
            d.at = Date.now();
            save();
            var P = logStep('Checking chest prices on AtomicHub…');
            await chestInfo();
            logSet(P, 'Chest prices checked', 'ok');
            logStep('Done. Covers ' + (d.all ? 'all time' : fmtD(d.from) + ' → now'), 'done');
        } catch (e) {
            if (e !== 'stop') { T.err = 'Could not read the history: ' + ((e && e.message) || e); logStep(T.err, 'err'); }
            else if (!T.log.some(function (l) { return l.state === 'stop'; })) logStep('Stopped. Update carries on from here.', 'stop');
        }
        T.busy = false; T.stop = false;
        paint();
        if (T.next) { var m = T.next; T.next = null; readAll(m === 'switch' ? 'update' : m); }
    }
    function chestList() { var d = T.data; return d && d.mint ? Object.keys(d.mint).map(function (k) { return d.mint[k]; }) : []; }
    // template names and the last AtomicHub sale for each chest/key template
    async function chestInfo() {
        var tpls = {};
        chestList().forEach(function (c) { tpls[c[1]] = 1; });
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
                              toWallet: {}, toBal: {}, feeWallet: {}, feeBal: {}, firstBal: 0, byMonth: {} };
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
                var mon = new Date(r[0]).toISOString().slice(0, 7);
                var bmo = s.byMonth[mon] = s.byMonth[mon] || { runs: 0, fee: {}, reward: {} };
                if (kind === 'claim') bmo.runs++; else bmo[kind][sym] = (bmo[kind][sym] || 0) + x;
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
            '<button class="pdd-btn" id="st-go">' + (T.data && T.data.at ? 'Update' : 'Read history') + '</button>' +
            (T.busy ? '<button class="pdd-btn pdd-danger" id="st-stop">Stop</button>' : '') +
            (T.data && T.data.at ? '<span class="pdd-hint">Last read ' + new Date(T.data.at).toLocaleString() + '</span>' : '') + '</div>';
        if (T.data && T.data.at) h += '<div class="st-cover"><span>Covers <b>' + (T.data.all ? 'all time' : fmtD(T.data.from) + ' → now') + '</b>' +
            ' · ' + n(Object.keys(T.data.txs).length) + ' transactions read</span>' +
            (T.data.all ? '' : '<button class="pdd-btn pdd-sm" id="st-older"' + (T.busy ? ' disabled' : '') + '>Scan 6 more months</button>' +
                '<button class="pdd-btn pdd-sm" id="st-all"' + (T.busy ? ' disabled' : '') + '>Scan all time</button>') + '</div>';
        h += '<div id="st-log"></div>';
        if (T.err) h += '<div class="pdd-msg bad">' + esc(T.err) + '</div>';

        if (!T.wallet) { root.innerHTML = h + '<div class="pdd-empty">Connect a wallet or type one above.</div></div>'; bind(); return; }
        if (!T.data || (!T.data.rec.length && !T.busy)) {
            root.innerHTML = h + (T.busy ? '' : '<div class="pdd-empty">Nothing read yet for ' + esc(T.wallet) + '. Read history goes through the last 6 months of mission claims and joins once; ' +
                'busy wallets can take several minutes, and you can stop and carry on later. Older months can be added after.</div>') + '</div>';
            bind(); paintLog(); return;
        }
        var p = prices(), s = sum();
        var mine = (window.walletSession ? String(window.walletSession.actor) : '') || localStorage.getItem('naron_wallet') || '';
        var own = mine && mine === T.wallet, who = own ? 'You' : esc(T.wallet);
        var spentWax = wax(s.fee, p) + s.wdfee.TLM * p.TLM, gotWax = wax(s.reward, p), diff = gotWax - spentWax;
        var cls = diff >= 0 ? 'st-pos' : 'st-neg';
        var chestEst = 0;
        chestList().forEach(function (c) { var so = T.sold[c[1]]; if (so && so.wax && so.sym === 'WAX') chestEst += so.wax; });
        h += '<p class="pdd-hint">Values in WAX at today\'s prices: 1 DEF ≈ ' + n(p.DEF, 4) + ' WAX, 1 TLM ≈ ' + n(p.TLM, 4) + ' WAX. Chests, keys and shards are counted separately and left out of these values.</p>';
        h += '<div class="st-grid">' +
            '<div class="st-card"><span>' + (own ? 'You spent' : 'Spent') + '</span><b>' + n(spentWax, 2) + ' WAX</b><small>entry fees ' + esc(toks(s.fee)) + (s.wdfee.TLM ? '<br>withdrawal fees ' + n(s.wdfee.TLM, 2) + ' TLM' : '') + '</small></div>' +
            '<div class="st-card"><span>' + (own ? 'You received' : 'Received') + '</span><b>' + n(gotWax, 2) + ' WAX</b><small>rewards ' + esc(toks(s.reward)) + '</small></div>' +
            '<div class="st-card ' + cls + '"><span>Difference</span><b>' + (diff >= 0 ? '+' : '') + n(diff, 2) + ' WAX</b><small>' + (spentWax ? (gotWax / spentWax * 100).toFixed(0) + '% back in tokens on what you spent' : '') +
                (chestEst ? '<br>plus ' + n(chestList().length) + ' chests/keys, ~est. ' + n(chestEst, 0) + ' WAX at last sale (not counted)' : '') + '</small></div>' +
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
        chestList().forEach(function (c) { ch[c[1]] = (ch[c[1]] || 0) + 1; });
        var shardMap = window.shardMap || {}, cfgOf = {};
        try { (allMissions || []).forEach(function (m) { cfgOf[m.id] = m.rwShards || 0; }); } catch (e) {}
        Object.keys(s.byMission).forEach(function (mid) { shards += (cfgOf[mid] || 0) * s.byMission[mid].runs; });
        var estTotal = 0;
        h += '<h3 class="bas-h">Drops <small>counted, not included in the values above</small></h3><div class="st-drops">' +
            (Object.keys(ch).length ? Object.keys(ch).map(function (id) {
                var t = T.tpl[id] || {}, so = T.sold[id] || {};
                if (so.wax && so.sym === 'WAX') estTotal += so.wax * ch[id];
                var art = /quantum chest/i.test(t.name || '') ? 'https://i.imgur.com/DeM8L6i.png' : /quantum key/i.test(t.name || '') ? 'https://i.imgur.com/6l8NHuf.png' : '';
                return '<div class="st-drop">' + (art ? '<img src="' + art + '" referrerpolicy="no-referrer" alt="" loading="lazy">' : t.img ? '<img src="https://wsrv.nl/?url=ipfs.alienworlds.io/ipfs/' + esc(t.img) + '&w=96&output=webp" alt="" loading="lazy">' : '') +
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

        // per month
        var months = Object.keys(s.byMonth).sort().reverse();
        h += '<h3 class="bas-h">By month</h3><div class="pdd-wrap"><table class="pdd-table"><thead><tr><th class="txt">Month</th><th class="num">Claims</th><th class="num">Spent</th><th class="num">Earned</th><th class="num">Net in WAX</th></tr></thead><tbody>' +
            months.map(function (mo) {
                var x = s.byMonth[mo], net = wax(x.reward, p) - wax(x.fee, p);
                return '<tr><td class="txt">' + new Date(mo + '-01T00:00:00Z').toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + '</td><td class="num">' + n(x.runs) + '</td>' +
                    '<td class="num">' + esc(toks(x.fee)) + '</td><td class="num">' + esc(toks(x.reward)) + '</td>' +
                    '<td class="num ' + (net >= 0 ? 'st-pos' : 'st-neg') + '">' + (net >= 0 ? '+' : '') + n(net, 2) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
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
        paintLog();
    }
    // the progress box: a small console, orange while working, green with a tick once done
    function paintLog() {
        var el = document.getElementById('st-log');
        if (!el) return;
        if (!T.log.length) { el.innerHTML = ''; return; }
        var last = T.log[T.log.length - 1].state;
        var state = T.busy ? 'run' : last === 'done' ? 'done' : last === 'err' ? 'err' : last === 'stop' ? 'stop' : 'done';
        el.innerHTML = '<div class="st-console st-' + state + '" role="status" aria-live="polite">' + T.log.map(function (l) {
            var mark = l.state === 'ok' || l.state === 'done' ? '✓' : l.state === 'err' ? '✗' : l.state === 'stop' ? '■' : '›';
            return '<div class="st-line st-l-' + l.state + '"><span>' + mark + '</span>' + esc(l.text) + '</div>';
        }).join('') + '</div>';
    }
    function bind() {
        var go = document.getElementById('st-go'), inp = document.getElementById('st-wallet');
        var start = function () {
            var w = (inp.value || '').trim().toLowerCase(); if (!w) return;
            if (w !== T.wallet) {
                if (T.busy) { T.stop = true; T.next = 'switch'; }          // stop this wallet, then read the new one
                T.wallet = w; T.data = load(w); T.log = []; paint();
                if (T.busy) return;
            }
            readAll();
        };
        if (go) go.onclick = start;
        var sp = document.getElementById('st-stop'); if (sp) sp.onclick = function () { T.stop = true; sp.disabled = true; sp.textContent = 'Stopping…'; };
        var ol = document.getElementById('st-older'); if (ol) ol.onclick = function () { readAll('older'); };
        var al = document.getElementById('st-all'); if (al) al.onclick = function () {
            if (confirm('Scan this wallet\'s whole history? Busy wallets can have thousands of transactions; this can take a long time, and you can stop it any time.')) readAll('all');
        };
        if (inp) inp.onkeydown = function (e) { if (e.key === 'Enter') start(); };
    }

    window.pdStatsOpen = function () {
        var w = me();
        if (!T.started || (w && w !== T.wallet && !T.busy)) {
            T.started = true;
            if (w) { T.wallet = w; T.data = load(w); }
            paint();
            if (chestList().length) chestInfo().then(paint);
            if (T.wallet && !T.busy) readAll();
        } else paint();
    };
})();
