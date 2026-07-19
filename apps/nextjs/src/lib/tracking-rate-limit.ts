import { createFixedWindowLimiter } from "@unprice/services/cache"
import { ipAddress } from "@vercel/functions"
import { log } from "evlog"
import type { NextRequest } from "next/server"
import { env } from "~/env"

type TrackingAction = "page_hit" | "plan_click"

const TRACKING_RATE_LIMIT_KEY_PREFIX = "nextjs:tracking:rate-limit"

// One shared budget per client IP across both actions: generous for a human
// clicking through pages, tight enough to stop a script from inflating
// Tinybird ingestion volume through this unauthenticated endpoint.
const TRACKING_IP_LIMIT = 120
const TRACKING_WINDOW_SECONDS = 60

const trackingRateLimiter = createFixedWindowLimiter<{ action: TrackingAction }>({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
  keyPrefix: TRACKING_RATE_LIMIT_KEY_PREFIX,
  latencyLogging: env.NODE_ENV === "development",
  onDisabled: ({ action }) => {
    if (env.NODE_ENV !== "test" && env.APP_ENV !== "development") {
      log.warn({
        message: "Tracking rate limiter disabled because Upstash Redis is not configured",
        tracking_action: action,
      })
    }
  },
  onError: (error, { action }) => {
    log.error({
      message: "Tracking rate limit check failed",
      error,
      tracking_action: action,
    })
  },
})

function resolveTrackingClientIp(req: NextRequest): string {
  return (
    ipAddress(req) ||
    req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  )
}

export async function checkTrackingRateLimit({
  req,
  action,
}: {
  req: NextRequest
  action: TrackingAction
}): Promise<{ limited: false } | { limited: true; retryAfterSeconds: number }> {
  const ip = resolveTrackingClientIp(req)

  const result = await trackingRateLimiter.consume(
    {
      identity: `ip:${ip}`,
      limit: TRACKING_IP_LIMIT,
      name: "tracking:ip",
      windowSeconds: TRACKING_WINDOW_SECONDS,
    },
    { action }
  )

  if (result?.limited) {
    log.warn({
      message: "Tracking request rate limited",
      tracking_action: action,
      rate_limit: {
        count: result.count,
        key: result.key,
        limit: TRACKING_IP_LIMIT,
        reset_at: result.resetAt.toISOString(),
        window_seconds: TRACKING_WINDOW_SECONDS,
      },
    })

    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)),
    }
  }

  return { limited: false }
}
