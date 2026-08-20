FROM node:24-alpine AS base

ENV PRISMA_ENGINES_MIRROR=https://npmmirror.com/mirrors/prisma
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

FROM base AS dependencies

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=1024
COPY . .
RUN npm run build

FROM builder AS runtime-dependencies
RUN npm prune --omit=dev

FROM base AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache ffmpeg

COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

EXPOSE 14000
CMD ["npm", "run", "start"]
