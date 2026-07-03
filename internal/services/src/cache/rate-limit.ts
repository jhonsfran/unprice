export type FixedWindowRateLimitRedis = {
  expire(key: string, seconds: number): Promise<unknown>
  incr(key: string): Promise<number>
}

export type FixedWindowRateLimitResult = {
  count: number
  key: string
  limited: boolean
  resetAt: Date
}

export type FixedWindowRateLimitOptions = {
  identity: string
  keyPrefix: string
  limit: number
  name: string
  now?: number
  redis: FixedWindowRateLimitRedis
  windowSeconds: number
}

function encodeRedisKeyPart(value: string): string {
  return encodeURIComponent(value).slice(0, 200)
}

export async function consumeFixedWindowRateLimit({
  identity,
  keyPrefix,
  limit,
  name,
  now = Date.now(),
  redis,
  windowSeconds,
}: FixedWindowRateLimitOptions): Promise<FixedWindowRateLimitResult> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Rate limit must be a positive integer")
  }

  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("Rate limit window must be a positive integer")
  }

  const windowMs = windowSeconds * 1000
  const windowId = Math.floor(now / windowMs)
  const resetAt = new Date((windowId + 1) * windowMs)
  const key = [
    encodeRedisKeyPart(keyPrefix),
    encodeRedisKeyPart(name),
    encodeRedisKeyPart(identity),
    windowId.toString(),
  ].join(":")

  const count = await redis.incr(key)
  await redis.expire(key, windowSeconds * 2)

  return {
    count,
    key,
    limited: count > limit,
    resetAt,
  }
}
