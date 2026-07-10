import {
  type FixedWindowRateLimitRedis,
  type FixedWindowRateLimitResult,
  consumeFixedWindowRateLimit,
} from "./rate-limit"
import { createRedis } from "./upstash"

export type FixedWindowLimiterConsumeInput = {
  identity: string
  limit: number
  name: string
  windowSeconds: number
  now?: number
}

export type FixedWindowLimiter<TContext> = {
  /**
   * Consume one unit against the fixed window. Returns the rate-limit result, or
   * `null` when the limiter is fail-open — Redis is unconfigured (`onDisabled`
   * fires once) or the backend threw (`onError` fires). Callers treat `null` as
   * "not limited".
   */
  consume(
    input: FixedWindowLimiterConsumeInput,
    context: TContext
  ): Promise<FixedWindowRateLimitResult | null>
}

/**
 * Fixed-window rate limiter owning the shared boilerplate every caller repeated:
 * lazy Upstash client construction, a warn-once latch when Redis is not
 * configured, and fail-open on both the disabled and error paths. Adapters keep
 * only their identity resolution and logging (via the onDisabled/onError hooks).
 */
export function createFixedWindowLimiter<TContext = void>(options: {
  url: string | undefined
  token: string | undefined
  keyPrefix: string
  latencyLogging?: boolean
  onDisabled?: (context: TContext) => void
  onError?: (error: unknown, context: TContext) => void
}): FixedWindowLimiter<TContext> {
  let redis: FixedWindowRateLimitRedis | null | undefined
  let didWarnMissing = false

  function getRedis(): FixedWindowRateLimitRedis | null {
    if (redis !== undefined) {
      return redis
    }

    if (!options.url || !options.token) {
      redis = null
      return redis
    }

    redis = createRedis({
      token: options.token,
      url: options.url,
      latencyLogging: options.latencyLogging,
    })

    return redis
  }

  return {
    async consume(input, context) {
      const client = getRedis()

      if (!client) {
        if (!didWarnMissing) {
          didWarnMissing = true
          options.onDisabled?.(context)
        }

        return null
      }

      try {
        return await consumeFixedWindowRateLimit({
          identity: input.identity,
          keyPrefix: options.keyPrefix,
          limit: input.limit,
          name: input.name,
          now: input.now,
          redis: client,
          windowSeconds: input.windowSeconds,
        })
      } catch (error) {
        options.onError?.(error, context)
        return null
      }
    },
  }
}
