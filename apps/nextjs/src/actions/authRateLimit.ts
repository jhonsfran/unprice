import "server-only"

import {
  type FixedWindowRateLimitRedis,
  consumeFixedWindowRateLimit,
  createRedis,
} from "@unprice/services/cache"
import { log } from "evlog"
import { headers } from "next/headers"
import { env } from "~/env"

type CredentialsAction = "credentials-login" | "credentials-signup"

type RateLimitRule = {
  identity: string
  limit: number
  name: string
  windowSeconds: number
}

const AUTH_RATE_LIMIT_KEY_PREFIX = "nextjs:auth:rate-limit"
const AUTH_RATE_LIMITED_MESSAGE = "Too many attempts. Try again later."

let authRateLimitRedis: FixedWindowRateLimitRedis | null | undefined
let didWarnMissingRedis = false

function getAuthRateLimitRedis(): FixedWindowRateLimitRedis | null {
  if (authRateLimitRedis !== undefined) {
    return authRateLimitRedis
  }

  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    authRateLimitRedis = null
    return authRateLimitRedis
  }

  authRateLimitRedis = createRedis({
    token: env.UPSTASH_REDIS_REST_TOKEN,
    url: env.UPSTASH_REDIS_REST_URL,
    latencyLogging: env.NODE_ENV === "development",
  })

  return authRateLimitRedis
}

function normalizeEmailForRateLimit(email: string): string {
  return email.trim().toLowerCase().slice(0, 320) || "unknown"
}

function resolveClientIp(): string {
  const requestHeaders = headers()
  const forwardedFor = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()

  return (
    requestHeaders.get("x-real-ip")?.trim() ||
    requestHeaders.get("cf-connecting-ip")?.trim() ||
    forwardedFor ||
    "unknown"
  )
}

function buildCredentialsRateLimitRules({
  action,
  email,
  ip,
}: {
  action: CredentialsAction
  email: string
  ip: string
}): RateLimitRule[] {
  const normalizedEmail = normalizeEmailForRateLimit(email)

  if (action === "credentials-login") {
    return [
      {
        identity: `ip:${ip}`,
        limit: 50,
        name: "credentials-login:ip",
        windowSeconds: 10 * 60,
      },
      {
        identity: `ip:${ip}:email:${normalizedEmail}`,
        limit: 10,
        name: "credentials-login:ip-email",
        windowSeconds: 10 * 60,
      },
    ]
  }

  return [
    {
      identity: `ip:${ip}`,
      limit: 10,
      name: "credentials-signup:ip",
      windowSeconds: 60 * 60,
    },
    {
      identity: `ip:${ip}:email:${normalizedEmail}`,
      limit: 5,
      name: "credentials-signup:ip-email",
      windowSeconds: 60 * 60,
    },
  ]
}

export async function checkCredentialsActionRateLimit({
  action,
  email,
}: {
  action: CredentialsAction
  email: string
}): Promise<{ limited: false } | { limited: true; message: string }> {
  const redis = getAuthRateLimitRedis()

  if (!redis) {
    if (!didWarnMissingRedis && env.NODE_ENV !== "test" && env.APP_ENV !== "development") {
      didWarnMissingRedis = true
      log.warn({
        message: "Credentials auth rate limiter disabled because Upstash Redis is not configured",
        auth_action: action,
      })
    }

    return { limited: false }
  }

  const ip = resolveClientIp()
  const rules = buildCredentialsRateLimitRules({ action, email, ip })

  try {
    for (const rule of rules) {
      const result = await consumeFixedWindowRateLimit({
        identity: rule.identity,
        keyPrefix: AUTH_RATE_LIMIT_KEY_PREFIX,
        limit: rule.limit,
        name: rule.name,
        redis,
        windowSeconds: rule.windowSeconds,
      })

      if (result.limited) {
        log.warn({
          message: "Credentials auth action rate limited",
          auth_action: action,
          rate_limit: {
            count: result.count,
            key: result.key,
            limit: rule.limit,
            reset_at: result.resetAt.toISOString(),
            window_seconds: rule.windowSeconds,
          },
        })

        return { limited: true, message: AUTH_RATE_LIMITED_MESSAGE }
      }
    }
  } catch (error) {
    log.error({
      message: "Credentials auth rate limit check failed",
      error,
      auth_action: action,
    })
  }

  return { limited: false }
}
