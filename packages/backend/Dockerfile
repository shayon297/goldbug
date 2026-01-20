FROM node:20-alpine

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files from monorepo root
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
COPY packages/backend/prisma ./packages/backend/prisma/

# Install dependencies
RUN npm ci --workspace=@goldbug/backend --include-workspace-root

# Generate Prisma client
RUN cd packages/backend && npx prisma generate

# Copy backend source
COPY packages/backend ./packages/backend/

# Build TypeScript
RUN cd packages/backend && npm run build

WORKDIR /app/packages/backend

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["sh", "-c", "npx prisma db push --skip-generate && npm start"]
