# Stage 1: Base
FROM node:22.15.0-alpine3.21 AS base

# Prisma query engine needs OpenSSL on Alpine
RUN apk add --no-cache openssl libc6-compat

# Stage 2: Install dependencies
FROM base AS deps

WORKDIR /app

# prisma/ is needed because `postinstall` runs `prisma generate`
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Stage 3: Build the app
FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN --mount=type=secret,id=env \
    base64 -d /run/secrets/env > .env

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 4: Run the app
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV PATH=/app/node_modules/.bin:$PATH

COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/next.config.ts ./next.config.ts
COPY --chown=node:node --from=builder /app/.env ./.env
COPY --chown=node:node --from=builder /app/public ./public
# Fonts read at runtime by app/share/[token]/opengraph-image.tsx
COPY --chown=node:node --from=builder /app/assets ./assets
COPY --chown=node:node --from=builder /app/.next ./.next
COPY --chown=node:node --from=builder /app/node_modules ./node_modules

USER node

EXPOSE 3000

CMD ["next", "start", "-H", "0.0.0.0"]
