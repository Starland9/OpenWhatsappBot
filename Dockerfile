FROM node:24-alpine

# ffmpeg for media conversion; build tools for native modules (sqlite3, sharp)
# when no prebuilt binary matches
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    git

# yt-dlp: official release binary (latest), used by the download commands.
# The standalone script needs python3 (installed above); `yt-dlp -U` can update it
RUN wget -q -O /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Yarn 4 is vendored in the repo (.yarnrc.yml -> yarnPath)
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
RUN yarn install --immutable

COPY . .

# Mount points for persistent data (see docker-compose.yml)
RUN mkdir -p sessions data db

# Admin panel (/admin/) and monitoring routes. Inside a container the panel binds 0.0.0.0 on its own
# (PANEL_HOST unset); docker-compose.yml only exposes the port, it does not publish it
EXPOSE 3000

# /ping answers 200 as soon as the HTTP server is up. /health is 503 until WhatsApp is paired, which would
# mark the container unhealthy during the very first pairing, so it must not be used here.
# The port follows PANEL_PORT, then PORT, then 3000. The check goes to 127.0.0.1: leave PANEL_HOST unset or at
# 0.0.0.0. With ADMIN_PANEL=false nothing listens (index.js), so there is nothing to check
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD [ "$ADMIN_PANEL" = "false" ] || wget -q -O /dev/null "http://127.0.0.1:${PANEL_PORT:-${PORT:-3000}}/ping"

# --expose-gc lets lib/utils/memoryManager.js trigger garbage collection
CMD ["node", "--expose-gc", "index.js"]
