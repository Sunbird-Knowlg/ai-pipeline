# syntax=docker/dockerfile:1.7
# One image per deployable: docker build --build-arg PACKAGE=@ai-pipeline/<name> .
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate && npm install -g turbo@2.11.2 --no-fund --no-audit
WORKDIR /repo

# Only the package and its workspace dependencies (and a matching lockfile subset).
FROM base AS prune
ARG PACKAGE
COPY . .
RUN turbo prune "${PACKAGE}" --docker

FROM base AS build
ARG PACKAGE
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
# The shared compiler config is a workspace package (@ai-pipeline/typescript-config), so
# `turbo prune` carries it; nothing has to be copied in from the repo root.
RUN turbo run build --filter="${PACKAGE}"
# Self-contained production tree: dist/ + metadata.json + prod node_modules (workspace deps injected).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter="${PACKAGE}" deploy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/ .
USER node
EXPOSE 9080
CMD ["node", "dist/main.js"]
