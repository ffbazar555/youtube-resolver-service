# Klyvexa YouTube Resolver Service

A small Docker microservice that runs the free, open-source `yt-dlp` tool to
resolve a YouTube page link into a direct, playable stream URL.

This **replaces the paid RapidAPI "YouTube Media Downloader" integration**
that was hitting its monthly quota (`429 Client Error`). `yt-dlp` has no
request quota and is actively maintained against YouTube's changes.

The Cloudflare Worker (`cloudflare-worker/codevanta.js`) calls this service
from `resolveYoutubeDirectUrl` instead of calling RapidAPI directly —
Cloudflare Workers cannot run `yt-dlp` (a Python tool) themselves.

## Built-in PO Token provider (fixes "The page needs to be reloaded")

Since 2024–2025, YouTube requires almost every request — even ones with no
cookies attached — to carry a cryptographic **Proof-of-Origin (PO) token**,
or it rejects the session with `ERROR: The page needs to be reloaded`. This
is a different problem from the "confirm you're not a bot" IP block and
**cookies alone do not fix it**.

This service bundles the official
[`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
to solve it automatically — no extra setup or environment variables needed:

- The `Dockerfile` clones and builds the provider's companion HTTP server
  into the image, and installs its yt-dlp plugin (`pip install
  bgutil-ytdlp-pot-provider`).
- `server.js` starts that HTTP server as a background process on
  `127.0.0.1:4416` when the container boots (see `startPotProvider` — it
  auto-restarts if it ever crashes), and passes
  `--extractor-args youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416`
  to every `yt-dlp` call so it always attaches a fresh token.
- `GET /health` reports `potProviderReady` so you can confirm it started.

If a resolve still fails with "the page needs to be reloaded" after this,
check the Render logs for `[pot-provider]` lines — that means the bundled
provider itself failed to start (rare, but can happen if yt-dlp's PO Token
Provider Framework version drifts from the plugin's expected version; if
so, rebuild the image to pick up the latest `bgutil-ytdlp-pot-provider`).

## 1. Deploy to Render.com (free tier, no credit card required)

1. Push this repo (or just the `youtube-resolver-service/` folder) to
   GitHub.
2. In the Render dashboard: **New → Web Service**.
3. Connect the repo, and when asked for the environment, choose **Docker**
   (Render auto-detects the `Dockerfile` in `youtube-resolver-service/`).
   Set the **Root Directory** to `youtube-resolver-service` if your repo
   has other folders (it does — `cloudflare-worker/` and
   `transcode-service/` sit next to it).
4. Instance type: **Free**.
5. Add an environment variable:
   - `RESOLVER_SECRET` — a long random string, e.g. generate one with
     `openssl rand -hex 32`. This is the shared secret the Worker must send
     on every request; keep it private.
6. Deploy. Render will build the Docker image (this installs Python +
   `yt-dlp` inside the container) and give you a URL like
   `https://klyvexa-youtube-resolver.onrender.com`.
7. Confirm it's up:
   `curl https://klyvexa-youtube-resolver.onrender.com/health`
   should return `{"ok":true,...}`.

Notes on the free tier:
- Free web services spin down after ~15 minutes of no traffic and take
  30–60 seconds to cold-start on the next request. The Worker below waits
  for the response (with a generous timeout) instead of treating a slow
  first request as an error — same pattern already used for
  `transcode-service`.
- 750 free instance-hours/month is enough to keep one service running
  continuously. If you already run `transcode-service` on the same free
  account, note that Render's 750 hours are shared across **all** free
  services on the account — two always-on free services will use it up
  roughly twice as fast (still enough for one instance running 24/7, or
  two instances that both get to idle/sleep between uses).

## 2. Configure the Cloudflare Worker

Add these two secrets to the Worker (`wrangler secret put ...` or via the
Cloudflare dashboard → Workers & Pages → your worker → **Settings →
Variables and Secrets**):

- `YT_RESOLVER_URL` — the Render URL from step 1, e.g.
  `https://klyvexa-youtube-resolver.onrender.com`
- `YT_RESOLVER_SECRET` — the exact same value you set as
  `RESOLVER_SECRET` on Render.

You can now **delete** the old `RAPIDAPI_KEY` / `CURL_AUTH_HEADER_2`
secret — it is no longer used.

After both are set, redeploy the Worker (**Deployments → ⋯ → Deploy** on
the latest version, or push code) and make sure the **new deployment gets
100% traffic** (see the note on split-traffic below).

## 3. Local testing

```bash
cd youtube-resolver-service
npm install
# yt-dlp must also be installed locally to test outside Docker:
#   pip3 install -U yt-dlp
RESOLVER_SECRET=dev-secret node server.js
```

```bash
curl -X POST http://localhost:10000/resolve \
  -H "Content-Type: application/json" \
  -H "x-resolver-secret: dev-secret" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## Safety limits baked in

- Only YouTube hostnames are accepted — this can't be turned into a
  general-purpose `yt-dlp` proxy even if the shared secret leaks.
- The format selector (`best[acodec!=none][vcodec!=none]/best`) is fixed
  server-side and never taken from the caller.
- `yt-dlp` is force-killed after 30s (`YTDLP_TIMEOUT_MS`).
- No video bytes are ever written to disk or pass through this service —
  it only returns metadata (including the resolved direct URL); the
  Worker streams the actual video straight from that URL, exactly like
  the previous RapidAPI integration did.

All limits are overridable via environment variables of the same name.

## Always double-check "New deployment" traffic on Cloudflare

Every time you deploy the Worker after this change, Cloudflare may show a
"Split deployment across versions" screen. Set the new version to **100%**
before clicking Deploy — otherwise a stale version (potentially still
configured with the old RapidAPI secret) keeps serving a slice of traffic,
which looks like this error coming back intermittently.
