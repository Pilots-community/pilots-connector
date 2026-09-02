# The connector: one container, no database.
#
# Multi-stage, because resident memory and image size are acceptance criteria
# rather than preferences. The runtime stage carries production dependencies and
# built output only — no toolchain, no sources, no test fixtures.
#
# Nothing secret is baked in. The signing key and the API-key pepper are
# generated on first boot and written to the mounted volume; an image with a
# baked key is a committed key one layer down.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo

# Manifests first, so a dependency install is cached independently of source.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/connector/package.json apps/connector/
RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/connector apps/connector
RUN pnpm --filter @pilots/protocol build \
 && pnpm --filter @pilots/connector build \
 && pnpm --filter @pilots/connector --prod deploy /out

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The definitions are the shared artefact, and the connector refuses to load one
# that does not lint — so they are baked in and validated at boot.
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/connector/dist ./dist
COPY --from=build /repo/apps/connector/src/admin-ui/dist ./dist/admin-ui/dist
COPY docs/definitions ./definitions

ENV PILOTS_HOST=0.0.0.0 \
    PILOTS_PORT=3000 \
    PILOTS_STORE=file \
    PILOTS_STORE_DIR=/data \
    PILOTS_DEFINITIONS_DIR=/app/definitions

# One mounted volume is the whole of the small-party deployment. `/shared` is
# optional and empty unless PILOTS_INTEGRATION_KEY_FILE points into it — it
# exists so a co-deployed UI can be handed a *generated* key without one being
# committed anywhere. Both are owned by `node`, because the process does not run
# as root.
VOLUME ["/data"]
RUN mkdir -p /data /shared && chown -R node:node /data /shared /app
USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PILOTS_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
