FROM node:20-slim

# yt-dlp is a Python tool; ffmpeg is optional here (this service never
# merges/re-encodes anything) but yt-dlp uses it to probe some formats, so
# it's included for reliability.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates && \
    pip3 install --no-cache-dir --break-system-packages -U yt-dlp && \
    apt-get purge -y --auto-remove python3-pip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
