# ── Stage 1: install dependencies ────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force


# ── Stage 2: runtime image ────────────────────────────────────
FROM node:20-alpine AS runtime

# Add tini for proper PID 1 signal handling (clean shutdown)
RUN apk add --no-cache tini

WORKDIR /app

# Copy deps from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY server.js        ./
COPY public/          ./public/

# Bake in the default config — entrypoint uses this on first run
# if /lazysunday/config.json doesn't exist on the host yet
COPY config.json      ./config.default.json

# Entrypoint seeds config.json on first run
COPY entrypoint.sh    ./
RUN chmod +x entrypoint.sh

# These directories are mounted as volumes at runtime
RUN mkdir -p backgrounds covers

# Never run as root
RUN addgroup -S lazysunday && adduser -S lazysunday -G lazysunday
USER lazysunday

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3010/api/config || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "server.js"]
