FROM node:24-alpine

# ffmpeg for media conversion; build tools for native modules (sqlite3, sharp)
# when no prebuilt binary matches
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    git

WORKDIR /app

# Yarn 4 is vendored in the repo (.yarnrc.yml -> yarnPath)
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
RUN yarn install --immutable

COPY . .

# Mount points for persistent data (see docker-compose.yml)
RUN mkdir -p sessions data db

# --expose-gc lets lib/utils/memoryManager.js trigger garbage collection
CMD ["node", "--expose-gc", "index.js"]
