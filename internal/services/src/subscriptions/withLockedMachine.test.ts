import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CustomerService } from "../customers/service"
import type { LedgerGateway } from "../ledger"
import type { RatingService } from "../rating/service"
import type { SubscriptionRepository } from "./repository"
import { LockLostError, withLockedMachine } from "./withLockedMachine"

type LockRow = { ownerToken: string; expiresAt: number; updatedAtM: number }
type FakeDb = Database & { __debug: { rows: Map<string, LockRow> } }

const machineMocks = vi.hoisted(() => ({
  create: vi.fn(),
  shutdown: vi.fn(),
}))

vi.mock("./machine", () => ({
  SubscriptionMachine: {
    create: machineMocks.create,
  },
}))

describe("withLockedMachine", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    machineMocks.create.mockReset()
    machineMocks.shutdown.mockReset()
    machineMocks.shutdown.mockResolvedValue(undefined)
    machineMocks.create.mockResolvedValue({
      err: undefined,
      val: { shutdown: machineMocks.shutdown },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("extends lock ownership while the machine operation is still running", async () => {
    const projectId = "proj_1"
    const subscriptionId = "sub_1"
    const db = createFakeDb(projectId, subscriptionId)
    const runStarted = createDeferred<void>()
    const finishRun = createDeferred<void>()
    let lockNow = 1_000

    const first = withLockedMachine({
      ...createDeps(projectId, subscriptionId, db),
      lockHeartbeatIntervalMs: 5,
      lockNow: () => lockNow,
      ttlMs: 10,
      run: async () => {
        runStarted.resolve()
        await finishRun.promise
        return "first"
      },
    })

    await runStarted.promise

    lockNow = 1_006
    await vi.advanceTimersByTimeAsync(5)
    expect(db.__debug.rows.get(`${projectId}:${subscriptionId}`)?.expiresAt).toBe(1_016)

    lockNow = 1_011
    await expect(
      withLockedMachine({
        ...createDeps(projectId, subscriptionId, db),
        lockHeartbeatIntervalMs: 5,
        lockNow: () => lockNow,
        ttlMs: 10,
        run: async () => "second",
      })
    ).rejects.toThrow("SUBSCRIPTION_BUSY")

    finishRun.resolve()
    await expect(first).resolves.toBe("first")
    expect(machineMocks.create).toHaveBeenCalledTimes(1)
    expect(machineMocks.shutdown).toHaveBeenCalledTimes(1)
  })

  it("assertLockHeld throws LockLostError when the heartbeat detects lock loss", async () => {
    const projectId = "proj_1"
    const subscriptionId = "sub_1"
    const db = createFakeDb(projectId, subscriptionId)
    const runStarted = createDeferred<void>()
    const finishRun = createDeferred<void>()
    let lockNow = 1_000

    const result = withLockedMachine({
      ...createDeps(projectId, subscriptionId, db),
      lockHeartbeatIntervalMs: 5,
      lockNow: () => lockNow,
      ttlMs: 10,
      run: async (_machine, assertLockHeld) => {
        runStarted.resolve()

        // Wait for the heartbeat to fire and detect lock loss
        await finishRun.promise

        // This should throw because the lock was lost
        assertLockHeld()
        return "should not reach"
      },
    })

    await runStarted.promise

    // Simulate lock expiry + takeover: advance time past TTL and let another
    // owner take the lock row so the heartbeat extend returns false.
    lockNow = 1_100
    const row = db.__debug.rows.get(`${projectId}:${subscriptionId}`)!
    row.ownerToken = "other_owner"
    row.expiresAt = 1_200
    row.updatedAtM = 1_100

    await vi.advanceTimersByTimeAsync(5)

    finishRun.resolve()
    await expect(result).rejects.toThrow(LockLostError)
  })

  it("assertLockHeld is a no-op when the lock is still held", async () => {
    const projectId = "proj_1"
    const subscriptionId = "sub_1"
    const db = createFakeDb(projectId, subscriptionId)
    let lockNow = 1_000

    const result = await withLockedMachine({
      ...createDeps(projectId, subscriptionId, db),
      lockHeartbeatIntervalMs: 50,
      lockNow: () => lockNow,
      ttlMs: 100,
      run: async (_machine, assertLockHeld) => {
        // Should not throw -- lock is fresh
        assertLockHeld()
        return "ok"
      },
    })

    expect(result).toBe("ok")
  })
})

function createDeps(projectId: string, subscriptionId: string, db: Database) {
  return {
    analytics: {} as Analytics,
    customer: {} as CustomerService,
    db,
    ledgerService: {} as LedgerGateway,
    logger: createLogger(),
    now: 0,
    projectId,
    ratingService: {} as RatingService,
    repo: {} as SubscriptionRepository,
    subscriptionId,
  }
}

function createLogger(): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createFakeDb(projectId: string, subscriptionId: string): FakeDb {
  const key = `${projectId}:${subscriptionId}`
  const rows = new Map<string, LockRow>()
  // Track the token set during insert (acquire) so the extend path can
  // simulate the real SQL's `WHERE ownerToken = this.token` check.
  let acquiredToken: string | null = null

  const db = {
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        const promise = Promise.resolve().then(() => {
          const existing = rows.get(key)
          const createdAt = Number(value.createdAtM ?? 0)
          if (existing && existing.expiresAt > createdAt) {
            throw new Error("unique constraint violation")
          }

          const row = {
            ownerToken: String(value.ownerToken),
            expiresAt: Number(value.expiresAt),
            updatedAtM: Number(value.updatedAtM ?? createdAt),
          }
          rows.set(key, row)
          acquiredToken = row.ownerToken
          return [row]
        })

        return Object.assign(promise, {
          returning: async () => await promise,
        })
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const promise = Promise.resolve().then(() => {
            const row = rows.get(key)
            if (!row) return []

            const now = Number(patch.updatedAtM ?? 0)
            const isExpired = row.expiresAt < now
            const isStale = row.expiresAt < now + 120_000 && row.updatedAtM < now - 1_000

            if (isExpired || isStale) {
              const next = {
                ownerToken: String(patch.ownerToken ?? row.ownerToken),
                expiresAt: Number(patch.expiresAt ?? row.expiresAt),
                updatedAtM: now,
              }
              rows.set(key, next)
              if (patch.ownerToken !== undefined) {
                acquiredToken = next.ownerToken
              }
              return [next]
            }

            // Extend path: no ownerToken in patch.
            // Simulate the real SQL WHERE `ownerToken = this.token` by checking
            // row.ownerToken still matches the token from the original acquire.
            if (row.expiresAt > now && patch.ownerToken === undefined) {
              if (acquiredToken !== null && row.ownerToken !== acquiredToken) {
                return []
              }

              const next = {
                ownerToken: row.ownerToken,
                expiresAt: Number(patch.expiresAt ?? row.expiresAt),
                updatedAtM: now,
              }
              rows.set(key, next)
              return [next]
            }

            return []
          })

          return Object.assign(promise, {
            returning: async () => await promise,
          })
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        rows.delete(key)
      },
    }),
    __debug: { rows },
  }

  return db as unknown as FakeDb
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, reject, resolve }
}
