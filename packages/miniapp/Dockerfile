FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app

# Copy monorepo package files
COPY package*.json ./
COPY packages/miniapp/package*.json ./packages/miniapp/

# Install dependencies for workspace
RUN npm ci --workspace=@goldbug/miniapp --include-workspace-root

FROM base AS builder
WORKDIR /app

# Copy node_modules from root (npm workspaces installs here)
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js
WORKDIR /app/packages/miniapp
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy public folder if it exists
COPY --from=builder /app/packages/miniapp/public ./public

# Copy standalone output
COPY --from=builder --chown=nextjs:nodejs /app/packages/miniapp/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/miniapp/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
