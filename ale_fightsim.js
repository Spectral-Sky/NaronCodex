// ── ALE FIGHT SIMULATOR ──────────────────────────────────────────────────────
// Rebuilds an Alien Legends battle turn by turn from its battle.ale::fights row.
// The chain keeps each row for only about a minute and stores the starting teams and
// the result, not the turns — but combat is deterministic, so the same row and
// settings always produce the same fight.
//
// simulate(row, { tauntDeduction, caps, building }) → { turns, fighters, winner, ... }
//   tauntDeduction  battle.ale::fgtconfig.taunt_deduction
//   caps            battle.ale::config.battle_stat_caps
//   building        'dungeon' | 'arena' (used by building-conditional abilities)
(function (root) {
    'use strict';

    var MAX_TURNS = 20000;
    var RES_STATS = ['res_gem', 'res_metal', 'res_air', 'res_fire', 'res_nature', 'res_neutral'];
    // stats a "<side>_<stat>_<min|max>" rule can select by
    var SELECTABLE = new Set(['taunt', 'damage', 'health', 'initiative', 'attackspeed'].concat(RES_STATS));
    // stats that pre-fight and in-fight effects may change
    var OPENING_STATS = new Set(['damage', 'attackspeed', 'health', 'initiative', 'taunt'].concat(RES_STATS));
    var FIGHT_STATS = new Set(['damage', 'attackspeed', 'health', 'health_atk', 'initiative', 'taunt'].concat(RES_STATS));

    var DEFAULT_CAPS = {
        health_min: 100, health_max: 32000, damage_min: 100, damage_max: 32000,
        taunt_min: 0, taunt_max: 32000, initiative_min: 0, initiative_max: 32000,
        attackspeed_min: 100, attackspeed_max: 32000,
        res_gem: 800, res_metal: 800, res_air: 800, res_fire: 800, res_nature: 800, res_neutral: 800
    };

    function newBattleStats() {
        return { attacks_made: 0, attacks_received: 0, damage_dealt: 0, damage_blocked_by_enemy: 0,
                 damage_taken: 0, damage_blocked: 0, knockouts: 0, survived: true };
    }

    function makeUnit(src, team, slot) {
        var unit = {
            uid: team + '-' + slot + '-' + src.fighter_id,
            team: team, slot: slot, fighter_id: src.fighter_id,
            classname: String(src.classname || ''), racename: String(src.racename || ''),
            element: String(src.element || ''), target: String(src.target || ''),
            gamertag: src.gamertag || '', owner: src.owner || '', level: src.level || 0,
            abilities: (src.specialAbility || []).slice(),
            health: src.health, max_health: src.max_health, start_health: src.health,
            damage: src.damage, taunt: src.taunt, initiative: src.initiative, attackspeed: src.attackspeed,
            bs: newBattleStats()
        };
        RES_STATS.forEach(function (r) { unit[r] = src[r]; });
        return unit;
    }

    // Chain stats are 16-bit; effects wrap to that width and are then held within the caps.
    function clampStat(stat, value, caps) {
        var v = value & 0xFFFF;
        var within = function (lo, hi) { return Math.min(Math.max(v, lo), hi); };
        switch (stat) {
            case 'damage':      return within(caps.damage_min, caps.damage_max);
            case 'initiative':  return within(caps.initiative_min, caps.initiative_max);
            case 'attackspeed': return within(caps.attackspeed_min, caps.attackspeed_max);
            case 'health':      return within(caps.health_min, caps.health_max);
            case 'taunt':       return within(caps.taunt_min, caps.taunt_max);
            default:
                if (RES_STATS.indexOf(stat) !== -1) return within(0, caps[stat]);
                return v;
        }
    }

    // Unit with the lowest (or highest) value of a stat; on a tie the earliest listed wins.
    function extreme(units, stat, highest) {
        var best = units[0];
        for (var i = 1; i < units.length; i++) {
            var u = units[i];
            if (highest ? u[stat] > best[stat] : u[stat] < best[stat]) best = u;
        }
        return best;
    }

    function isAllyRule(rule)  { return rule === 'ally_group' || rule === 'self' || rule.indexOf('ally_') === 0; }
    function isEnemyRule(rule) { return rule === 'enemy_group' || rule.indexOf('enemy_') === 0; }

    // "ally_health_min" / "enemy_taunt_max" style selectors; null when the rule isn't one
    function selectByRule(units, rule) {
        if (!units.length) return null;
        var m = /^(?:ally|enemy)_(.+)_(min|max)$/.exec(rule);
        if (!m || !SELECTABLE.has(m[1])) return null;
        return extreme(units, m[1], m[2] === 'max');
    }

    // Who an attack lands on; anything unrecognised falls back to the highest taunt.
    function attackTarget(enemies, rule) {
        var m = /^enemy_(.+)_(min|max)$/.exec(String(rule || ''));
        if (m && SELECTABLE.has(m[1])) return extreme(enemies, m[1], m[2] === 'max');
        return extreme(enemies, 'taunt', true);
    }

    function resistanceTo(unit, element) {
        var key = 'res_' + element;
        return RES_STATS.indexOf(key) !== -1 ? unit[key] : 0;
    }

    function meetsCondition(unit, ab) {
        switch (ab.condition_group) {
            case 'class':   return ab.condition_name === unit.classname;
            case 'race':    return ab.condition_name === unit.racename;
            case 'element': return ab.condition_name === unit.element;
            case 'stats': {
                var atLeast = ab.condition_minmax === 'min', atMost = ab.condition_minmax === 'max';
                var stat = String(ab.condition_name || '');
                if ((!atLeast && !atMost) || !SELECTABLE.has(stat)) return false;
                var threshold = Number(ab.condition_value || 0);
                return atLeast ? unit[stat] >= threshold : unit[stat] <= threshold;
            }
            default: return false;
        }
    }

    // How many times an ability's condition is satisfied (0 = not at all).
    function conditionCount(self, ab, allies, enemies, building) {
        if (!ab.check_condition || !ab.condition_group) return 1;
        if (ab.condition_group === 'building') return ab.condition_name === building ? 1 : 0;
        var target = String(ab.condition_target || '');
        if (target === 'self') return meetsCondition(self, ab) ? 1 : 0;
        if (target === 'ally_group')  return allies.filter(function (u) { return meetsCondition(u, ab); }).length;
        if (target === 'enemy_group') return enemies.filter(function (u) { return meetsCondition(u, ab); }).length;
        var pick = target.indexOf('ally_') === 0 ? selectByRule(allies, target)
                 : target.indexOf('enemy_') === 0 ? selectByRule(enemies, target) : null;
        return pick && meetsCondition(pick, ab) ? 1 : 0;
    }

    // "For each enemy X" abilities repeat per match; everything else applies at most once.
    function repeatCount(ab, count) {
        return (!ab.effect_on_condition_count && count > 0) ? 1 : count;
    }

    // Group abilities without check_condition still skip members that fail their condition.
    function groupMemberQualifies(unit, ab) {
        return (ab.check_condition || !ab.condition_group) ? true : meetsCondition(unit, ab);
    }

    function applyOpeningEffects(unit, effects, caps, name, sourceUid, log) {
        effects.forEach(function (fx) {
            var stat = String(fx.stat_name || '');
            if (!OPENING_STATS.has(stat)) return;
            var before = unit[stat], value = Number(fx.value);
            var after = fx.percentflat === 'percent'
                ? clampStat(stat, Math.trunc(before * (100 + value) / 100), caps)
                : clampStat(stat, Math.max(0, before + value), caps);
            unit[stat] = after;
            if (stat === 'health') unit.max_health = after;
            if (after !== before) log.push({ ability: name, sourceUid: sourceUid, targetUid: unit.uid,
                                             trigger: 'on_fight_start', stat: stat, before: before, after: after });
        });
    }

    function openingPass(team, foes, kind, building, caps, log) {
        team.forEach(function (unit) {
            unit.abilities.forEach(function (ab) {
                var rule = String(ab.bf_target || '');
                var effects = ab.bf_effects || [];
                if (!rule || ab.locked || !ab.on_fight_start || !effects.length) return;
                if (kind === 'buff' ? !isAllyRule(rule) : !isEnemyRule(rule)) return;
                var pool = kind === 'buff' ? team : foes;
                var name = ab.displayname || ab.ability || 'Special Ability';
                var times = repeatCount(ab, conditionCount(unit, ab, team, foes, building));
                for (var i = 0; i < times; i++) {
                    if (rule === 'ally_group' || rule === 'enemy_group') {
                        pool.forEach(function (t) { if (groupMemberQualifies(t, ab)) applyOpeningEffects(t, effects, caps, name, unit.uid, log); });
                    } else if (rule === 'self') {
                        applyOpeningEffects(unit, effects, caps, name, unit.uid, log);
                    } else {
                        var t = selectByRule(pool, rule);
                        if (t) applyOpeningEffects(t, effects, caps, name, unit.uid, log);
                    }
                }
            });
        });
    }

    function applyFightEffects(unit, owner, effects, dealt, caps, name, trigger, log) {
        effects.forEach(function (fx) {
            var stat = String(fx.stat_name || '');
            if (!FIGHT_STATS.has(stat)) return;
            var field = stat === 'health_atk' ? 'health' : stat;
            var before = unit[field], value = Number(fx.value), pct = fx.percentflat === 'percent', after;
            if (stat === 'health' || stat === 'health_atk') {
                // health_atk scales with the damage the triggering attack dealt
                var next = stat === 'health_atk'
                    ? before + (pct ? Math.trunc(dealt * value / 100) : value)
                    : (pct ? Math.trunc(before * (100 + value) / 100) : before + value);
                after = Math.min(Math.max(next, 0), unit.max_health);
            } else {
                after = pct ? clampStat(stat, Math.trunc(before * (100 + value) / 100), caps)
                            : clampStat(stat, Math.max(0, before + value), caps);
            }
            unit[field] = after;
            if (after !== before) log.push({ ability: name, sourceUid: owner.uid, targetUid: unit.uid,
                                             trigger: trigger, stat: field, before: before, after: after });
        });
    }

    // Attacker's on_attack abilities fire first, then the defender's on_defense abilities.
    function fireReactions(attacker, defender, attackers, defenders, building, caps, dealt, log) {
        // Conditions are judged against the attacker as it was when the blow landed — for the
        // defender's abilities too, which is how the chain resolves them.
        var attackerAtHit = Object.assign({}, attacker);

        function fire(owner, onAttack, allies, enemies) {
            owner.abilities.forEach(function (ab) {
                var rule = String(ab.bf_target || '');
                var effects = ab.if_effects || [];
                if (!rule || ab.locked || ab.on_fight_start || !effects.length) return;
                if (onAttack ? !ab.on_attack : !ab.on_defense) return;
                var allyRule = isAllyRule(rule);
                if (!allyRule && !isEnemyRule(rule)) return;
                var pool = allyRule ? allies : enemies;
                var name = ab.displayname || ab.ability || 'Special Ability';
                var trigger = onAttack ? 'on_attack' : 'on_defense';
                var times = repeatCount(ab, conditionCount(attackerAtHit, ab, allies, enemies, building));
                for (var i = 0; i < times; i++) {
                    if (rule === 'ally_group' || rule === 'enemy_group') {
                        pool.forEach(function (t) { if (groupMemberQualifies(t, ab)) applyFightEffects(t, owner, effects, dealt, caps, name, trigger, log); });
                    } else if (rule === 'self') {
                        applyFightEffects(owner, owner, effects, dealt, caps, name, trigger, log);
                    } else if (rule === 'enemy_attacker') {
                        applyFightEffects(attacker, owner, effects, dealt, caps, name, trigger, log);
                    } else {
                        var t = selectByRule(pool, rule);
                        if (t) applyFightEffects(t, owner, effects, dealt, caps, name, trigger, log);
                    }
                }
            });
        }
        fire(attacker, true, attackers, defenders);
        fire(defender, false, defenders, attackers);
    }

    function removeFallen(units) {
        for (var i = units.length - 1; i >= 0; i--) if (units[i].health === 0) units.splice(i, 1);
    }

    function snapshot(u) {
        return { uid: u.uid, health: u.health, max_health: u.max_health, initiative: u.initiative,
                 attackspeed: u.attackspeed, damage: u.damage, taunt: u.taunt };
    }

    function simulate(row, opts) {
        opts = opts || {};
        var caps = opts.caps || DEFAULT_CAPS;
        var building = opts.building || 'dungeon';
        var deduction = Number(opts.tauntDeduction || 0);

        var team1 = (row.team1_fighters || []).map(function (f, i) { return makeUnit(f, 1, i); });
        var team2 = (row.team2_fighters || []).map(function (f, i) { return makeUnit(f, 2, i); });
        var everyone = team1.concat(team2);

        var openingEffects = [];
        openingPass(team1, team2, 'buff', building, caps, openingEffects);
        openingPass(team2, team1, 'buff', building, caps, openingEffects);
        openingPass(team1, team2, 'debuff', building, caps, openingEffects);
        openingPass(team2, team1, 'debuff', building, caps, openingEffects);
        // an ability with pre-fight effects has done its work and doesn't act again
        everyone.forEach(function (u) { u.abilities = u.abilities.filter(function (ab) { return !(ab.bf_effects || []).length; }); });

        var opening = everyone.map(snapshot);
        var alive1 = team1.slice(), alive2 = team2.slice();
        var turns = [], turn = 0;

        while (alive1.length && alive2.length && turn < MAX_TURNS) {
            turn++;
            var next1 = extreme(alive1, 'initiative', false), next2 = extreme(alive2, 'initiative', false);
            var team1Acts = next1.initiative <= next2.initiative;
            var attacker = team1Acts ? next1 : next2;
            var allies = team1Acts ? alive1 : alive2, foes = team1Acts ? alive2 : alive1;
            var defender = attackTarget(foes, attacker.target);

            var ignore = 0;
            attacker.abilities.forEach(function (ab) { if (ab.on_attack && !ab.locked) ignore += Number(ab.ignore_res_percent || 0); });
            if (ignore > 100) ignore = 100;

            var element = attacker.element;
            var resisted  = Math.floor(resistanceTo(defender, element) * (100 - ignore) / 100);
            var resistPct = Math.trunc(resisted / 10);
            var landed    = Math.max(0, 100 - resistPct);
            var raw       = Math.trunc(attacker.damage * landed / 100);
            var dealt     = Math.min(raw, defender.health);
            var blocked   = Math.trunc(raw * resistPct / 100);
            var hpBefore  = defender.health;
            var killed    = dealt >= defender.health;
            var clock     = attacker.initiative;

            if (killed) { attacker.bs.knockouts++; defender.bs.survived = false; }
            attacker.bs.damage_dealt += dealt;
            attacker.bs.damage_blocked_by_enemy += blocked;
            defender.bs.damage_taken += dealt;
            defender.bs.damage_blocked += blocked;
            attacker.bs.attacks_made++;
            defender.bs.attacks_received++;

            if (defender.health > dealt) {
                defender.taunt = defender.taunt > deduction ? defender.taunt - deduction : 0;
                defender.health -= dealt;
            } else {
                defender.health = 0;
            }
            attacker.initiative += attacker.attackspeed;

            var effects = [];
            fireReactions(attacker, defender, allies, foes, building, caps, dealt, effects);
            if (killed) defender.health = 0;   // a heal can't save a fighter the blow already knocked out
            removeFallen(alive1);
            removeFallen(alive2);

            turns.push({
                turn: turn, attackerUid: attacker.uid, defenderUid: defender.uid,
                damage: dealt, raw: raw, blocked: blocked, effectiveness: landed, element: element,
                killed: killed, defenderHealthBefore: hpBefore, defenderHealthAfter: defender.health,
                defenderMaxHealth: defender.max_health, attackerHealth: attacker.health, clock: clock,
                effects: effects, snapshot: everyone.map(snapshot)
            });
        }

        var winner = alive2.length === 0 ? 1 : alive1.length === 0 ? 2 : null;
        var log = winner === 1 ? 'Team 1 wins' : winner === 2 ? 'Team 2 wins' : 'Draw';
        return {
            turns: turns, fighters: everyone, opening: opening, openingEffects: openingEffects,
            winner: winner, log: log, chainLog: row.log, chainTurns: row.turns,
            matchesChain: !row.log || (row.log === log && (!row.turns || Number(row.turns) === turn))
        };
    }

    var api = { simulate: simulate, DEFAULT_CAPS: DEFAULT_CAPS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AleFightSim = api;
})(typeof window !== 'undefined' ? window : this);
