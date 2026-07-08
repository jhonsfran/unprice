import type { Logger } from "@unprice/logs"
import type { GrantConsumptionState } from "@unprice/services/entitlements"
import { DO_IDEMPOTENCY_TTL_MS, computeGrantPeriodBucket } from "@unprice/services/entitlements"
import { describe, expect, it } from "vitest"
import { idempotencyEntryToApplyResult } from "./batch-apply-helpers"
import type {
  ActiveGrantInput,
  ApplyResult,
  BatchIdempotencyEntry,
  WalletReservationSnapshot,
} from "./contracts"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import type {
  EnsureWalletReservationParams,
  EntitlementWindowProcessorDeps,
  EntitlementWindowStateOps,
  EntitlementWindowStateStore,
  WalletReservationPatch,
} from "./ports"
import { EntitlementWindowProcessor } from "./processor"

// Characterizes the port boundary: the processor must run against a plain
// in-memory store (no Durable Object, no SQLite/drizzle) using the real meter
// engine, real pricing, and real Zod contracts. This is the seam a future
// Redis-backed store implements.

type MeterStateRow = { usage: number; updatedAt: number | null; createdAt: number }

class InMemoryEntitlementWindowStore implements EntitlementWindowStateStore {
  meterStates = new Map<string, MeterStateRow>()
  grantStates = new Map<string, GrantConsumptionState>()
  idempotency = new Map<string, BatchIdempotencyEntry>()
  walletRow: NonNullable<WalletReservationSnapshot> | null = null

  constructor(private readonly onStateChanged: () => void = () => {}) {}

  atomically<T>(fn: (tx: EntitlementWindowStateOps) => T): T {
    const snapshot = {
      meterStates: new Map([...this.meterStates].map(([k, v]) => [k, { ...v }])),
      grantStates: new Map([...this.grantStates].map(([k, v]) => [k, { ...v }])),
      idempotency: new Map(this.idempotency),
      walletRow: this.walletRow ? { ...this.walletRow } : null,
    }
    try {
      return fn(this)
    } catch (error) {
      this.meterStates = snapshot.meterStates
      this.grantStates = snapshot.grantStates
      this.idempotency = snapshot.idempotency
      this.walletRow = snapshot.walletRow
      throw error
    }
  }

  ensureMeterState(params: { meterKey: string; createdAt: number }): void {
    if (this.meterStates.has(params.meterKey)) return
    this.meterStates.set(params.meterKey, {
      usage: 0,
      updatedAt: null,
      createdAt: params.createdAt,
    })
  }

  readMeterStateDraft(meterKey: string, createdAt: number) {
    const row = this.meterStates.get(meterKey)
    return {
      createdAt,
      dirty: false,
      exists: Boolean(row),
      meterKey,
      updatedAt: row?.updatedAt ?? null,
      usage: row?.usage ?? 0,
    }
  }

  writeMeterState(params: {
    meterKey: string
    createdAt: number
    usage: number
    updatedAt: number | null
  }): void {
    this.ensureMeterState(params)
    const row = this.meterStates.get(params.meterKey)
    if (!row) return
    row.usage = params.usage
    row.updatedAt = params.updatedAt
  }

  readGrantStatesForActiveGrants(
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[] {
    return this.readGrantStatesForBatch(grants, [timestamp])
  }

  readGrantStatesForBatch(
    grants: ActiveGrantInput[],
    timestamps: number[]
  ): GrantConsumptionState[] {
    const bucketKeys = new Set(
      timestamps.flatMap((timestamp) =>
        grants
          .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
          .filter((key): key is string => typeof key === "string")
      )
    )
    return [...this.grantStates.values()]
      .filter((state) => bucketKeys.has(state.bucketKey))
      .map((state) => ({ ...state }))
  }

  writeGrantConsumptions(states: Iterable<GrantConsumptionState>): number {
    const periodKeys = new Set<string>()
    for (const state of states) {
      this.grantStates.set(state.bucketKey, { ...state })
      periodKeys.add(state.periodKey)
    }
    if (periodKeys.size > 0) this.onStateChanged()
    return periodKeys.size
  }

  lookupCachedIdempotencyResult(eventId: string): ApplyResult | null {
    const entry = this.idempotency.get(eventId)
    return entry ? idempotencyEntryToApplyResult(entry) : null
  }

  lookupCachedIdempotencyResults(eventIds: string[]): Map<string, BatchIdempotencyEntry> {
    const results = new Map<string, BatchIdempotencyEntry>()
    for (const eventId of eventIds) {
      const entry = this.idempotency.get(eventId)
      if (entry) results.set(eventId, entry)
    }
    return results
  }

  writeBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void {
    for (const entry of entries) {
      this.idempotency.set(entry.eventId, entry)
    }
  }

  recordBatchIdempotencyResults(_entries: BatchIdempotencyEntry[]): void {
    // Durable map doubles as the read cache in this in-memory store.
  }

  cleanupStaleIdempotencyKeys(now: number): number {
    const cutoff = now - DO_IDEMPOTENCY_TTL_MS
    let removed = 0
    for (const [eventId, entry] of this.idempotency) {
      if (entry.createdAt < cutoff) {
        this.idempotency.delete(eventId)
        removed++
      }
    }
    return removed
  }

  readLifecycleEndAt(): number | null {
    const ends: number[] = []
    for (const state of this.grantStates.values()) {
      if (Number.isFinite(state.periodEndAt)) ends.push(state.periodEndAt)
    }
    if (typeof this.walletRow?.reservationEndAt === "number") {
      ends.push(this.walletRow.reservationEndAt)
    }
    return ends.length > 0 ? Math.max(...ends) : null
  }

  readWalletReservation(): WalletReservationSnapshot {
    return this.walletRow ? { ...this.walletRow } : null
  }

  ensureWalletReservation(params: EnsureWalletReservationParams): void {
    this.walletRow = {
      reservationId: null,
      allocationAmount: 0,
      consumedAmount: 0,
      flushedAmount: 0,
      consumedQuantity: 0,
      flushedQuantity: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      targetReservationAmount: 0,
      spendEwmaAmount: 0,
      lastRateSampledAtMs: null,
      maxEventCostAmount: 0,
      pendingRefillAmount: 0,
      pendingFlushAmount: null,
      pendingFlushQuantity: null,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      pendingFlushFinal: false,
      lastEventAt: null,
      lastFlushedAt: null,
      deletionRequested: false,
      recoveryRequired: false,
      ...(this.walletRow ?? {}),
      projectId: params.projectId,
      customerId: params.customerId,
      currency: params.currency,
      reservationEndAt: params.reservationEndAt,
      billingPeriodId: params.billingPeriodId ?? null,
      cycleEndAt: params.cycleEndAt ?? null,
      cycleStartAt: params.cycleStartAt ?? null,
      featurePlanVersionItemId: params.featurePlanVersionItemId ?? null,
      featureSlug: params.featureSlug ?? null,
      statementKey: params.statementKey ?? null,
    }
  }

  updateWalletReservation(patch: WalletReservationPatch): void {
    // Mirrors the SQLite singleton-row semantics: an update with no row is a no-op.
    if (!this.walletRow) return
    Object.assign(this.walletRow, patch)
  }
}

function createNoopLogger(): Logger {
  return {
    set: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
  }
}

function createHarness(
  params: { now: number; store?: InMemoryEntitlementWindowStore } = { now: Date.now() }
) {
  const waitUntilPromises: Promise<unknown>[] = []
  let alarmAt: number | null = null
  let destroyed = false
  const processorRef: { current: EntitlementWindowProcessor | null } = { current: null }
  const store =
    params.store ??
    new InMemoryEntitlementWindowStore(() =>
      processorRef.current?.invalidateEnforcementStateCache()
    )

  const deps: EntitlementWindowProcessorDeps = {
    clock: { now: () => params.now },
    instrument: (_operation, fn) => fn(),
    logger: createNoopLogger(),
    runtime: {
      instanceId: "window_test_1",
      waitUntil: (promise) => {
        waitUntilPromises.push(promise)
      },
      destroyWindow: async () => {
        destroyed = true
        alarmAt = null
      },
    },
    scheduler: {
      getAlarm: async () => alarmAt,
      setAlarm: async (at) => {
        alarmAt = at
      },
      deleteAlarm: async () => {
        alarmAt = null
      },
    },
    store,
    timing: { inactivityThresholdMs: 60 * 60 * 1000, maxFlushIntervalMs: 10 * 60_000 },
    wallet: {
      get: () => {
        throw new Error("wallet must not be constructed for uncapped entitlements")
      },
    },
  }
  const processor = new EntitlementWindowProcessor(deps)
  processorRef.current = processor

  return {
    processor,
    store,
    waitUntilPromises,
    getAlarmAt: () => alarmAt,
    wasDestroyed: () => destroyed,
  }
}

function createLiveApplyInput(now: number, overrides: Record<string, unknown> = {}) {
  const eventOverrides = (overrides.event as Record<string, unknown> | undefined) ?? {}
  return createApplyInput({
    creditLinePolicy: "uncapped",
    now,
    periodStartAt: now - 60_000,
    periodEndAt: now + 60_000,
    ...overrides,
    event: { timestamp: now, ...eventOverrides },
  })
}

describe("EntitlementWindowProcessor with an in-memory (non-DO) store", () => {
  it("applies, seals idempotency, and replays without recomputing", async () => {
    const now = Date.now()
    const harness = createHarness({ now })
    await harness.processor.initialize()

    const input = createLiveApplyInput(now, {
      idempotencyKey: "idem_port_1",
      event: { id: "evt_port_1", properties: { amount: 3 } },
    })

    const first = await harness.processor.apply(input)
    expect(first.allowed).toBe(true)
    expect(first.meterFacts).toHaveLength(1)
    expect(first.meterFacts?.[0]).toMatchObject({ delta: 3, value_after: 3 })

    const replay = await harness.processor.apply(input)
    expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
    // The replay must come from the sealed entry, not a re-run of the meter.
    expect(harness.store.meterStates.values().next().value?.usage).toBe(3)
    // A post-commit alarm was scheduled for lifecycle work.
    await Promise.all(harness.waitUntilPromises)
    expect(harness.getAlarmAt()).not.toBeNull()
  })

  it("enforces hard limits and seals the denial for stable retries", async () => {
    const now = Date.now()
    const harness = createHarness({ now })
    await harness.processor.initialize()

    const input = createLiveApplyInput(now, {
      enforceLimit: true,
      limit: 2,
      idempotencyKey: "idem_port_denied",
      event: { id: "evt_port_denied", properties: { amount: 3 } },
    })

    const denied = await harness.processor.apply(input)
    expect(denied).toMatchObject({ allowed: false, deniedReason: "LIMIT_EXCEEDED" })

    const replay = await harness.processor.apply(input)
    expect(replay).toMatchObject({
      allowed: false,
      deniedReason: "LIMIT_EXCEEDED",
      idempotencyStatus: "already_reported",
    })
    // The denied event must not consume grant units.
    expect(
      await harness.processor.getEnforcementState({
        entitlement: input.entitlement,
        grants: input.grants,
        now,
      })
    ).toMatchObject({ usage: 0, limit: 2, isLimitReached: false })
  })

  it("keeps committed state visible to a fresh processor over the same store", async () => {
    const now = Date.now()
    const first = createHarness({ now })
    await first.processor.initialize()

    const input = createLiveApplyInput(now, {
      idempotencyKey: "idem_port_evict",
      event: { id: "evt_port_evict", properties: { amount: 5 } },
    })
    await first.processor.apply(input)

    // Same durable state, new processor instance — the "eviction" contract.
    const revived = createHarness({ now, store: first.store })
    await revived.processor.initialize()

    const replay = await revived.processor.apply(input)
    expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
    await expect(
      revived.processor.getEnforcementState({
        entitlement: input.entitlement,
        grants: input.grants,
        now,
      })
    ).resolves.toMatchObject({ usage: 5 })
  })

  it("rolls back the whole atomic command when a commit fails mid-write", async () => {
    const now = Date.now()
    const harness = createHarness({ now })
    await harness.processor.initialize()

    const originalWrite = harness.store.writeBatchIdempotencyResults.bind(harness.store)
    let failNext = true
    harness.store.writeBatchIdempotencyResults = (entries) => {
      if (failNext) {
        failNext = false
        throw new Error("simulated storage failure")
      }
      originalWrite(entries)
    }

    const input = createLiveApplyInput(now, {
      idempotencyKey: "idem_port_rollback",
      event: { id: "evt_port_rollback", properties: { amount: 4 } },
    })

    await expect(harness.processor.apply(input)).rejects.toThrow("simulated storage failure")
    // Nothing from the failed command may survive: no seal, no meter usage.
    expect(harness.store.idempotency.size).toBe(0)
    expect(harness.store.meterStates.size).toBe(0)

    const retried = await harness.processor.apply(input)
    expect(retried).toMatchObject({ allowed: true })
    expect(retried.idempotencyStatus).toBeUndefined()
    expect(harness.store.meterStates.values().next().value?.usage).toBe(4)
  })
})
