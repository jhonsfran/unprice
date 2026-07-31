import "server-only"

import { createFixedWindowLimiter } from "@unprice/services/cache"
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

const authRateLimiter = createFixedWindowLimiter<{ action: CredentialsAction }>({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
  keyPrefix: AUTH_RATE_LIMIT_KEY_PREFIX,
  latencyLogging: env.NODE_ENV === "development",
  onDisabled: ({ action }) => {
    if (env.NODE_ENV !== "test" && env.APP_ENV !== "development") {
      log.warn({
        message: "Credentials auth rate limiter disabled because Upstash Redis is not configured",
        auth_action: action,
      })
    }
  },
  onError: (error, { action }) => {
    log.error({
      message: "Credentials auth rate limit check failed",
      error,
      auth_action: action,
    })
  },
})

function normalizeEmailForRateLimit(email: string): string {
  return email.trim().toLowerCase().slice(0, 320) || "unknown"
}

async function resolveClientIp(): Promise<string> {
  const requestHeaders = await headers()
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
  const ip = await resolveClientIp()
  const rules = buildCredentialsRateLimitRules({ action, email, ip })

  for (const rule of rules) {
    const result = await authRateLimiter.consume(
      {
        identity: rule.identity,
        limit: rule.limit,
        name: rule.name,
        windowSeconds: rule.windowSeconds,
      },
      { action }
    )

    if (result?.limited) {
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

  return { limited: false }
}
