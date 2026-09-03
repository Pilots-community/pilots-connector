# The mock backoffice: a stand-in for a participant's own systems.
#
# It exists so "one side automates, the other clicks" is a deployment difference
# rather than a slide. Org B runs this instead of a UI; the connectors cannot
# tell the difference, because there is none to tell — same API, same key, same
# rules. One is a person clicking and one is a machine reacting.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY apps/mock-backoffice/package.json apps/mock-backoffice/
RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY packages/client packages/client
COPY apps/mock-backoffice apps/mock-backoffice
RUN pnpm --filter @pilots/protocol build \
 && pnpm --filter @pilots/client build \
 && pnpm --filter @pilots/mock-backoffice build \
 && pnpm --filter @pilots/mock-backoffice --prod deploy /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/mock-backoffice/dist ./dist

# No volume and nothing to persist: it holds a cursor in memory and recovers it
# from the connector's authoritative replay after a restart.
USER node
EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PILOTS_BACKOFFICE_PORT||5000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
