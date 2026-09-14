// ── ALIEN WORLDS LAND BOOST PLANNER ──────────────────────────────────────────
// Works out which boosts to send for a wallet's lands without ever including one the
// contract would reject — a single rejected boost fails the whole transaction.
//
// Facts checked against chain history (Sep 2026):
//  - A boost multiplies the land's rating: 4 TLM ×1.0003, 8 ×1.0005, 16 ×1.0008,
//    32 ×1.0013, 64 ×1.0021. The boost that crosses the cap only lifts it to the cap
//    (full TLM is still charged) and sets TopReachedAt; boosting a capped land fails.
//  - The cap is awlndratings::global2 "top_landrating" (4 implied decimals).
//  - A land takes at most `openslots` boosts per day (land NFT mutable data).
//  - The contract day is the UTC day number minus 828 (day 19882 = 2026-09-14),
//    so slots reset at 00:00 UTC.
//  - Owners can set MinBoostAmount (4 decimals); smaller boosts are refused.
(function (root) {
    'use strict';

    var LEVELS = [
        { tlm: 4,  pct: 0.03, name: 'Small Boost' },
        { tlm: 8,  pct: 0.05, name: 'Lv 2 Boost' },
        { tlm: 16, pct: 0.08, name: 'Medium Boost' },
        { tlm: 32, pct: 0.13, name: 'Lv 4 Boost' },
        { tlm: 64, pct: 0.21, name: 'High Boost' }
    ];
    var DAY_OFFSET = 828;
    var PER_TX     = 20;      // boosts per transaction (2 actions each)
    // Ratings grow a hair faster than the nominal % on some lands (×1.00211 seen for
    // ×1.0021), so treat a boost as reaching the cap slightly early. Stopping one boost
    // short is harmless; sending one boost too many fails the whole transaction.
    var CAP_MARGIN = 1.0001;

    function level(tlm) {
        for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].tlm === tlm) return LEVELS[i];
        throw new Error('Unknown boost level ' + tlm);
    }
    function multiplier(tlm) { return 1 + level(tlm).pct / 100; }
    function contractDay(nowMs) { return Math.floor((nowMs == null ? Date.now() : nowMs) / 86400000) - DAY_OFFSET; }
    function msUntilReset(nowMs) { var n = nowMs == null ? Date.now() : nowMs; return 86400000 - (n % 86400000); }

    // Normalise a land from its NFT data (+ optional boosts-table row) for the given day.
    // land: { asset_id, name, planet, x, y, img, rating, slots, minBoost, lastDay, usedDay, boostRow }
    function status(land, cap, day) {
        var used = 0;
        if (land.boostRow && land.boostRow.day === day) used = land.boostRow.boosts_used.length;
        else if (land.lastDay === day) used = land.usedDay || 0;
        var slots = land.slots || 0;
        return {
            used: used,
            slots: slots,
            remaining: Math.max(0, slots - used),
            capped: land.rating >= cap,
            pctOfCap: cap > 0 ? Math.min(100, land.rating / cap * 100) : 0,
            minTlm: (land.minBoost || 0) / 10000
        };
    }

    // Boosts needed from `rating` to reach `cap` at one level, counting the capping boost.
    function boostsToCap(rating, cap, tlm) {
        if (rating >= cap) return 0;
        var m = multiplier(tlm), n = 0, r = rating;
        while (r * CAP_MARGIN < cap && n < 1e6) { r *= m; n++; if (r * CAP_MARGIN >= cap) break; }
        return n;
    }

    // How long until the land is capped if every slot is used at `tlm` from now on.
    function forecast(land, cap, day, tlm) {
        var s = status(land, cap, day);
        var n = boostsToCap(land.rating, cap, tlm);
        if (!n) return { boosts: 0, days: 0, tlm: 0, today: true };
        if (!s.slots) return { boosts: n, days: null, tlm: n * tlm };
        var rest = Math.max(0, n - s.remaining);
        return { boosts: n, tlm: n * tlm, today: rest === 0, days: rest === 0 ? 0 : Math.ceil(rest / s.slots) };
    }

    // Smallest level the land accepts that still reaches the cap from `rating`. No safety
    // margin here: a level that falls just short would leave the land below max.
    function cheapestCapping(rating, cap, minTlm, fallback) {
        for (var i = 0; i < LEVELS.length; i++) {
            var L = LEVELS[i];
            if (L.tlm < minTlm) continue;
            if (rating * multiplier(L.tlm) >= cap) return L.tlm;
        }
        return fallback;
    }

    // mode: 'once' = one boost per eligible land; 'fill' = every remaining slot today.
    // downgrade: { asset_id: true } lands whose capping boost should use the cheapest level.
    function plan(lands, opts) {
        var cap = opts.cap, day = opts.day, tlm = opts.tlm, mode = opts.mode, downgrade = opts.downgrade || {};
        var perLand = [], skipped = [];
        lands.forEach(function (land) {
            var s = status(land, cap, day);
            if (s.capped)            { skipped.push({ land: land, reason: 'max' });  return; }
            if (!s.remaining)        { skipped.push({ land: land, reason: 'full' }); return; }
            if (tlm < s.minTlm)      { skipped.push({ land: land, reason: 'min', minTlm: s.minTlm }); return; }
            var want = mode === 'fill' ? s.remaining : 1;
            var list = [], r = land.rating;
            for (var i = 0; i < want; i++) {
                var use = tlm, reaches = r * multiplier(tlm) * CAP_MARGIN >= cap;
                if (reaches && downgrade[land.asset_id]) use = cheapestCapping(r, cap, s.minTlm, tlm);
                list.push({ land_id: String(land.asset_id), tlm: use, reachesCap: reaches });
                if (reaches) break;              // anything after this would hit a capped land
                r *= multiplier(tlm);
            }
            perLand.push(list);
        });
        // Interleave lands, so if a later transaction is cancelled every land still got boosts
        var boosts = [];
        for (var k = 0; perLand.some(function (l) { return l.length > k; }); k++) {
            perLand.forEach(function (l) { if (l[k]) boosts.push(l[k]); });
        }
        return {
            boosts: boosts,
            skipped: skipped,
            totalTlm: boosts.reduce(function (s, b) { return s + b.tlm; }, 0)
        };
    }

    function qty(tlm) { return Number(tlm).toFixed(4) + ' TLM'; }

    function actionsFor(boosts, wallet) {
        var auth = [{ actor: wallet, permission: 'active' }], out = [];
        boosts.forEach(function (b) {
            out.push({ account: 'alien.worlds', name: 'transfer', authorization: auth,
                       data: { from: wallet, to: 'boost.worlds', quantity: qty(b.tlm), memo: 'landrating - boostslot for ' + b.land_id } });
            out.push({ account: 'awlndratings', name: 'boost', authorization: auth,
                       data: { land_id: b.land_id, amount: qty(b.tlm), payer: wallet } });
        });
        return out;
    }

    function batches(boosts, perTx) {
        perTx = perTx || PER_TX;
        var out = [];
        for (var i = 0; i < boosts.length; i += perTx) out.push(boosts.slice(i, i + perTx));
        return out;
    }

    var api = { LEVELS: LEVELS, DAY_OFFSET: DAY_OFFSET, PER_TX: PER_TX, multiplier: multiplier,
                contractDay: contractDay, msUntilReset: msUntilReset, status: status,
                boostsToCap: boostsToCap, forecast: forecast, plan: plan, actionsFor: actionsFor, batches: batches };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LandBoost = api;
})(typeof window !== 'undefined' ? window : this);
