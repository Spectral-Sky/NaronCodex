// ── ALE STATS INSIGHTS ───────────────────────────────────────────────────────
// Over-time sections for the ale.html stats page, built from the fights sheet CSV:
//   active players · dungeon win rate by difficulty · class/race/element meta ·
//   best team compositions · busiest hours
//
//   AleInsights.render(csv, element)
//   AleInsights.analyse(csv)   plain data, no DOM (used for testing)
(function (root) {
    'use strict';

    var WEEKLY_AFTER_DAYS = 35;   // daily points until the sheet spans more than this
    var MIN_CELL_FIGHTS   = 10;   // heatmap cells with fewer fights are left blank
    var MIN_COMP_FIGHTS   = 30;   // team compositions need this many fights to be listed
    var META_TOP          = 8;    // lines on the meta chart
    var COLORS = ['#e8a020', '#e05a5a', '#50dc8c', '#60b8ff', '#c080ff', '#ffd060', '#ff80b0', '#80e0e0', '#a0a0a0'];
    var WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // Sheet timestamps look like "2026-09-01 4:21:44" (UTC, unpadded hour)
    function parseTs(s) {
        var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/.exec(s);
        if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        var t = Date.parse(s.indexOf('Z') >= 0 ? s : s + 'Z');
        return isNaN(t) ? null : t;
    }
    function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
    // Monday of the ms's UTC week, as a day string
    function weekStart(ms) {
        var d = new Date(ms), dow = (d.getUTCDay() + 6) % 7;
        return utcDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    }
    function dayRange(from, to) {
        var out = [], t = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z');
        for (; t <= end; t += 86400000) out.push(utcDay(t));
        return out;
    }

    function bump(map, key, won) {
        var e = map[key] || (map[key] = { played: 0, wins: 0 });
        e.played++;
        if (won) e.wins++;
    }

    function analyse(csv) {
        var lines = String(csv || '').replace(/\r/g, '').split('\n');
        var hdr = (lines[0] || '').split(',').map(function (h) { return h.replace(/"/g, '').trim().toLowerCase(); });
        var ix = {};
        ['wallet', 'timestamp', 'fight_type', 'dungeon_difficulty', 'winner',
         'team1_classes', 'team1_races', 'team1_elements'].forEach(function (k) { ix[k] = hdr.indexOf(k); });
        function col(c, k) { return ix[k] >= 0 ? (c[ix[k]] || '').replace(/"/g, '').trim() : ''; }

        var fights = [], minMs = Infinity, maxMs = -Infinity;
        for (var i = 1; i < lines.length; i++) {
            if (!lines[i]) continue;
            var c = lines[i].split(',');
            var ms = parseTs(col(c, 'timestamp'));
            if (ms == null) continue;
            if (ms < minMs) minMs = ms;
            if (ms > maxMs) maxMs = ms;
            fights.push({
                ms: ms, wallet: col(c, 'wallet'), type: col(c, 'fight_type'),
                diff: Number(col(c, 'dungeon_difficulty') || 0), won: Number(col(c, 'winner') || 1) === 1,
                classes: col(c, 'team1_classes').split('|').filter(Boolean),
                races: col(c, 'team1_races').split('|').filter(Boolean),
                // elements list the weapon NFT slot too; keep only the five fighters
                elements: col(c, 'team1_elements').split('|').filter(Boolean).slice(0, 5)
            });
        }
        if (!fights.length) return null;

        var firstDay = utcDay(minMs), lastDay = utcDay(maxMs), today = utcDay(Date.now());
        var days = dayRange(firstDay, lastDay > today ? lastDay : today);
        var weekly = days.length > WEEKLY_AFTER_DAYS;
        var bucketOf = weekly ? function (ms) { return weekStart(ms); } : utcDay;
        var buckets = [];
        days.forEach(function (d) { var b = bucketOf(Date.parse(d + 'T00:00:00Z')); if (buckets[buckets.length - 1] !== b) buckets.push(b); });

        // active players: unique wallets per day, and over the 7 days ending that day
        var walletsByDay = {};
        fights.forEach(function (f) {
            if (!f.wallet) return;
            var d = utcDay(f.ms);
            (walletsByDay[d] || (walletsByDay[d] = {}))[f.wallet] = 1;
        });
        var daily = days.map(function (d) { return walletsByDay[d] ? Object.keys(walletsByDay[d]).length : 0; });
        var rolling7 = days.map(function (d, k) {
            var u = {};
            for (var j = Math.max(0, k - 6); j <= k; j++) Object.keys(walletsByDay[days[j]] || {}).forEach(function (w) { u[w] = 1; });
            return Object.keys(u).length;
        });

        // dungeon win rate: difficulty × bucket
        var diffGrid = {}, diffTotals = {};
        // meta: per bucket, fights with a known team, and per key {played, wins} counted once per team
        var meta = { classes: {}, races: {}, elements: {} }, metaTeams = {}, metaTotals = { classes: {}, races: {}, elements: {} };
        var comps = { dungeon: {}, arena: {} };
        var hours = WEEKDAYS.map(function () { return new Array(24).fill(0); });

        fights.forEach(function (f) {
            var b = bucketOf(f.ms), dt = new Date(f.ms);
            hours[(dt.getUTCDay() + 6) % 7][dt.getUTCHours()]++;

            if (f.type === 'dungeon' && f.diff > 0) {
                bump(diffGrid[f.diff] || (diffGrid[f.diff] = {}), b, f.won);
                bump(diffTotals, f.diff, f.won);
            }
            if (f.classes.length) {
                metaTeams[b] = (metaTeams[b] || 0) + 1;
                ['classes', 'races', 'elements'].forEach(function (kind) {
                    var seen = {};
                    f[kind].forEach(function (k) { seen[k.toLowerCase()] = 1; });
                    Object.keys(seen).forEach(function (k) {
                        bump(meta[kind][k] || (meta[kind][k] = {}), b, f.won);
                        bump(metaTotals[kind], k, f.won);
                    });
                });
                if ((f.type === 'dungeon' || f.type === 'arena') && f.classes.length === 5) {
                    var key = f.classes.map(function (s) { return s.toLowerCase(); }).sort().join('|');
                    var e = comps[f.type][key] || (comps[f.type][key] = { played: 0, wins: 0, diffSum: 0, diffs: {} });
                    e.played++;
                    if (f.won) e.wins++;
                    e.diffSum += f.diff;
                    e.diffs[f.diff] = (e.diffs[f.diff] || 0) + 1;
                }
            }
        });

        // Dungeon win rate mostly reflects the difficulty chosen, so each line-up is also
        // compared with what an average team wins at the same mix of levels.
        function rankComps(map, isDungeon) {
            return Object.keys(map).map(function (k) {
                var e = map[k], rate = e.wins / e.played * 100, expected = null;
                if (isDungeon) {
                    var sum = 0;
                    Object.keys(e.diffs).forEach(function (lv) {
                        var t = diffTotals[lv];
                        if (t) sum += e.diffs[lv] * (t.wins / t.played * 100);
                    });
                    expected = sum / e.played;
                }
                return { classes: k.split('|'), played: e.played, wins: e.wins, rate: rate,
                         avgDiff: e.diffSum / e.played, vsAvg: expected == null ? null : rate - expected };
            }).filter(function (c) { return c.played >= MIN_COMP_FIGHTS; });
        }

        return {
            fights: fights.length, firstDay: firstDay, lastDay: lastDay, today: today,
            days: days, weekly: weekly, buckets: buckets,
            active: { daily: daily, rolling7: rolling7 },
            difficulty: { grid: diffGrid, totals: diffTotals },
            meta: { byKind: meta, teams: metaTeams, totals: metaTotals },
            comps: { dungeon: rankComps(comps.dungeon, true), arena: rankComps(comps.arena, false) },
            hours: hours
        };
    }

    // ── rendering ────────────────────────────────────────────────────────────
    var CSS = ''
        + '.ain-sec{margin-bottom:34px;}'
        + '.ain-h{font-size:0.6em;letter-spacing:3px;color:rgba(232,160,32,0.55);margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid rgba(232,160,32,0.1);}'
        + '.ain-note{font-size:0.58em;color:#505060;letter-spacing:1px;margin-bottom:10px;line-height:1.6;}'
        + '.ain-tabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px;align-items:center;}'
        + '.ain-tabs button{background:transparent;border:1px solid rgba(232,160,32,0.2);color:#808070;font-family:"Courier New",monospace;font-size:0.63em;padding:4px 10px;cursor:pointer;letter-spacing:1px;}'
        + '.ain-tabs button.on{border-color:rgba(232,160,32,0.75);color:#e8a020;background:rgba(232,160,32,0.07);}'
        + '.ain-tabs .ain-sep{width:10px;}'
        + '.ain-wrap{overflow-x:auto;}'
        // ale.html styles every table and cell with !important (hidden until "system-ready",
        // transparent backgrounds, borders, padding, fonts), so these rules must use it too
        + 'table.ain-heat,table.ain-comp{opacity:1!important;visibility:visible!important;}'
        + '.ain-heat{border-collapse:separate;border-spacing:2px;font-family:"Courier New",monospace;font-size:0.62em;}'
        + '.ain-heat th{color:#606878;font-weight:normal;padding:2px 4px;white-space:nowrap;}'
        + '.ain-heat td,.ain-heat td:first-of-type,.ain-heat td:nth-child(3),.ain-heat td:last-child{min-width:34px;max-width:none;height:22px;text-align:center!important;color:#0a0c12;border:none!important;border-radius:2px;padding:0 3px!important;white-space:nowrap!important;font-family:"Courier New",monospace!important;font-size:1em!important;font-variant-numeric:tabular-nums;}'
        + '.ain-heat td.empty{background-color:rgba(255,255,255,0.03)!important;color:#404450!important;}'
        + '.ain-heat th.rowh{text-align:right;color:#9098a8;}'
        + '.ain-comp{width:100%;border-collapse:collapse;font-family:"Courier New",monospace;font-size:0.66em;}'
        + '.ain-comp th{color:#606878;font-weight:normal;text-align:left;padding:4px 8px;border-bottom:1px solid rgba(232,160,32,0.12);letter-spacing:1px;}'
        + '.ain-comp td,.ain-comp td:first-of-type,.ain-comp td:nth-child(3),.ain-comp td:last-child{padding:5px 8px!important;border:none!important;border-bottom:1px solid rgba(255,255,255,0.04)!important;color:#c0c4cc!important;text-align:left!important;max-width:none;white-space:nowrap!important;font-family:"Courier New",monospace!important;font-size:1em!important;font-variant-numeric:tabular-nums;}'
        + '.ain-comp td:nth-child(2){white-space:normal!important;}'
        + '.ain-comp td.num{text-align:right!important;} .ain-comp th.num{text-align:right;}'
        + '.ain-cls{display:inline-block;border:1px solid rgba(232,160,32,0.2);color:#d8b870;padding:0 5px;margin:1px 2px 1px 0;border-radius:3px;text-transform:capitalize;}'
        + '.ain-bar{display:inline-block;height:6px;background:#50dc8c;border-radius:3px;vertical-align:middle;margin-left:6px;opacity:0.8;}';

    var _charts = [];
    function destroyCharts() { _charts.forEach(function (c) { try { c.destroy(); } catch (e) {} }); _charts = []; }

    function label(bucket, weekly) { return weekly ? 'wk ' + bucket.slice(5) : bucket.slice(5); }
    function hasChart() { return typeof root.Chart !== 'undefined'; }

    function lineOptions(yExtra) {
        return {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#9098a8', font: { size: 11 }, boxWidth: 12 } } },
            scales: {
                x: { ticks: { color: '#606878' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: Object.assign({ beginAtZero: true, ticks: { color: '#606878' }, grid: { color: 'rgba(255,255,255,0.04)' } }, yExtra || {})
            }
        };
    }
    function series(lbl, color, data, dashed) {
        return { label: lbl, data: data, borderColor: color, backgroundColor: color, borderWidth: 2,
                 pointRadius: 2, tension: 0.25, spanGaps: false, borderDash: dashed ? [5, 4] : [] };
    }

    // green (high win %) → amber → red (low)
    function rateColor(p) {
        var t = Math.max(0, Math.min(1, p / 100));
        var r = t < 0.5 ? 224 : Math.round(224 - (t - 0.5) * 2 * 144);
        var g = t < 0.5 ? Math.round(90 + t * 2 * 70) : Math.round(160 + (t - 0.5) * 2 * 60);
        var b = t < 0.5 ? 90 : Math.round(90 + (t - 0.5) * 2 * 50);
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function sectionActive(a) {
        var h = '<div class="ain-sec"><div class="ain-h">◈ ACTIVE PLAYERS</div>'
            + '<div class="ain-note">Unique wallets that fought, per day (UTC) · dashed line: unique wallets over the 7 days ending that day · today is still counting</div>'
            + '<div style="position:relative;height:240px;"><canvas id="ain-active"></canvas></div></div>';
        return { html: h, mount: function () {
            if (!hasChart()) return;
            _charts.push(new root.Chart(document.getElementById('ain-active'), {
                type: 'line',
                data: { labels: a.days.map(function (d, i) { return d.slice(5) + (d === a.today ? '*' : ''); }), datasets: [
                    series('Daily', '#60b8ff', a.active.daily),
                    series('Last 7 days', '#e8a020', a.active.rolling7, true)
                ]},
                options: lineOptions()
            }));
        }};
    }

    function sectionDifficulty(a) {
        // levels almost nobody plays would only add rows of blank cells
        var levels = Object.keys(a.difficulty.grid).map(Number)
            .filter(function (lv) { return a.difficulty.totals[lv].played >= MIN_CELL_FIGHTS; })
            .sort(function (x, y) { return y - x; });
        var rows = levels.map(function (lv) {
            var cells = a.buckets.map(function (b) {
                var e = a.difficulty.grid[lv][b];
                if (!e || e.played < MIN_CELL_FIGHTS) return '<td class="empty" title="' + (e ? e.played : 0) + ' fights">·</td>';
                var p = e.wins / e.played * 100;
                return '<td style="background-color:' + rateColor(p) + '!important" title="Level ' + lv + ' · ' + label(b, a.weekly) + ' · '
                    + e.wins + ' wins / ' + e.played + ' fights">' + Math.round(p) + '</td>';
            }).join('');
            var t = a.difficulty.totals[lv];
            var all = t.played >= MIN_CELL_FIGHTS
                ? '<td style="background-color:' + rateColor(t.wins / t.played * 100) + '!important" title="' + t.wins + ' / ' + t.played + ' fights">' + Math.round(t.wins / t.played * 100) + '</td>'
                : '<td class="empty">·</td>';
            return '<tr><th class="rowh">LVL ' + lv + '</th>' + cells + '<th></th>' + all + '</tr>';
        }).join('');
        var h = '<div class="ain-sec"><div class="ain-h">◈ DUNGEON WIN RATE BY DIFFICULTY</div>'
            + '<div class="ain-note">Win % per ' + (a.weekly ? 'week (starting Monday)' : 'day') + ' · green high, red low · blank: fewer than '
            + MIN_CELL_FIGHTS + ' fights · hover a cell for counts</div>'
            + '<div class="ain-wrap"><table class="ain-heat system-ready"><thead><tr><th></th>'
            + a.buckets.map(function (b) { return '<th>' + label(b, a.weekly) + '</th>'; }).join('')
            + '<th></th><th>ALL</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
        return { html: h };
    }

    function sectionMeta(a) {
        var state = { kind: 'classes', measure: 'pick' };
        var h = '<div class="ain-sec"><div class="ain-h">◈ META OVER TIME</div>'
            + '<div class="ain-tabs" id="ain-meta-tabs">'
            + '<button data-kind="classes" class="on">CLASS</button><button data-kind="races">RACE</button><button data-kind="elements">ELEMENT</button>'
            + '<span class="ain-sep"></span>'
            + '<button data-measure="pick" class="on">PICK RATE</button><button data-measure="win">WIN RATE</button>'
            + '</div>'
            + '<div class="ain-note" id="ain-meta-note"></div>'
            + '<div style="position:relative;height:300px;"><canvas id="ain-meta"></canvas></div></div>';

        function draw() {
            var byKey = a.meta.byKind[state.kind], totals = a.meta.totals[state.kind];
            var top = Object.keys(totals).sort(function (x, y) { return totals[y].played - totals[x].played; }).slice(0, META_TOP);
            var datasets = top.map(function (k, i) {
                return series(k.charAt(0).toUpperCase() + k.slice(1), COLORS[i % COLORS.length], a.buckets.map(function (b) {
                    var e = byKey[k][b], teams = a.meta.teams[b] || 0;
                    if (state.measure === 'pick') return teams ? Math.round((e ? e.played : 0) / teams * 1000) / 10 : null;
                    return e && e.played >= MIN_CELL_FIGHTS ? Math.round(e.wins / e.played * 1000) / 10 : null;
                }));
            });
            var noun = { classes: 'class', races: 'race', elements: 'element' }[state.kind];
            document.getElementById('ain-meta-note').textContent = state.measure === 'pick'
                ? '% of teams with at least one fighter of each ' + noun + ', per ' + (a.weekly ? 'week' : 'day') + ' · the ' + top.length + ' most used ' + noun + (top.length === 1 ? '' : (noun === 'class' ? 'es' : 's')) + ' · the fighting player\'s team only'
                : 'Win % of teams with at least one fighter of each ' + noun + ', per ' + (a.weekly ? 'week' : 'day') + ' · dungeon and arena combined · gaps: fewer than ' + MIN_CELL_FIGHTS + ' fights';
            if (!hasChart()) return;
            var old = _charts.filter(function (c) { return c.canvas && c.canvas.id === 'ain-meta'; })[0];
            if (old) { old.destroy(); _charts.splice(_charts.indexOf(old), 1); }
            _charts.push(new root.Chart(document.getElementById('ain-meta'), {
                type: 'line',
                data: { labels: a.buckets.map(function (b) { return label(b, a.weekly) + (b === a.today ? '*' : ''); }), datasets: datasets },
                options: lineOptions({ ticks: { color: '#606878', callback: function (v) { return v + '%'; } } })
            }));
        }
        return { html: h, mount: function () {
            document.getElementById('ain-meta-tabs').addEventListener('click', function (e) {
                var btn = e.target.closest('button');
                if (!btn) return;
                var attr = btn.dataset.kind ? 'kind' : 'measure';
                state[attr] = btn.dataset[attr];
                this.querySelectorAll('[data-' + attr + ']').forEach(function (b) { b.classList.toggle('on', b === btn); });
                draw();
            });
            draw();
        }};
    }

    function sectionComps(a) {
        var state = { venue: 'dungeon', sort: 'rate' };
        var h = '<div class="ain-sec"><div class="ain-h">◈ BEST TEAM COMPOSITIONS</div>'
            + '<div class="ain-tabs" id="ain-comp-tabs">'
            + '<button data-venue="dungeon" class="on">DUNGEON</button><button data-venue="arena">ARENA</button>'
            + '<span class="ain-sep"></span>'
            + '<button data-sort="rate" class="on">BEST</button><button data-sort="played">MOST PLAYED</button>'
            + '</div>'
            + '<div class="ain-note" id="ain-comp-note"></div>'
            + '<div class="ain-wrap" id="ain-comp-body"></div></div>';
        function draw() {
            var dung = state.venue === 'dungeon';
            document.getElementById('ain-comp-note').textContent = 'Five-class line-ups, in any order · at least ' + MIN_COMP_FIGHTS + ' fights · all time in the sheet'
                + (dung ? ' · VS AVG: win % minus what an average team wins at the same difficulty levels, so easy-dungeon teams don\'t top the list' : '');
            var list = a.comps[state.venue].slice().sort(state.sort === 'rate'
                ? (dung ? function (x, y) { return y.vsAvg - x.vsAvg || y.played - x.played; }
                        : function (x, y) { return y.rate - x.rate || y.played - x.played; })
                : function (x, y) { return y.played - x.played; }).slice(0, 15);
            var body = document.getElementById('ain-comp-body');
            if (!list.length) { body.innerHTML = '<div class="ain-note">No line-up has ' + MIN_COMP_FIGHTS + '+ fights yet.</div>'; return; }
            body.innerHTML = '<table class="ain-comp system-ready"><thead><tr><th>#</th><th>LINE-UP</th><th class="num">FIGHTS</th><th class="num">WIN %</th>'
                + (dung ? '<th class="num">AVG LVL</th><th class="num">VS AVG</th>' : '') + '</tr></thead><tbody>'
                + list.map(function (c, i) {
                    return '<tr><td>' + (i + 1) + '</td><td>' + c.classes.map(function (k) { return '<span class="ain-cls">' + esc(k) + '</span>'; }).join('') + '</td>'
                        + '<td class="num">' + c.played.toLocaleString() + '</td>'
                        + '<td class="num">' + c.rate.toFixed(1) + '%<span class="ain-bar" style="width:' + Math.round(c.rate * 0.5) + 'px"></span></td>'
                        + (dung ? '<td class="num">' + c.avgDiff.toFixed(1) + '</td>'
                            + '<td class="num" style="color:' + (c.vsAvg >= 0 ? '#50dc8c' : '#e05a5a') + '">' + (c.vsAvg >= 0 ? '+' : '') + c.vsAvg.toFixed(1) + '</td>' : '') + '</tr>';
                }).join('') + '</tbody></table>';
        }
        return { html: h, mount: function () {
            document.getElementById('ain-comp-tabs').addEventListener('click', function (e) {
                var btn = e.target.closest('button');
                if (!btn) return;
                var attr = btn.dataset.venue ? 'venue' : 'sort';
                state[attr] = btn.dataset[attr];
                this.querySelectorAll('[data-' + attr + ']').forEach(function (b) { b.classList.toggle('on', b === btn); });
                draw();
            });
            draw();
        }};
    }

    function sectionHours(a) {
        var max = 0;
        a.hours.forEach(function (r) { r.forEach(function (v) { if (v > max) max = v; }); });
        var rows = a.hours.map(function (r, d) {
            return '<tr><th class="rowh">' + WEEKDAYS[d] + '</th>' + r.map(function (v, hr) {
                if (!v) return '<td class="empty" title="' + WEEKDAYS[d] + ' ' + hr + ':00 UTC · 0 fights">·</td>';
                var t = v / max;
                return '<td style="background-color:rgba(96,184,255,' + (0.12 + t * 0.88).toFixed(2) + ')!important;color:' + (t > 0.45 ? '#0a0c12' : '#c8d4e4') + '!important" title="'
                    + WEEKDAYS[d] + ' ' + hr + ':00–' + (hr + 1) + ':00 UTC · ' + v.toLocaleString() + ' fights">' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v) + '</td>';
            }).join('') + '</tr>';
        }).join('');
        var h = '<div class="ain-sec"><div class="ain-h">◈ BUSIEST HOURS</div>'
            + '<div class="ain-note">Total fights by weekday and hour (UTC) across the whole sheet · darker is busier · your local time is UTC'
            + (function () { var o = -new Date().getTimezoneOffset() / 60; return (o >= 0 ? '+' : '') + o; })() + '</div>'
            + '<div class="ain-wrap"><table class="ain-heat system-ready"><thead><tr><th></th>'
            + Array.apply(null, Array(24)).map(function (_, i) { return '<th>' + (i < 10 ? '0' : '') + i + '</th>'; }).join('')
            + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
        return { html: h };
    }

    function render(csv, el) {
        if (!el) return;
        destroyCharts();
        var a = analyse(csv);
        if (!a) { el.innerHTML = ''; return; }
        if (!document.getElementById('ain-css')) {
            var st = document.createElement('style');
            st.id = 'ain-css';
            st.textContent = CSS;
            document.head.appendChild(st);
        }
        var sections = [sectionActive(a), sectionDifficulty(a), sectionMeta(a), sectionComps(a), sectionHours(a)];
        el.innerHTML = sections.map(function (s) { return s.html; }).join('');
        if (!hasChart()) {
            el.insertAdjacentHTML('afterbegin', '<div class="ain-note">Chart library failed to load — charts are hidden.</div>');
        }
        sections.forEach(function (s) { if (s.mount) s.mount(); });
    }

    var api = { render: render, analyse: analyse };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AleInsights = api;
})(typeof window !== 'undefined' ? window : this);
