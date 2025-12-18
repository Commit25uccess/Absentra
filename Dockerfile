FROM node:25-alpine AS base

WORKDIR /app

# Install dependencies for Prisma and native module compilation
RUN apk add --no-cache openssl python3 make g++

# Dependencies stage
FROM base AS deps
COPY package.json ./
RUN npm rebuild better-sqlite3 && npm install

# Build stage
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Production stage
FROM base AS runner

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 pto

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

# Rebuild better-sqlite3 for the target platform BEFORE switching to non-root user
RUN npm rebuild better-sqlite3

# Create data directory for SQLite and fix permissions for Prisma
RUN mkdir -p /app/data && \
    chown -R pto:nodejs /app/data /app/prisma /app/node_modules/.prisma /app/node_modules/better-sqlite3

USER pto

EXPOSE 3000

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run database migrations and start app
CMD ["sh", "-c", "npx prisma db push --url \"$DATABASE_URL\" && node dist/app.js"]
