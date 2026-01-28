FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app

# Copy monorepo package files
COPY package*.json ./
COPY packages/website/package*.json ./packages/website/

# Install dependencies for workspace
RUN npm ci --workspace=@goldbug/website --include-workspace-root

FROM base AS builder
WORKDIR /app

# Build args for Next.js public env vars (needed at build time)
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BOT_LINK
ARG NEXT_PUBLIC_SUPPORT_LINK
ARG NEXT_PUBLIC_DOCS_LINK
ARG NEXT_PUBLIC_TWITTER_LINK
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_BOT_LINK=$NEXT_PUBLIC_BOT_LINK
ENV NEXT_PUBLIC_SUPPORT_LINK=$NEXT_PUBLIC_SUPPORT_LINK
ENV NEXT_PUBLIC_DOCS_LINK=$NEXT_PUBLIC_DOCS_LINK
ENV NEXT_PUBLIC_TWITTER_LINK=$NEXT_PUBLIC_TWITTER_LINK

# Copy node_modules from root (npm workspaces installs here)
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js
WORKDIR /app/packages/website
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone output (preserves monorepo structure)
COPY --from=builder --chown=nextjs:nodejs /app/packages/website/.next/standalone ./

# Copy static files to the correct location within standalone
COPY --from=builder --chown=nextjs:nodejs /app/packages/website/.next/static ./packages/website/.next/static

# Copy public folder to the correct location
COPY --from=builder --chown=nextjs:nodejs /app/packages/website/public ./packages/website/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Server.js is in the packages/website directory due to monorepo structure
CMD ["node", "packages/website/server.js"]

