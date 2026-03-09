# Naron Codex — Chest Worker Setup

## One-time setup (5–10 minutes)

### 1. Create a free Cloudflare account
https://dash.cloudflare.com/sign-up — no credit card needed.

### 2. Install Node + Wrangler CLI
If you don't have Node: https://nodejs.org (LTS version)
Then in a terminal:
```
npm install -g wrangler
wrangler login
```
A browser window will open to authenticate with Cloudflare.

### 3. Create the KV namespace
```
cd chest-worker
wrangler kv namespace create CHEST_KV
```
Copy the `id` value it prints, paste it into `wrangler.toml` replacing:
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`

### 4. Deploy the worker
```
wrangler deploy
```
It will print your worker URL, e.g.:
`https://naron-chests.YOUR-SUBDOMAIN.workers.dev`

### 5. Store your gift link secrets (URLs never touch your code)
```
wrangler secret put CHEST_1_URL
```
It will prompt: paste your gift link, press Enter. Repeat for each chest:
```
wrangler secret put CHEST_2_URL
wrangler secret put CHEST_3_URL
wrangler secret put CHEST_4_URL
```

### 6. Update the site
In `chest-integration.html`, replace:
```
const CHEST_WORKER_URL = "https://naron-chests.YOUR-SUBDOMAIN.workers.dev";
```
with your actual worker URL from step 4.

Also update the ALLOWED_ORIGIN in `src/index.js` if your live site URL is
different from `https://spectral-sky.github.io`, then redeploy:
```
wrangler deploy
```

---

## Resetting a chest (if you want to refresh the gift link)
```
wrangler kv key delete --binding CHEST_KV chest_1_claimed
wrangler secret put CHEST_1_URL
```
This clears the claimed flag and sets a new URL.

## Checking claim status
```
wrangler kv key list --binding CHEST_KV
```

---

## Hiding chests in your pages

Copy the `.loot-chest` span wherever you want on any page.
At low opacity (0.08) they're nearly invisible — players have to hunt.
You can change the emoji, use a tiny image, or style them however you like.

Suggested hiding spots:
- Inside a footer line of text (between words)
- As a tiny decoration on a module card
- Inside the top-bar logo area
- Blended into the background of a table header
