# syntax=docker/dockerfile:1.23

ARG NODE_VERSION=20.20.2-slim

FROM node:${NODE_VERSION} AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

FROM base AS builder
WORKDIR /app

# Build from repo root (monorepo) so workspace packages are available.
COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

ENV NODE_ENV=production
ENV NEXT_OUTPUT_STANDALONE=1
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_DISABLE_STATIC_DOMAIN_GENERATION=1
ENV UNPRICE_API_KEY=docker-build-placeholder

RUN pnpm --filter nextjs build

FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=builder --chown=node:node /app/apps/nextjs/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/nextjs/.next/static ./apps/nextjs/.next/static
COPY --from=builder --chown=node:node /app/apps/nextjs/public ./apps/nextjs/public

USER node
EXPOSE 3000

CMD ["node", "apps/nextjs/server.js"]
