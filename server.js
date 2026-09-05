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

const PORT = process.env.PORT || 10000;
const SHARED_SECRET = process.env.RESOLVER_SECRET || "";
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 30_000);

// Only progressive formats (video + audio already muxed together) are
// requested — these are the only ones that yield a single direct URL that
// can be streamed as-is, exactly matching what the previous RapidAPI
// integration returned. Falls back to yt-dlp's own "best" if none exist.
const FORMAT_SELECTOR = "best[acodec!=none][vcodec!=none]/best";

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
  res.json({ ok: true, service: "klyvexa-youtube-resolver-service" });
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
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificates",
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
  if (s.includes("video unavailable")) return "This video is unavailable.";
  if (s.includes("sign in")) return "This video requires sign-in and cannot be resolved.";
  if (s.includes("this live event") || s.includes("live stream")) {
    return "Live streams cannot be resolved until they have ended.";
  }
  if (s.includes("copyright")) return "This video is blocked due to a copyright claim.";
  if (s.includes("region")) return "This video is not available in the resolver's region.";
  return "This video is not available (age-restricted, region-locked, private, or a livestream).";
}

app.listen(PORT, () => {
  console.log(`[youtube-resolver-service] listening on :${PORT}`);
});
