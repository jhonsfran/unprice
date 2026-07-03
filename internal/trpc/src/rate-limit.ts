import type { Logger } from "@unprice/logs"
import {
  type FixedWindowRateLimitResult,
  type FixedWindowRateLimitRedis as RateLimitRedis,
  consumeFixedWindowRateLimit as consumeFixedWindowRateLimitBase,
  createRedis,
} from "@unprice/services/cache"
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

let rateLimitRedis: RateLimitRedis | null | undefined
let didWarnMissingRedis = false

function getRateLimitRedis(): RateLimitRedis | null {
  if (rateLimitRedis !== undefined) {
    return rateLimitRedis
  }

  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    rateLimitRedis = null
    return rateLimitRedis
  }

  rateLimitRedis = createRedis({
    token: env.UPSTASH_REDIS_REST_TOKEN,
    url: env.UPSTASH_REDIS_REST_URL,
    latencyLogging: env.NODE_ENV === "development",
  })

  return rateLimitRedis
}

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

export async function consumeFixedWindowRateLimit({
  identity,
  limit,
  name,
  now = Date.now(),
  redis,
  windowSeconds,
}: {
  identity: string
  limit: number
  name: string
  now?: number
  redis: RateLimitRedis
  windowSeconds: number
}): Promise<TrpcRateLimitResult> {
  return consumeFixedWindowRateLimitBase({
    identity,
    keyPrefix: "trpc:rate-limit",
    limit,
    name,
    now,
    redis,
    windowSeconds,
  })
}

export async function checkTrpcRateLimit(
  ctx: RateLimitContext,
  config: TrpcRateLimitConfig & { path: string }
): Promise<TrpcRateLimitResult | null> {
  const redis = getRateLimitRedis()

  if (!redis) {
    if (!didWarnMissingRedis && env.NODE_ENV !== "test" && env.APP_ENV !== "development") {
      didWarnMissingRedis = true
      ctx.logger.warn("tRPC rate limiter disabled because Upstash Redis is not configured", {
        path: config.path,
      })
    }

    return null
  }

  const identity = resolveTrpcRateLimitIdentity(ctx, config.scope)

  try {
    return await consumeFixedWindowRateLimit({
      identity,
      limit: config.limit,
      name: config.name ?? config.path,
      redis,
      windowSeconds: config.windowSeconds,
    })
  } catch (error) {
    ctx.logger.error(error instanceof Error ? error : String(error), {
      context: "trpc rate limit check failed",
      path: config.path,
    })

    return null
  }
}
