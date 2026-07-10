import type { Logger } from "@unprice/logs"
import { type FixedWindowRateLimitResult, createFixedWindowLimiter } from "@unprice/services/cache"
import { env } from "./env"

export type TrpcRateLimitScope = "ip" | "project" | "user" | "workspace"

export type TrpcRateLimitConfig = {
  limit: number
  name?: string
  scope: TrpcRateLimitScope
  windowSeconds: number
}

type RateLimitContext = {
  activeProjectSlug: string
  activeWorkspaceSlug: string
  geolocation: {
    ip: string
  }
  logger: Logger
  session: {
    user?: {
      id?: string
    }
  } | null
  userId?: string
  project?: {
    id: string
  }
  workspace?: {
    id: string
  }
}

export type TrpcRateLimitResult = FixedWindowRateLimitResult

const trpcRateLimiter = createFixedWindowLimiter<{ logger: Logger; path: string }>({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
  keyPrefix: "trpc:rate-limit",
  latencyLogging: env.NODE_ENV === "development",
  onDisabled: ({ logger, path }) => {
    if (env.NODE_ENV !== "test" && env.APP_ENV !== "development") {
      logger.warn("tRPC rate limiter disabled because Upstash Redis is not configured", {
        path,
      })
    }
  },
  onError: (error, { logger, path }) => {
    logger.error(error instanceof Error ? error : String(error), {
      context: "trpc rate limit check failed",
      path,
    })
  },
})

function fallbackUserIdentity(ctx: RateLimitContext): string {
  const userId = ctx.userId ?? ctx.session?.user?.id

  if (userId) {
    return `user:${userId}`
  }

  return `ip:${ctx.geolocation.ip || "unknown"}`
}

export function resolveTrpcRateLimitIdentity(
  ctx: RateLimitContext,
  scope: TrpcRateLimitScope
): string {
  switch (scope) {
    case "ip":
      return `ip:${ctx.geolocation.ip || "unknown"}`
    case "project":
      return ctx.project?.id
        ? `project:${ctx.project.id}`
        : ctx.activeProjectSlug
          ? `project-slug:${ctx.activeProjectSlug}`
          : fallbackUserIdentity(ctx)
    case "workspace":
      return ctx.workspace?.id
        ? `workspace:${ctx.workspace.id}`
        : ctx.activeWorkspaceSlug
          ? `workspace-slug:${ctx.activeWorkspaceSlug}`
          : fallbackUserIdentity(ctx)
    case "user":
      return fallbackUserIdentity(ctx)
  }
}

export async function checkTrpcRateLimit(
  ctx: RateLimitContext,
  config: TrpcRateLimitConfig & { path: string }
): Promise<TrpcRateLimitResult | null> {
  const identity = resolveTrpcRateLimitIdentity(ctx, config.scope)

  return trpcRateLimiter.consume(
    {
      identity,
      limit: config.limit,
      name: config.name ?? config.path,
      windowSeconds: config.windowSeconds,
    },
    { logger: ctx.logger, path: config.path }
  )
}
