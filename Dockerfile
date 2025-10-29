FROM node:20-alpine

# Install ffmpeg and other dependencies
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    git

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy application code
COPY . .

# Create logs and sessions directories
RUN mkdir -p logs sessions

# Expose port (if needed for webhooks)
EXPOSE 3000

# Start the bot
CMD ["node", "index.js"]
