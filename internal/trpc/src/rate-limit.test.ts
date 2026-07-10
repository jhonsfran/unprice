import { consumeFixedWindowRateLimit } from "@unprice/services/cache"
import { describe, expect, it } from "vitest"
import { resolveTrpcRateLimitIdentity } from "./rate-limit"

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

const logger = {
  debug: () => undefined,
  error: () => undefined,
  flush: () => Promise.resolve(),
  info: () => undefined,
  set: () => undefined,
  warn: () => undefined,
}

describe("tRPC rate limit helpers", () => {
  it("counts requests inside a fixed window", async () => {
    const redis = createFakeRedis()

    const first = await consumeFixedWindowRateLimit({
      identity: "workspace:ws_123",
      keyPrefix: "trpc:rate-limit",
      limit: 2,
      name: "workspaces.inviteMember",
      now: 1000,
      redis,
      windowSeconds: 60,
    })

    const second = await consumeFixedWindowRateLimit({
      identity: "workspace:ws_123",
      keyPrefix: "trpc:rate-limit",
      limit: 2,
      name: "workspaces.inviteMember",
      now: 30_000,
      redis,
      windowSeconds: 60,
    })

    const third = await consumeFixedWindowRateLimit({
      identity: "workspace:ws_123",
      keyPrefix: "trpc:rate-limit",
      limit: 2,
      name: "workspaces.inviteMember",
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
      identity: "user:user_123",
      keyPrefix: "trpc:rate-limit",
      limit: 1,
      name: "workspaces.signUp",
      now: 59_000,
      redis,
      windowSeconds: 60,
    })

    const second = await consumeFixedWindowRateLimit({
      identity: "user:user_123",
      keyPrefix: "trpc:rate-limit",
      limit: 1,
      name: "workspaces.signUp",
      now: 60_000,
      redis,
      windowSeconds: 60,
    })

    expect(first).toMatchObject({ count: 1, limited: false })
    expect(second).toMatchObject({ count: 1, limited: false })
    expect(first.key).not.toBe(second.key)
  })

  it("resolves identities by the requested scope", () => {
    const ctx = {
      activeProjectSlug: "project-slug",
      activeWorkspaceSlug: "workspace-slug",
      geolocation: { ip: "203.0.113.10" },
      logger,
      project: { id: "proj_123" },
      session: { user: { id: "user_123" } },
      userId: "user_123",
      workspace: { id: "ws_123" },
    }

    expect(resolveTrpcRateLimitIdentity(ctx, "user")).toBe("user:user_123")
    expect(resolveTrpcRateLimitIdentity(ctx, "workspace")).toBe("workspace:ws_123")
    expect(resolveTrpcRateLimitIdentity(ctx, "project")).toBe("project:proj_123")
    expect(resolveTrpcRateLimitIdentity(ctx, "ip")).toBe("ip:203.0.113.10")
  })
})
