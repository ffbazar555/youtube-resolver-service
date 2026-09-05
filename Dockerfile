FROM node:20-slim

# yt-dlp is a Python tool; ffmpeg is optional here (this service never
# merges/re-encodes anything) but yt-dlp uses it to probe some formats, so
# it's included for reliability.
# Use yt-dlp's nightly build channel, not the stable pip release - YouTube
# changes its player/extraction logic often, and nightly builds ship fixes
# days to weeks before stable does. This directly reduces "unable to
# extract" / "failed to extract" resolver failures.
# bgutil-ytdlp-pot-provider is the yt-dlp *plugin* half of the PO Token
# provider (see below) - it must be installed into the same Python/yt-dlp
# environment so yt-dlp can discover it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates git && \
    pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" --pre && \
    pip3 install --no-cache-dir --break-system-packages -U bgutil-ytdlp-pot-provider && \
    apt-get purge -y --auto-remove python3-pip && \
    rm -rf /var/lib/apt/lists/*

# --- PO Token provider companion server ---------------------------------
# As of 2024-2025 YouTube requires every yt-dlp request - even ones with no
# cookies attached - to carry a cryptographic Proof-of-Origin (PO) token,
# or it rejects the session with "The page needs to be reloaded". This
# clones and builds the official bgutil-ytdlp-pot-provider HTTP server
# (https://github.com/Brainicism/bgutil-ytdlp-pot-provider), which
# generates that token locally via LuanRT's BotGuard interfacing library.
# It is started by server.js as a background child process on
# 127.0.0.1:4416 - never exposed outside this container - and the plugin
# installed above talks to it automatically.
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-pot-provider && \
    cd /opt/bgutil-pot-provider/server && \
    npm ci && \
    npx tsc && \
    npm prune --omit=dev && \
    rm -rf /opt/bgutil-pot-provider/.git && \
    apt-get purge -y --auto-remove git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=10000
ENV POT_PROVIDER_DIR=/opt/bgutil-pot-provider/server
EXPOSE 10000
CMD ["node", "server.js"]
