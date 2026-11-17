// Most active planets: every arena and dungeon fight (battle.ale::fight carries the planet it
// was fought on) plus every tavern hire (each hire's draw bumps the tavern's score with
// lands.ale::addtavernscr, which names the planet), over the last 24 h or 7 days.
// Planets are the same three.js spheres as the land page, ranked left to right.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

const NAMES = ['eyeke', 'kavian', 'magor', 'naron', 'neri', 'veles'];
const HIST = ['https://wax.eosusa.io', 'https://wax-history.eosdac.io', 'https://hyperion.wax.detroitledger.tech', 'https://history.waxsweden.org'];
const DAY = 86400e3, CACHE_MS = 15 * 60e3;
const IC = {};
[['arena', 'Arena'], ['dungeon', 'dungeon'], ['tavern', 'tavern']].forEach(([k, f]) => IC[k] = '<img class="bi" alt="" src="Ale%20images/' + f + '.svg">');
const box = document.getElementById('planets');
if (box) start();

function start() {
    const S = { per: '24h', data: {}, busy: {} };
    box.innerHTML = '<div class="sec-head"><h2>Most active planets <small id="pl-sub"></small></h2>' +
        '<div class="sper" data-own="1" role="group" aria-label="Period"><button type="button" data-p="24h" class="on">24 h</button><button type="button" data-p="7d">7 days</button></div></div>' +
        '<div class="pl-stage"><canvas id="pl-canvas" aria-hidden="true"></canvas><div class="pl-cols" id="pl-cols"></div></div>' +
        '<p class="sub" id="pl-note" style="margin:6px 0 0">' + IC.arena + 'Arena and ' + IC.dungeon + 'dungeon fights on the planet, plus ' + IC.tavern + 'tavern hires drawn there.</p>';
    box.querySelectorAll('.sper button').forEach(b => b.onclick = () => {
        S.per = b.getAttribute('data-p');
        box.querySelectorAll('.sper button').forEach(x => x.classList.toggle('on', x === b));
        load();
    });

    /* ── scene (as land.worlds.html: orthographic, so spheres stay round) ── */
    const canvas = document.getElementById('pl-canvas'), stage = box.querySelector('.pl-stage');
    const H = 130, FRUSTUM_H = 4;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, FRUSTUM_H / 2, -FRUSTUM_H / 2, 0.1, 100);
    camera.position.z = 8;
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(5, 5, 5); scene.add(sun);
    const geo = new THREE.SphereGeometry(1, 48, 48), loader = new THREE.TextureLoader();
    const mesh = {};
    NAMES.forEach((n, i) => {
        const tex = loader.load('planets/' + n + '.jpg', t => { t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; });
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex }));
        m.userData = { x: 0, tx: 0, s: 0.55, ts: 0.55, spin: 0.004 + i * 0.0004 };
        m.rotation.x = 0.25;
        scene.add(m); mesh[n] = m;
    });
    let worldW = 1;
    const size = () => {
        const w = stage.clientWidth || 600;
        worldW = FRUSTUM_H * w / H;
        camera.left = -worldW / 2; camera.right = worldW / 2; camera.updateProjectionMatrix();
        renderer.setSize(w, H);
    };
    new ResizeObserver(size).observe(stage); size();
    // column centres match the six label columns under the canvas
    const colX = i => -worldW / 2 + worldW * (i + 0.5) / 6;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    (function tick() {
        NAMES.forEach(n => {
            const m = mesh[n], u = m.userData;
            u.x += (colX(u.rank || 0) - u.x) * (still ? 1 : 0.08);
            u.s += (u.ts - u.s) * (still ? 1 : 0.08);
            m.position.x = u.x; m.scale.setScalar(Math.min(u.s, worldW / 6 * 0.42));
            if (!still) m.rotation.y += u.spin;
        });
        renderer.render(scene, camera);
        requestAnimationFrame(tick);
    })();

    /* ── data ── */
    async function hist(path) {
        for (let k = 0; k < HIST.length * 2; k++) {
            try {
                const r = await fetch(HIST[k % HIST.length] + path, { signal: AbortSignal.timeout(25000) });
                if (r.ok) return await r.json();
                if (r.status === 429) await new Promise(z => setTimeout(z, 2000));
            } catch (e) {}
        }
        throw new Error('chain history unavailable');
    }
    const utc = s => Date.parse(/Z$/.test(s) ? s : s + 'Z');
    // newest first, stepping the "before" cursor back (the skip parameter stops at 10k)
    async function scan(filter, from, each, progress) {
        let before = new Date().toISOString();
        const seen = new Set();
        for (let i = 0; i < 400; i++) {
            const j = await hist('/v2/history/get_actions?' + filter + '&limit=1000&sort=desc&after=' + new Date(from).toISOString() + '&before=' + before);
            const a = (j.actions || []).filter(x => !seen.has(x.global_sequence) && seen.add(x.global_sequence));
            a.forEach(x => each(x.act.data));
            progress(a.length);
            if ((j.actions || []).length < 100 || !a.length) break;
            before = new Date(utc(a[a.length - 1]['@timestamp']) + 1000).toISOString();
        }
    }
    async function count(per) {
        const key = 'planets-' + per;
        try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.at < CACHE_MS) return c; } catch (e) {}
        const from = Date.now() - (per === '7d' ? 7 : 1) * DAY;
        const t = {}; NAMES.forEach(n => t[n] = { arena: 0, dungeon: 0, hires: 0 });
        let done = 0;
        const prog = k => { done += k; if (S.per === per) note('Reading the chain… ' + done.toLocaleString() + ' actions'); };
        await Promise.all([
            scan('account=battle.ale&filter=battle.ale:fight', from, d => { const p = t[d.planet]; if (p) p[d.fight_type === 'arena' ? 'arena' : 'dungeon']++; }, prog),
            scan('account=lands.ale&filter=lands.ale:addtavernscr', from, d => { const p = t[d.planet]; if (p) p.hires++; }, prog)
        ]);
        const out = { at: Date.now(), t };
        try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) {}
        return out;
    }
    function note(h) { document.getElementById('pl-sub').innerHTML = h; }
    async function load() {
        const per = S.per;
        if (!S.data[per]) {
            if (!S.busy[per]) S.busy[per] = count(per).then(d => S.data[per] = d).finally(() => S.busy[per] = null);
            paint(null);
            try { await S.busy[per]; } catch (e) { if (S.per === per) note('chain history unavailable right now'); return; }
        }
        if (S.per === per) paint(S.data[per]);
    }
    const fmt = v => v.toLocaleString();
    function paint(d) {
        const cols = document.getElementById('pl-cols');
        if (!d) {
            note('Reading the chain…');
            if (!cols.children.length) cols.innerHTML = NAMES.map(() => '<div class="pl-col"></div>').join('');
            return;
        }
        const tot = n => d.t[n].arena + d.t[n].dungeon + d.t[n].hires;
        const order = NAMES.slice().sort((a, b) => tot(b) - tot(a));
        const max = Math.max(1, tot(order[0]));
        order.forEach((n, i) => { const u = mesh[n].userData; u.rank = i; u.ts = 0.42 + 0.5 * tot(n) / max; });
        note((S.per === '7d' ? 'last 7 days' : 'last 24 hours') + ' · ' + new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        cols.innerHTML = order.map((n, i) => {
            const x = d.t[n];
            return '<div class="pl-col' + (i === 0 ? ' top' : '') + '" title="' + n + ': ' + fmt(x.arena) + ' arena fights, ' + fmt(x.dungeon) + ' dungeon fights, ' + fmt(x.hires) + ' tavern hires">' +
                '<div class="pl-name"><span class="pl-rk">' + (i + 1) + '</span>' + n.charAt(0).toUpperCase() + n.slice(1) + '</div>' +
                '<b class="pl-tot">' + fmt(tot(n)) + '</b>' +
                '<small><span title="arena fights">' + IC.arena + fmt(x.arena) + '</span><span title="dungeon fights">' + IC.dungeon + fmt(x.dungeon) + '</span><span title="tavern hires">' + IC.tavern + fmt(x.hires) + '</span></small></div>';
        }).join('');
    }
    load();
}
