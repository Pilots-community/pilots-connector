# The process UI: a BFF that holds one API key, and the SPA it serves.
#
# One container for the pair — the BFF has to exist anyway to keep a
# participant-wide credential out of the browser, so serving the static files
# from it costs nothing.
#
# Deliberately dispensable: stop this and the connector carries on. Processes
# keep running, peers keep delivering, a subscribed backoffice keeps receiving.
# It is a client, not part of the runtime, and nothing here holds state the
# connector needs.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo

# Manifests first, so a dependency install is cached independently of source.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY packages/bpmn/package.json packages/bpmn/
COPY apps/process-ui/package.json apps/process-ui/
RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY packages/client packages/client
COPY packages/bpmn packages/bpmn
COPY apps/process-ui apps/process-ui
RUN pnpm --filter @pilots/protocol build \
 && pnpm --filter @pilots/client build \
 && pnpm --filter @pilots/bpmn build \
 && pnpm --filter @pilots/process-ui build \
 && pnpm --filter @pilots/process-ui --prod deploy /out

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/process-ui/dist ./dist

ENV PILOTS_UI_HOST=0.0.0.0 \
    PILOTS_UI_PORT=4000

# No volume, and nothing to persist. Users and sessions live in memory: correct
# for a demo, and the honest reason this container can be discarded freely.
USER node
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PILOTS_UI_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]
