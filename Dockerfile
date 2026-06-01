# Multi-stage build for production deployment
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps (separate layer for caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source & build
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5.6.3 tsx@4.19.2
RUN npx tsc -p .

# Runtime stage — minimal
FROM node:22-alpine

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S bot && adduser -u 1001 -S bot -G bot

# Copy compiled output + production deps
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Data directory (mount as volume for persistence)
RUN mkdir -p /app/data && chown -R bot:bot /app

USER bot

# Default to paper mode; override with command for live
CMD ["node", "dist/sim/runPaper.js"]
