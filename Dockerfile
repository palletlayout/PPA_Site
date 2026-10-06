# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Keep this version in sync with package.json's packageManager field.
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=ppa-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY . .
RUN CARTFLOW_STANDALONE=true pnpm build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    CARTFLOW_DATABASE_PATH=/data/cartflow.sqlite

RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Keep credential generation and consistent SQLite backups available in the image.
COPY --from=build --chown=node:node /app/scripts/hash-password.mjs /app/scripts/backup-sqlite.mjs ./scripts/
COPY --from=build --chown=node:node /app/lib/auth.ts ./lib/auth.ts

USER node
EXPOSE 3000
# Checks the server and auth configuration; /api/health requires a supervisor session.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/auth/session', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
