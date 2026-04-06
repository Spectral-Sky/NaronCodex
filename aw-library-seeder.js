#!/usr/bin/env node
/**
 * aw-library-seeder.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches all alien.worlds templates from AtomicAssets API and writes
 * aw-library.json — the shared NFT template lookup used by outpost.html
 * and any future NaronCodex pages.
 *
 * USAGE:
 *   node aw-library-seeder.js
 *
 * OUTPUT:
 *   aw-library.json  (overwritten in the same directory)
 *
 * WHEN TO RE-RUN:
 *   - Alien Worlds adds new NFT templates (rare — AW is not actively adding
 *     templates as of April 2026, but verify before outpost launch of new sets)
 *   - You want fresher rarity/element data after an AW collection update
 *   - The file is missing or corrupted
 *
 *   Planetary Defense (planetdefnft) templates are managed manually in
 *   nft_data.js — this seeder does NOT touch PD data.
 *
 * REQUIREMENTS:
 *   Node.js 18+ (uses built-in fetch). No npm install needed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const COLLECTION   = 'alien.worlds';
const AA_BASE      = 'https://wax.api.atomicassets.io';
const AA_FALLBACKS = [
    'https://wax.api.atomicassets.io',
    'https://aa.wax.blacklusion.io',
    'https://wax-aa.eu.eosamsterdam.net',
];
const PAGE_SIZE    = 1000;
const OUT_FILE     = path.join(__dirname, 'aw-library.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(base, page) {
    const url = `${base}/atomicassets/v1/templates?collection_name=${COLLECTION}&limit=${PAGE_SIZE}&page=${page}&order=asc`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.data || [];
}

function pickElements(im, mut) {
    const elements = [];
    function scan(obj) {
        if (!obj) return;
        for (const k of Object.keys(obj)) {
            const lk = k.toLowerCase();
            if (lk === 'element' || lk === 'element2' || lk.includes('element')) {
                const v = obj[k];
                if (v != null) {
                    const val = String(v).trim();
                    if (val && val.toLowerCase() !== 'none' && !elements.includes(val)) {
                        elements.push(val);
                    }
                }
            }
        }
    }
    scan(im);
    if (elements.length === 0) scan(mut);
    return elements;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
    console.log(`\nNaronCodex — aw-library-seeder.js`);
    console.log(`Collection : ${COLLECTION}`);
    console.log(`Output     : ${OUT_FILE}`);
    console.log(`Started    : ${new Date().toISOString()}\n`);

    const templates = {};
    let page = 1;
    let total = 0;
    let base = AA_BASE;

    // Find a working endpoint
    for (const b of AA_FALLBACKS) {
        try {
            await fetch(`${b}/atomicassets/v1/templates?collection_name=${COLLECTION}&limit=1`);
            base = b;
            console.log(`Using endpoint: ${base}`);
            break;
        } catch { /* try next */ }
    }

    // Page through all templates
    while (true) {
        process.stdout.write(`  Fetching page ${page}...`);
        let rows;
        try {
            rows = await fetchPage(base, page);
        } catch (e) {
            console.error(`\n  ERROR on page ${page}: ${e.message} — retrying in 3s`);
            await sleep(3000);
            try { rows = await fetchPage(base, page); }
            catch (e2) { console.error(`  Retry failed: ${e2.message}. Stopping.`); break; }
        }

        if (!rows || rows.length === 0) {
            console.log(` done (no more rows).`);
            break;
        }

        for (const d of rows) {
            const tid  = String(d.template_id);
            const im   = d.immutable_data || {};
            const mut  = d.mutable_data   || {};
            const sch  = (d.schema && d.schema.schema_name) ? d.schema.schema_name : null;
            templates[tid] = {
                name:     im.name     ? String(im.name)     : null,
                rarity:   im.rarity   ? String(im.rarity)   : null,
                schema:   sch,
                elements: pickElements(im, mut),
                type:     im.type     ? String(im.type)     : null,
                img:      im.img      ? String(im.img)      : null   // IPFS hash only, no gateway prefix
            };
        }

        total += rows.length;
        console.log(` ${rows.length} rows (${total} total)`);

        if (rows.length < PAGE_SIZE) {
            console.log(`  Last page reached.`);
            break;
        }

        page++;
        await sleep(300); // be polite to the API
    }

    // Build output
    const output = {
        _meta: {
            collection:  COLLECTION,
            generated:   new Date().toISOString().split('T')[0],
            total:       Object.keys(templates).length,
            note: [
                "Auto-generated by aw-library-seeder.js from AtomicAssets API.",
                "Re-run this script if Alien Worlds adds new templates.",
                "AW is not actively adding templates as of April 2026.",
                "Planetary Defense (planetdefnft) is managed separately in nft_data.js.",
                "img values are raw IPFS hashes — pages prepend the gateway prefix."
            ].join(' ')
        },
        templates: templates
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\nWrote ${Object.keys(templates).length} templates to ${OUT_FILE}`);
    console.log(`Done. ${new Date().toISOString()}\n`);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
