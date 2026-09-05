// Klyvexa YouTube resolver microservice
// -----------------------------------------------------------------------------
// A tiny, self-contained Express server that wraps the free, open-source
// `yt-dlp` tool to do the one job the Cloudflare Worker cannot do itself:
// resolve a YouTube page link (which requires a Proof-of-Origin/BotGuard
// token a Worker can't generate) into a direct, playable stream URL.
//
// This replaces the paid RapidAPI "YouTube Media Downloader" dependency —
// yt-dlp is free, has no request quota, and is actively maintained against
// YouTube's changes.
//
// Deploy this on any Docker host (Render.com's free web service tier works
// well — see README.md for step-by-step instructions). The Cloudflare
// Worker calls POST /resolve with a shared-secret header.
//
// Design choices, on purpose (mirrors ../transcode-service/server.js):
//   - Only a plain http(s) `url` is accepted; yt-dlp's own format selector is
//     fixed server-side, never taken from the caller, so this can't be
//     abused as an arbitrary yt-dlp proxy even if the shared secret leaks.
//   - Only YouTube hostnames are accepted, for the same reason.
//   - yt-dlp is killed after a hard wall-clock timeout.
//   - No files are ever written to disk — yt-dlp only prints metadata JSON,
//     the actual video bytes are streamed by the Worker directly from the
//     resolved googlevideo.com URL, exactly like the previous RapidAPI path.
// -----------------------------------------------------------------------------

const express = require("express");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = process.env.PORT || 10000;
const SHARED_SECRET = process.env.RESOLVER_SECRET || "";
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 30_000);

// -----------------------------------------------------------------------
// PO Token provider companion process
// -----------------------------------------------------------------------
// YouTube now requires every yt-dlp request - cookies or not - to carry a
// cryptographic Proof-of-Origin (PO) token, or it rejects the session with
// "The page needs to be reloaded". bgutil-ytdlp-pot-provider generates
// that token locally and serves it over a small HTTP server; the Dockerfile
// builds it into POT_PROVIDER_DIR, and this process manager keeps it
// running alongside the resolver (auto-restarting it if it ever crashes)
// so a single Render service can host both without extra deploy steps.
const POT_PROVIDER_DIR = process.env.POT_PROVIDER_DIR || path.join(__dirname, "pot-provider", "server");
const POT_PROVIDER_PORT = Number(process.env.POT_PROVIDER_PORT || 4416);
const POT_PROVIDER_ENTRY = path.join(POT_PROVIDER_DIR, "build", "main.js");
let potProviderReady = false;

function startPotProvider(restartDelayMs = 2000) {
  if (!fs.existsSync(POT_PROVIDER_ENTRY)) {
    console.warn(
      `[resolver] PO Token provider not found at ${POT_PROVIDER_ENTRY} - continuing without it (YouTube may reject requests with "The page needs to be reloaded").`
    );
    return;
  }
  const proc = spawn(process.execPath, [POT_PROVIDER_ENTRY, "--port", String(POT_PROVIDER_PORT)], {
    cwd: POT_PROVIDER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (d) => {
    const text = d.toString().trim();
    if (text) console.log("[pot-provider]", text);
    if (!potProviderReady && /listening|started|running/i.test(text)) {
      potProviderReady = true;
      console.log(`[resolver] PO Token provider ready on 127.0.0.1:${POT_PROVIDER_PORT}.`);
    }
  });
  proc.stderr.on("data", (d) => {
    const text = d.toString().trim();
    if (text) console.error("[pot-provider]", text);
  });

  proc.on("exit", (code, signal) => {
    potProviderReady = false;
    console.error(`[resolver] PO Token provider exited (code=${code}, signal=${signal}). Restarting in ${restartDelayMs}ms.`);
    setTimeout(() => startPotProvider(Math.min(restartDelayMs * 2, 30_000)), restartDelayMs);
  });
  proc.on("error", (err) => {
    console.error("[resolver] Failed to start PO Token provider:", err.message);
  });

  // The HTTP server itself doesn't print a clearly matching "ready" line
  // across all versions, so also optimistically flip the flag shortly
  // after spawn - the yt-dlp plugin retries its own connection anyway.
  setTimeout(() => {
    potProviderReady = true;
  }, 3000);
}

startPotProvider();

// Optional: a logged-in YouTube session's cookies (Netscape cookies.txt
// format), base64-encoded into a single env var so it can be pasted into
// Render's dashboard without uploading a file. When present, every yt-dlp
// call authenticates as that browser session, which bypasses the
// "Sign in to confirm you're not a bot" datacenter-IP block entirely -
// YouTube trusts a real session cookie far more than any player-client
// trick. Written once to a private tmp file at startup; never logged.
const COOKIES_PATH = path.join(os.tmpdir(), "yt-cookies.txt");
let cookiesReady = false;
if (process.env.YT_COOKIES_BASE64) {
  try {
    fs.writeFileSync(COOKIES_PATH, Buffer.from(process.env.YT_COOKIES_BASE64, "base64"), { mode: 0o600 });
    cookiesReady = true;
    console.log("[resolver] Loaded YouTube cookies from YT_COOKIES_BASE64.");
  } catch (err) {
    console.error("[resolver] Failed to write cookies file:", err.message);
  }
}

// Only progressive formats (video + audio already muxed together) are
// requested — these are the only ones that yield a single direct URL that
// can be streamed as-is, exactly matching what the previous RapidAPI
// integration returned. itag 18 (360p mp4) is tried explicitly first
// because it's the one progressive format YouTube still reliably serves;
// the rest are fallbacks if it's ever missing. Falls back to yt-dlp's own
// "best" if none exist.
const FORMAT_SELECTOR = "18/best[acodec!=none][vcodec!=none]/best";

// As of 2024-2025, YouTube's default "web" player client frequently stops
// returning a usable direct "url" for progressive formats (it only hands
// back an HLS/DASH manifest instead), which is why the plain format
// selector above can fail with "Requested format is not available" even
// though the video is perfectly playable. "android" still returns real
// direct googlevideo.com URLs for most videos, but YouTube has started
// bot-checking ("Sign in to confirm you're not a bot") datacenter IPs on
// that client for a growing subset of videos. "ios" and "tv" are kept as
// further fallbacks because YouTube bot-checks each client independently -
// a video blocked on one client is frequently still resolvable on another,
// so trying several in order meaningfully increases the success rate on a
// shared cloud IP without needing cookies or a proxy.
//
// IMPORTANT: a browser session cookie is only valid for the "web" client
// family - it was issued by youtube.com's web login flow, not by the
// Android/iOS/TV apps' own (cookie-less) auth. Passing that cookie together
// with --extractor-args player_client=android/ios/tv makes yt-dlp send a
// half-authenticated, mismatched request, which YouTube rejects with
// "The page needs to be reloaded" (a session-integrity error, distinct from
// "Sign in to confirm you're not a bot"). So whenever cookies are
// configured, "web" and its cookie-compatible variants must be tried
// first; the cookie-less mobile clients stay as fallbacks for videos where
// the web client itself gets format- or bot-blocked.
const PLAYER_CLIENTS = cookiesReady
  ? ["web", "web_safari", "mweb", "android", "ios", "tv"]
  : ["android", "ios", "tv", "web"];
// The `youtubepot-bgutilhttp:base_url=...` argument tells the bgutil PO
// Token plugin (installed in the Dockerfile) where to reach the companion
// HTTP server started by startPotProvider() above, so every yt-dlp call
// automatically attaches a valid Proof-of-Origin token - without it,
// YouTube now rejects most cloud-IP requests with
// "The page needs to be reloaded", independent of any player_client choice.
const EXTRACTOR_ARGS = [
  `youtube:player_client=${PLAYER_CLIENTS.join(",")}`,
  `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${POT_PROVIDER_PORT}`,
].join(";");

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const app = express();
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "klyvexa-youtube-resolver-service",
    cookiesConfigured: cookiesReady,
    potProviderReady,
  });
});

app.post("/resolve", async (req, res) => {
  // --- auth ------------------------------------------------------------
  if (!SHARED_SECRET) {
    return res.status(500).json({ error: "server_misconfigured", message: "RESOLVER_SECRET is not set." });
  }
  const provided = req.get("x-resolver-secret") || "";
  if (!timingSafeEqual(provided, SHARED_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // --- input validation --------------------------------------------------
  const { url } = req.body || {};
  if (!url || typeof url !== "string" || !isYoutubeUrl(url)) {
    return res.status(422).json({ error: "invalid_request", message: "A valid YouTube 'url' is required." });
  }

  try {
    const info = await runYtDlp(url, YTDLP_TIMEOUT_MS);
    res.json({ ok: true, directUrl: info.url, title: info.title, ext: info.ext, hasAudio: info.hasAudio });
  } catch (err) {
    console.error("[resolver]", err && err.message ? err.message : err);
    const status = (err && err.status) || 502;
    res.status(status).json({
      error: (err && err.code) || "resolve_failed",
      message: (err && err.message) || "Could not resolve this video.",
    });
  }
});

function isYoutubeUrl(urlString) {
  try {
    return YOUTUBE_HOSTS.has(new URL(urlString).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Runs `yt-dlp -j <url>` with a fixed, safe format selector and parses the
// single JSON object it prints. Never touches disk — only metadata (which
// includes the resolved format's direct "url") is read from stdout.
function runYtDlp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f",
      FORMAT_SELECTOR,
      "--extractor-args",
      EXTRACTOR_ARGS,
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificates",
      ...(cookiesReady ? ["--cookies", COOKIES_PATH] : []),
      "-j",
      url,
    ];
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000); // guard against runaway output
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(Object.assign(new Error("Resolving this video timed out."), { status: 504, code: "resolve_timeout" }));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(killTimer);
      reject(
        Object.assign(new Error(`Could not start yt-dlp: ${err.message}`), {
          status: 500,
          code: "ytdlp_spawn_failed",
        })
      );
    });

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        // Log the raw yt-dlp stderr (not just the classified message) so the
        // Render logs show exactly why extraction failed - the classifier
        // below only covers known phrasings and otherwise falls back to a
        // generic message that hides the real cause.
        console.error("[resolver] yt-dlp raw stderr:", stderr.trim() || "(empty)");
        return reject(
          Object.assign(new Error(classifyYtDlpError(stderr)), { status: 422, code: "youtube_extraction_failed" })
        );
      }
      try {
        // yt-dlp prints exactly one JSON line for a single, non-playlist URL.
        const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
        const data = JSON.parse(lastLine);
        if (!data || typeof data.url !== "string" || !data.url) {
          return reject(
            Object.assign(new Error("This video only exposes streams that could not be resolved."), {
              status: 422,
              code: "no_stream",
            })
          );
        }
        resolve({
          url: data.url,
          title: data.title || "video",
          ext: data.ext || "mp4",
          hasAudio: data.acodec ? data.acodec !== "none" : true,
        });
      } catch {
        reject(
          Object.assign(new Error("yt-dlp returned an unexpected response."), { status: 502, code: "parse_failed" })
        );
      }
    });
  });
}

// Maps common yt-dlp stderr messages to clear, user-facing reasons instead
// of leaking raw tool output.
function classifyYtDlpError(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes("private video")) return "This video is private.";
  if (s.includes("sign in to confirm your age") || s.includes("age-restricted")) {
    return "This video is age-restricted and cannot be resolved.";
  }
  // YouTube blocking the server's (datacenter) IP as a suspected bot is the
  // most common cause of extraction failures on cloud hosts like Render -
  // this is a distinct case from a real "sign in" age/consent wall, so it
  // must be checked before the generic "sign in" branch below.
  if (s.includes("confirm you're not a bot") || s.includes("confirm you are not a bot")) {
    return "YouTube is blocking this server's IP as a suspected bot. Try again later, or configure cookies/a proxy on the resolver service.";
  }
  // Distinct from the bot-check above: this means YouTube rejected the
  // request for missing/invalid PO token, which is what the built-in
  // bgutil PO Token provider (see startPotProvider) is meant to fix. If
  // this keeps appearing, check the [pot-provider] log lines for startup
  // errors - the provider may have failed to start in this container.
  if (s.includes("the page needs to be reloaded")) {
    return potProviderReady
      ? "YouTube rejected the request (invalid session/PO token) even with the PO Token provider running. Try again, or update yt-dlp and the bgutil provider on the resolver service."
      : "YouTube rejected the request because no valid PO token was attached, and this server's PO Token provider is not ready yet. Try again shortly.";
  }
  if (s.includes("video unavailable")) return "This video is unavailable.";
  if (s.includes("sign in")) return "This video requires sign-in and cannot be resolved.";
  if (s.includes("this live event") || s.includes("live stream")) {
    return "Live streams cannot be resolved until they have ended.";
  }
  if (s.includes("copyright")) return "This video is blocked due to a copyright claim.";
  if (s.includes("region")) return "This video is not available in the resolver's region.";
  if (s.includes("unable to extract") || s.includes("failed to extract")) {
    return "YouTube changed something yt-dlp can't parse yet. Try updating yt-dlp on the resolver service.";
  }
  if (s.includes("requested format is not available")) {
    return "This video has no playable format yt-dlp could resolve.";
  }
  return "This video is not available (age-restricted, region-locked, private, or a livestream).";
}

app.listen(PORT, () => {
  console.log(`[youtube-resolver-service] listening on :${PORT}`);
});
