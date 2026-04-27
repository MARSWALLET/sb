# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build the React client
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS client-builder

# Set up both workspaces so the vite outDir (../server/public) resolves correctly
WORKDIR /app
RUN mkdir -p client server/public

WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
# vite.config.js outputs to ../server/public → /app/server/public inside Docker
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Production server image with Chromium
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim

# Install Chromium and required system libraries for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app/server

# Install server dependencies
COPY server/package*.json ./
RUN npm install --omit=dev

# Copy server source
COPY server/ ./

# Copy built React frontend from client-builder stage into server/public
# (vite outputs to /app/server/public in the builder stage)
COPY --from=client-builder /app/server/public ./public

# Railway injects PORT at runtime
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "index.js"]
