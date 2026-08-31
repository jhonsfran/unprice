import { initTRPC } from "@trpc/server"
import { Namespace, createCache } from "@unkey/cache"
import { MemoryStore } from "@unkey/cache/stores"
import { Ok } from "@unprice/error"
import {
  type GetUsageDashboardOutput,
  emptyUsageDashboardOutput,
} from "@unprice/services/use-cases"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "#trpc"

const useCases = vi.hoisted(() => ({ getUsageDashboard: vi.fn() }))

vi.mock("#trpc", async () => {
  const { initTRPC } = await import("@trpc/server")
  return { protectedProjectProcedure: initTRPC.create().procedure }
})
vi.mock("@unprice/services/use-cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@unprice/services/use-cases")>()),
  getUsageDashboard: useCases.getUsageDashboard,
}))

import { getUsageDashboard } from "./getUsageDashboard"

const router = initTRPC.context<Context>().create().router({ getUsageDashboard })
const input = { range: "30d" } as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-08-31T12:00:00Z"))
})
afterEach(() => vi.useRealTimers())

function setup() {
  const pending: Promise<unknown>[] = []
  const cache = createCache({
    getUsageDashboard: new Namespace<GetUsageDashboardOutput | null>(
      {
        waitUntil: (promise) => {
          pending.push(promise)
        },
      },
      {
        stores: [new MemoryStore({ persistentMap: new Map() })],
        fresh: 30_000,
        stale: 3_600_000,
      }
    ),
  })
  const caller = router.createCaller({
    project: { id: "proj_123" },
    cache,
    logger: { error: vi.fn() },
  } as unknown as Context)
  return { cache, caller, flush: () => Promise.all(pending.splice(0)) }
}

function evidence(usage: number): GetUsageDashboardOutput {
  return {
    ...emptyUsageDashboardOutput(input.range),
    summary: { featureCount: 1, totalLatestUsage: usage, spending: [] },
    features: [
      {
        featureSlug: "tokens",
        usage,
        spending: { amount: "0", currency: "USD", displayAmount: "$0.00" },
      },
    ],
  }
}

describe("getUsageDashboard cache", () => {
  it("ignores legacy empty entries and retains the loaded evidence", async () => {
    const { cache, caller, flush } = setup()
    await cache.getUsageDashboard.set(
      "usage-dashboard:proj_123:all:30d:10",
      emptyUsageDashboardOutput(input.range)
    )
    const result = evidence(7)
    useCases.getUsageDashboard.mockResolvedValue(Ok(result))

    await expect(caller.getUsageDashboard(input)).resolves.toEqual(result)
    await flush()
    await expect(caller.getUsageDashboard(input)).resolves.toEqual(result)
    expect(useCases.getUsageDashboard).toHaveBeenCalledTimes(1)
  })

  it("returns stale evidence while retaining the background refresh", async () => {
    const { caller, flush } = setup()
    const first = evidence(1)
    const refreshed = evidence(7)
    useCases.getUsageDashboard.mockResolvedValueOnce(Ok(first)).mockResolvedValueOnce(Ok(refreshed))

    await caller.getUsageDashboard(input)
    await flush()
    vi.advanceTimersByTime(30_001)
    await expect(caller.getUsageDashboard(input)).resolves.toEqual(first)
    await flush()
    await expect(caller.getUsageDashboard(input)).resolves.toEqual(refreshed)
    expect(useCases.getUsageDashboard).toHaveBeenCalledTimes(2)
  })

  it("retries empty reads but caches evidence with zero usage", async () => {
    const { caller, flush } = setup()
    useCases.getUsageDashboard
      .mockResolvedValueOnce(Ok(emptyUsageDashboardOutput(input.range)))
      .mockResolvedValueOnce(Ok(evidence(0)))

    await caller.getUsageDashboard(input)
    await flush()
    await expect(caller.getUsageDashboard(input)).resolves.toEqual(evidence(0))
    await flush()
    await expect(caller.getUsageDashboard(input)).resolves.toEqual(evidence(0))
    expect(useCases.getUsageDashboard).toHaveBeenCalledTimes(2)
  })
})
