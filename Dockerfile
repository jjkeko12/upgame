# ---- dependencies ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined into the client bundle at build time
ARG NEXT_PUBLIC_GAME_ORIGIN=""
ENV NEXT_PUBLIC_GAME_ORIGIN=$NEXT_PUBLIC_GAME_ORIGIN \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS run
# unzip is the fallback extractor for ZIPs that use bzip2/lzma; tar handles .tar/.tgz
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
