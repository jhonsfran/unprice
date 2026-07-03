import { describe, expect, it } from "vitest"
import { consumeFixedWindowRateLimit } from "./rate-limit"

function createFakeRedis() {
  const counters = new Map<string, number>()
  const expirations = new Map<string, number>()

  return {
    expirations,
    async expire(key: string, seconds: number) {
      expirations.set(key, seconds)
      return 1 as const
    },
    async incr(key: string) {
      const next = (counters.get(key) ?? 0) + 1
      counters.set(key, next)
      return next
    },
  }
}

describe("fixed-window rate limit helper", () => {
  it("counts requests inside a fixed window", async () => {
    const redis = createFakeRedis()

    const first = await consumeFixedWindowRateLimit({
      identity: "ip:203.0.113.10",
      keyPrefix: "auth:rate-limit",
      limit: 2,
      name: "credentials-login",
      now: 1000,
      redis,
      windowSeconds: 60,
    })

    const second = await consumeFixedWindowRateLimit({
      identity: "ip:203.0.113.10",
      keyPrefix: "auth:rate-limit",
      limit: 2,
      name: "credentials-login",
      now: 30_000,
      redis,
      windowSeconds: 60,
    })

    const third = await consumeFixedWindowRateLimit({
      identity: "ip:203.0.113.10",
      keyPrefix: "auth:rate-limit",
      limit: 2,
      name: "credentials-login",
      now: 59_000,
      redis,
      windowSeconds: 60,
    })

    expect(first).toMatchObject({ count: 1, limited: false })
    expect(second).toMatchObject({ count: 2, limited: false })
    expect(third).toMatchObject({ count: 3, limited: true })
    expect(first.key).toBe(second.key)
    expect(redis.expirations.get(first.key)).toBe(120)
  })

  it("opens a new counter in the next window", async () => {
    const redis = createFakeRedis()

    const first = await consumeFixedWindowRateLimit({
      identity: "email:user%40example.com",
      keyPrefix: "auth:rate-limit",
      limit: 1,
      name: "credentials-signup",
      now: 59_000,
      redis,
      windowSeconds: 60,
    })

    const second = await consumeFixedWindowRateLimit({
      identity: "email:user%40example.com",
      keyPrefix: "auth:rate-limit",
      limit: 1,
      name: "credentials-signup",
      now: 60_000,
      redis,
      windowSeconds: 60,
    })

    expect(first).toMatchObject({ count: 1, limited: false })
    expect(second).toMatchObject({ count: 1, limited: false })
    expect(first.key).not.toBe(second.key)
  })
})
