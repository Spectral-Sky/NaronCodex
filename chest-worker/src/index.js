/**
 * NARON CODEX — CHEST WORKER
 * Cloudflare Worker for one-time-use gift link reveal.
 *
 * Chest URLs are stored as Worker Secrets (never in code):
 *   CHEST_1_URL, CHEST_2_URL, CHEST_3_URL, CHEST_4_URL
 *
 * KV namespace CHEST_KV tracks claimed state.
 */

const ALLOWED_ORIGIN = "https://spectral-sky.github.io"; // your GitHub Pages origin

function cors(origin) {
    const allowed = origin === ALLOWED_ORIGIN || origin === "http://127.0.0.1:5500" || origin?.startsWith("file://");
    return {
        "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
    };
}

function json(data, status = 200, origin = "") {
    return new Response(JSON.stringify(data), { status, headers: cors(origin) });
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin") || "";

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: cors(origin) });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // ── GET /chest?id=1 ──────────────────────────────────────────────────────
        if (path === "/chest" && request.method === "GET") {
            const id = url.searchParams.get("id");

            if (!id || !/^[1-4]$/.test(id)) {
                return json({ error: "Invalid chest." }, 400, origin);
            }

            // Check if already claimed
            const claimedBy = await env.CHEST_KV.get(`chest_${id}_claimed`);
            if (claimedBy) {
                return json({
                    claimed: true,
                    message: "CACHE EMPTY — another explorer reached this cache first.",
                }, 200, origin);
            }

            // Get the secret URL (set via `wrangler secret put CHEST_1_URL`)
            const giftUrl = env[`CHEST_${id}_URL`];
            if (!giftUrl) {
                return json({ error: "Chest not configured." }, 404, origin);
            }

            // Mark as claimed with timestamp (one-time use)
            const claimedAt = new Date().toISOString();
            await env.CHEST_KV.put(`chest_${id}_claimed`, claimedAt);

            return json({ claimed: false, url: giftUrl }, 200, origin);
        }

        // ── GET /status?id=1  (check without claiming — safe to call on page load) ─
        if (path === "/status" && request.method === "GET") {
            const id = url.searchParams.get("id");
            if (!id || !/^[1-4]$/.test(id)) {
                return json({ error: "Invalid chest." }, 400, origin);
            }
            const claimed = !!(await env.CHEST_KV.get(`chest_${id}_claimed`));
            return json({ claimed }, 200, origin);
        }

        return json({ error: "Not found." }, 404, origin);
    },
};
