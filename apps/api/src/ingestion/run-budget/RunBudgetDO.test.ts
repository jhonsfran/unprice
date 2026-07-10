import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import type * as DbSchema from "@unprice/db/schema"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const BASE_NOW = Date.UTC(2026, 2, 19, 12, 0, 0)
const DO_STARTUP_TEST_TIMEOUT_MS = 15_000

function createMeterFact(
  overrides: Partial<AnalyticsEntitlementMeterFact> = {}
): AnalyticsEntitlementMeterFact {
  return {
    event_id: "evt_1",
    idempotency_key: "idem_event_1:ew",
    workspace_id: "ws_1",
    project_id: "proj_1",
    customer_id: "cus_1",
    environment: "test",
    api_key_id: "key_1",
    source_type: "api_key",
    source_id: "key_1",
    source_name: null,
    customer_entitlement_id: "ce_test_1",
    feature_slug: "tokens",
    period_key: "period_1",
    event_slug: "tokens_used",
    aggregation_method: "sum",
    timestamp: BASE_NOW,
    created_at: BASE_NOW,
    delta: 5,
    value_after: 5,
    grant_id: "grant_1",
    feature_plan_version_id: "fpv_1",
    amount: 5000,
    amount_after: 5000,
    amount_scale: 8,
    currency: "USD",
    priced_at: BASE_NOW,
    tier_index: null,
    tier_mode: null,
    pricing_component_count: 1,
    ...overrides,
  }
}

/**
 * Default entitlement config and grants for test fixtures.
 * These pass the DO's Zod validation and are forwarded to the EntitlementWindowDO mock.
 */
const TEST_ENTITLEMENT_FIELDS = {
  customerEntitlementId: "ce_test_1",
  entitlement: {
    billingPeriods: [
      {
        billingPeriodId: "bp_1",
        cycleEndAt: BASE_NOW + 86_400_000,
        cycleStartAt: BASE_NOW - 86_400_000,
        featurePlanVersionItemId: "item_1",
        statementKey: "stmt_1",
      },
    ],
    creditLinePolicy: "uncapped",
    customerEntitlementId: "ce_test_1",
    customerId: "cus_1",
    effectiveAt: BASE_NOW - 86_400_000,
    expiresAt: null,
    featureConfig: {
      usageMode: "unit",
      price: {
        dinero: {
          amount: 0,
          currency: { code: "USD", base: 10, exponent: 2 },
          scale: 2,
        },
        displayAmount: "0.00",
      },
    },
    featurePlanVersionId: "fpv_1",
    featureSlug: "tokens",
    featureType: "usage",
    meterConfig: {
      eventSlug: "tokens_used",
      eventId: "meter_1",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_1",
    resetConfig: null,
    subscriptionItemId: null,
  },
  grants: [
    {
      allowanceUnits: 1000,
      cadenceEffectiveAt: BASE_NOW - 86_400_000,
      cadenceExpiresAt: null,
      currencyCode: "USD",
      effectiveAt: BASE_NOW - 86_400_000,
      expiresAt: null,
      grantId: "grant_1",
      priority: 0,
      resetConfig: null,
    },
  ],
} as const

type FakeDurableObjectState = {
  alarmAt: number | null
  deletedAlarm: boolean
  id: { toString: () => string }
  blockConcurrencyWhile: <T>(cb: () => Promise<T> | T) => Promise<T>
  storage: {
    deleteAlarm: () => Promise<void>
    getAlarm: () => Promise<number | null>
    setAlarm: (ts: number) => Promise<void>
  }
}

type RunBudgetDOConstructor = new (
  state: FakeDurableObjectState,
  env: unknown
) => {
  startRun: (input: unknown) => Promise<unknown>
  applySyncEvent: (input: unknown) => Promise<unknown>
  endRun: (input: unknown) => Promise<unknown>
  getRunStatus: (input: unknown) => Promise<unknown>
  flushCaptures: () => Promise<void>
  flushCapturesForInvoicing: (input: unknown) => Promise<unknown>
  alarm: () => Promise<void>
}

const testState = {
  createConnection: vi.fn(() => ({})),
  createReservation: vi.fn(),
  captureReservationUsage: vi.fn(),
  releaseReservation: vi.fn(),
  walletServiceConstructions: 0,
  entitlementWindowApply: vi.fn(),
  failRunIdempotencyInsert: false,
  omitTerminalEndedAtFromIdempotency: false,
  runSpendBuckets: new Map<string, Record<string, unknown>>(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    info: vi.fn(),
    set: vi.fn(),
    warn: vi.fn(),
  },
}

describe("RunBudgetDO", () => {
  beforeAll(async () => {
    await loadRunBudgetDO()
  }, DO_STARTUP_TEST_TIMEOUT_MS)

  beforeEach(() => {
    for (const fn of Object.values(testState.logger)) fn.mockReset()
    testState.createConnection.mockClear()
    testState.createReservation.mockReset()
    testState.captureReservationUsage.mockReset()
    testState.releaseReservation.mockReset()
    testState.walletServiceConstructions = 0
    testState.entitlementWindowApply.mockReset()
    testState.failRunIdempotencyInsert = false
    testState.omitTerminalEndedAtFromIdempotency = false
    testState.runSpendBuckets.clear()

    // Default mocks
    testState.createReservation.mockResolvedValue({
      err: null,
      val: { reservationId: "res_test_123", allocationAmount: 100_000 },
    })
    testState.captureReservationUsage.mockResolvedValue({
      err: null,
      val: { capturedAmount: 0 },
    })
    testState.releaseReservation.mockResolvedValue({
      err: null,
      val: { releasedAmount: 0 },
    })
    testState.entitlementWindowApply.mockResolvedValue({
      allowed: true,
      meterFacts: [createMeterFact()],
    })

    vi.spyOn(Date, "now").mockReturnValue(BASE_NOW)
  })

  afterEach(() => {
    const dateNow = Date.now as typeof Date.now & { mockRestore?: () => void }
    dateNow.mockRestore?.()
  })

  it(
    "startRun creates a wallet reservation and persists run state",
    async () => {
      const RunBudgetDO = await loadRunBudgetDO()
      const state = createDurableObjectState()
      const env = createEnv()
      const durable = new RunBudgetDO(state, env)

      const result = await durable.startRun({
        workloadType: "agent",
        workloadId: "agent_1",
        runId: "run_1",
        customerId: "cus_1",
        projectId: "proj_1",
        currency: "USD",
        budgetAmount: 100_000,
        idempotencyKey: "idem_start_1",
        metadata: { test: true },
        now: BASE_NOW,
      })

      expect(result).toMatchObject({
        runId: "run_1",
        status: "running",
        budgetAmount: 100_000,
        consumedAmount: 0,
        remainingAmount: 100_000,
      })
      expect(testState.createReservation).toHaveBeenCalledTimes(1)
      expect(testState.createReservation).toHaveBeenCalledWith({
        projectId: "proj_1",
        customerId: "cus_1",
        currency: "USD",
        entitlementId: null,
        owner: { type: "agent_run", id: "run_1" },
        requestedAmount: 100_000,
        minimumAllocationAmount: 100_000,
        refillThresholdBps: 2000,
        refillChunkAmount: 100_000,
        periodStartAt: new Date(BASE_NOW),
        periodEndAt: new Date(BASE_NOW + 24 * 60 * 60 * 1000),
        idempotencyKey: "idem_start_1",
        metadata: {
          run_id: "run_1",
          trace_id: null,
          parent_run_id: null,
          workload_type: "agent",
          workload_id: "agent_1",
        },
      })
    },
    DO_STARTUP_TEST_TIMEOUT_MS
  )

  it("returns the input timestamp when wallet reservation fails during start", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const durable = new RunBudgetDO(createDurableObjectState(), createEnv())
    testState.createReservation.mockResolvedValue({
      err: new Error("wallet empty"),
      val: null,
    })

    const result = await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "run_wallet_empty",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_wallet_empty",
      metadata: {},
      now: BASE_NOW,
    })

    expect(result).toMatchObject({
      runId: "run_wallet_empty",
      status: "failed",
      endedAt: BASE_NOW,
      walletError: "wallet empty",
    })
  })

  it("constructs wallet services per public RPC wallet operation on one DO instance", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const durable = new RunBudgetDO(state, createEnv())

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_wallet_scope",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_wallet_scope",
      metadata: {},
      now: BASE_NOW,
    })

    expect(testState.createConnection).toHaveBeenCalledTimes(1)
    expect(testState.walletServiceConstructions).toBe(1)

    await durable.endRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_wallet_scope",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: BASE_NOW + 5000,
    })

    expect(testState.createConnection).toHaveBeenCalledTimes(2)
    expect(testState.createConnection).toHaveBeenNthCalledWith(1, {
      env: "test",
      primaryDatabaseUrl: "postgres://user:pass@localhost:5432/unprice",
      read1DatabaseUrl: "postgres://user:pass@localhost:5432/unprice",
      read2DatabaseUrl: "postgres://user:pass@localhost:5432/unprice",
      logger: false,
      singleton: false,
    })
    expect(testState.createConnection).toHaveBeenNthCalledWith(2, {
      env: "test",
      primaryDatabaseUrl: "postgres://user:pass@localhost:5432/unprice",
      read1DatabaseUrl: "postgres://user:pass@localhost:5432/unprice",
      read2DatabaseUrl: "postgres://user:pass@localhost:5432/unprice",
      logger: false,
      singleton: false,
    })
    const startConnection = testState.createConnection.mock.results[0]?.value
    const endConnection = testState.createConnection.mock.results[1]?.value
    expect(startConnection).toBeDefined()
    expect(endConnection).toBeDefined()
    expect(endConnection).not.toBe(startConnection)
    expect(testState.walletServiceConstructions).toBe(2)
  })

  it(
    "startRun is idempotent - returns existing run state",
    async () => {
      const RunBudgetDO = await loadRunBudgetDO()
      const state = createDurableObjectState()
      const env = createEnv()
      const durable = new RunBudgetDO(state, env)

      const input = {
        workloadType: "agent",
        workloadId: "agent_1",
        runId: "run_1",
        customerId: "cus_1",
        projectId: "proj_1",
        currency: "USD",
        budgetAmount: 100_000,
        idempotencyKey: "idem_start_1",
        metadata: {},
        now: BASE_NOW,
      }

      const first = await durable.startRun(input)
      const second = await durable.startRun(input)

      expect(first).toEqual(second)
      // Wallet reservation only called once
      expect(testState.createReservation).toHaveBeenCalledTimes(1)
    },
    DO_STARTUP_TEST_TIMEOUT_MS
  )

  it("applySyncEvent returns cached decision for duplicate idempotency keys", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    const eventInput = {
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_1",
      event: {
        id: "evt_1",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    }

    const first = await durable.applySyncEvent(eventInput)
    const second = await durable.applySyncEvent(eventInput)

    expect(first).toEqual(second)
    expect(first.allowed).toBe(true)
    // EntitlementWindowDO only called once
    expect(testState.entitlementWindowApply).toHaveBeenCalledTimes(1)
  })

  it("returns meter facts decorated with run analytics context", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      workloadType: "agent",
      workloadId: "research-assistant",
      traceId: "trace_001",
      parentRunId: "brun_parent_001",
      metadata: {},
      now: BASE_NOW,
    })

    testState.entitlementWindowApply.mockResolvedValue({
      allowed: true,
      meterFacts: [
        {
          event_id: "evt_001",
          idempotency_key: "apply_001:ew",
          workspace_id: "ws_1",
          project_id: "proj_1",
          customer_id: "cus_1",
          environment: "test",
          api_key_id: "key_1",
          source_type: "api_key",
          source_id: "key_1",
          source_name: null,
          customer_entitlement_id: "ce_test_1",
          grant_id: "grant_1",
          feature_plan_version_id: "fpv_1",
          feature_slug: "tokens",
          period_key: "period_1",
          event_slug: "tokens_used",
          aggregation_method: "sum",
          timestamp: BASE_NOW,
          created_at: BASE_NOW,
          delta: 5,
          value_after: 5,
          amount: 250,
          amount_after: 250,
          amount_scale: 8,
          currency: "USD",
          priced_at: BASE_NOW,
          tier_index: 0,
          tier_mode: "volume",
          pricing_component_count: 1,
          statement_key: "stmt_1",
          period_start_at: BASE_NOW - 60_000,
          period_end_at: BASE_NOW + 60_000,
        },
      ],
    })

    const result = await durable.applySyncEvent({
      projectId: "proj_1",
      customerId: "cus_1",
      runId: "run_1",
      featureSlug: "tokens",
      idempotencyKey: "apply_001",
      event: {
        id: "evt_001",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 5 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key",
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    expect((result as { meterFacts: Record<string, unknown>[] }).meterFacts).toEqual([
      expect.objectContaining({
        run_id: "run_1",
        trace_id: "trace_001",
        parent_run_id: "brun_parent_001",
        workload_type: "agent",
        workload_id: "research-assistant",
      }),
    ])
  })

  it("applySyncEvent denies when run is not in running status", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    // End the run first
    await durable.endRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: BASE_NOW + 1000,
    })

    const result = await durable.applySyncEvent({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_late",
      event: {
        id: "evt_2",
        slug: "tokens_used",
        timestamp: BASE_NOW + 2000,
        properties: { amount: 1 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW + 2000,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    expect(result.allowed).toBe(false)
    expect(result.state).toBe("rejected")
    expect(result.rejectionReason).toBe("RUN_BUDGET_EXCEEDED")
    expect(result.message).toContain("completed")
    expect(result.meterFacts).toEqual([])
    expect(testState.entitlementWindowApply).not.toHaveBeenCalled()
  })

  it("applySyncEvent rejects events after expiresAt without pricing and closes expired", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000
    const expiredNow = expiresAt + 1

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_expired_apply",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_expired_apply",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    })

    const eventInput = {
      runId: "run_expired_apply",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_expired_apply",
      event: {
        id: "evt_expired_apply",
        slug: "tokens_used",
        timestamp: expiredNow,
        properties: { amount: 1 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: expiredNow,
      ...TEST_ENTITLEMENT_FIELDS,
    }

    vi.spyOn(Date, "now").mockReturnValue(expiredNow)
    // Simulate a decision cached by the pre-endedAt DO version. The first
    // response is current, while the stored replay payload intentionally omits
    // the terminal timestamp.
    testState.omitTerminalEndedAtFromIdempotency = true
    const result = await durable.applySyncEvent(eventInput)

    expect(result).toMatchObject({
      allowed: false,
      state: "rejected",
      rejectionReason: "RUN_BUDGET_EXCEEDED",
      budget: {
        runId: "run_expired_apply",
        status: "expired",
        endedAt: expiredNow,
        consumedAmount: 0,
        remainingAmount: 100_000,
      },
      meterFacts: [],
    })
    expect(result.message).toContain("expired")
    expect(testState.entitlementWindowApply).not.toHaveBeenCalled()
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)

    await expect(
      durable.getRunStatus({
        runId: "run_expired_apply",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      status: "expired",
      consumedAmount: 0,
      remainingAmount: 100_000,
    })

    const duplicate = await durable.applySyncEvent(eventInput)
    expect(duplicate).toMatchObject({
      allowed: result.allowed,
      state: result.state,
      rejectionReason: result.rejectionReason,
      budget: {
        runId: "run_expired_apply",
        status: "failed",
        endedAt: expiredNow,
        consumedAmount: 12_345,
        remainingAmount: 87_655,
      },
      meterFacts: [],
    })
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)
    expect(testState.entitlementWindowApply).not.toHaveBeenCalled()
  })

  it("applySyncEvent rejects post-expiry usage when capture retry is pending without adding spend", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000
    const expiredNow = expiresAt + 1

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_expired_pending_capture",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_expired_pending_capture",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    })

    await durable.applySyncEvent({
      runId: "run_expired_pending_capture",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_before_expiry",
      event: {
        id: "evt_before_expiry",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    testState.entitlementWindowApply.mockClear()
    testState.captureReservationUsage.mockRejectedValueOnce(new Error("wallet unavailable"))
    vi.spyOn(Date, "now").mockReturnValue(expiredNow)

    const result = await durable.applySyncEvent({
      runId: "run_expired_pending_capture",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_after_expiry",
      event: {
        id: "evt_after_expiry",
        slug: "tokens_used",
        timestamp: expiredNow,
        properties: { amount: 7 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: expiredNow,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    expect(result).toMatchObject({
      allowed: false,
      state: "rejected",
      rejectionReason: "RUN_BUDGET_EXCEEDED",
      budget: {
        runId: "run_expired_pending_capture",
        status: "running",
        consumedAmount: 5000,
        remainingAmount: 95_000,
      },
      meterFacts: [],
    })
    expect(result.message).toContain("expired")
    expect(testState.entitlementWindowApply).not.toHaveBeenCalled()
    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(1)

    await expect(
      durable.getRunStatus({
        runId: "run_expired_pending_capture",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      status: "running",
      consumedAmount: 5000,
      remainingAmount: 95_000,
    })
  })

  it("applySyncEvent denies when entitlement window denies", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    testState.entitlementWindowApply.mockResolvedValue({
      allowed: false,
      deniedReason: "LIMIT_EXCEEDED",
      message: "Usage limit exceeded",
    })

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    const result = await durable.applySyncEvent({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_denied",
      event: {
        id: "evt_3",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 100 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    expect(result.allowed).toBe(false)
    expect(result.rejectionReason).toBe("LIMIT_EXCEEDED")
    expect(result.message).toBe("Usage limit exceeded")
    expect(result.meterFacts).toEqual([])
  })

  it("applySyncEvent rejects missing billing period context before pricing", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    const eventInput = {
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_missing_period",
      event: {
        id: "evt_missing_period",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
      entitlement: {
        ...TEST_ENTITLEMENT_FIELDS.entitlement,
        billingPeriods: [],
      },
    }

    const result = await durable.applySyncEvent(eventInput)
    const duplicate = await durable.applySyncEvent(eventInput)

    expect(result).toEqual(duplicate)
    expect(result.allowed).toBe(false)
    expect(result.rejectionReason).toBe("LATE_EVENT_CLOSED_PERIOD")
    expect(result.message).toBe("No active billing period covers this event timestamp")
    expect(result.budget.consumedAmount).toBe(0)
    expect(testState.entitlementWindowApply).not.toHaveBeenCalled()
  })

  it("applySyncEvent updates consumed amount and schedules alarm", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    const result = await durable.applySyncEvent({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_1",
      event: {
        id: "evt_1",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    expect(result.allowed).toBe(true)
    expect(result.budget.consumedAmount).toBe(5000)
    expect(result.budget.remainingAmount).toBe(95_000)
    // Alarm scheduled since consumedAmount > flushedAmount
    expect(state.alarmAt).toBe(BASE_NOW + 10_000)
    expect(env.entitlementwindow.idFromName).toHaveBeenCalledWith("test:proj_1:cus_1:ce_test_1")
    expect(testState.entitlementWindowApply).toHaveBeenCalledWith({
      event: {
        id: "evt_1",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
        source: {
          workspaceId: "ws_1",
          environment: "test",
          apiKeyId: "key_1",
          sourceType: "api_key",
          sourceId: "key_1",
          sourceName: null,
        },
      },
      idempotencyKey: "idem_event_1:ew",
      projectId: "proj_1",
      customerId: "cus_1",
      entitlement: TEST_ENTITLEMENT_FIELDS.entitlement,
      grants: TEST_ENTITLEMENT_FIELDS.grants,
      enforceLimit: true,
      now: BASE_NOW,
      wallet: { mode: "external_reservation", remainingAmount: 100_000 },
    })
  })

  it("rejects malformed producer meter facts without persisting spend or idempotency", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const durable = new RunBudgetDO(createDurableObjectState(), createEnv())

    await durable.startRun({
      runId: "run_malformed_fact",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_malformed_fact",
      metadata: {},
      now: BASE_NOW,
    })

    const malformedFact: Record<string, unknown> = { ...createMeterFact() }
    delete malformedFact.customer_entitlement_id
    testState.entitlementWindowApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [malformedFact],
    })

    const eventInput = {
      runId: "run_malformed_fact",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_malformed_fact",
      event: {
        id: "evt_malformed_fact",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 5 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    }

    await expect(durable.applySyncEvent(eventInput)).rejects.toThrow("customer_entitlement_id")
    await expect(
      durable.getRunStatus({
        runId: "run_malformed_fact",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({ consumedAmount: 0, remainingAmount: 100_000 })
    expect(testState.runSpendBuckets.size).toBe(0)

    testState.entitlementWindowApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [createMeterFact()],
    })
    await expect(durable.applySyncEvent(eventInput)).resolves.toMatchObject({
      allowed: true,
      budget: { consumedAmount: 5000 },
    })
    expect(testState.entitlementWindowApply).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      factEntitlementId: "",
      label: "empty",
      expectedError: "customer_entitlement_id must be non-empty",
    },
    {
      factEntitlementId: "ce_other",
      label: "mismatched",
      expectedError: "customer_entitlement_id does not match requested entitlement",
    },
  ])(
    "rejects $label producer entitlement identity without local mutation or idempotency lockout",
    async ({ expectedError, factEntitlementId, label }) => {
      const RunBudgetDO = await loadRunBudgetDO()
      const durable = new RunBudgetDO(createDurableObjectState(), createEnv())
      const runId = `run_${label}_fact_entitlement`
      const idempotencyKey = `idem_${label}_fact_entitlement`

      await durable.startRun({
        runId,
        customerId: "cus_1",
        projectId: "proj_1",
        currency: "USD",
        budgetAmount: 100_000,
        idempotencyKey: `start_${idempotencyKey}`,
        metadata: {},
        now: BASE_NOW,
      })

      testState.entitlementWindowApply.mockResolvedValueOnce({
        allowed: true,
        meterFacts: [
          ...(label === "mismatched" ? [createMeterFact()] : []),
          createMeterFact({
            customer_entitlement_id: factEntitlementId,
            event_id: `fact_${label}_entitlement`,
          }),
        ],
      })
      const eventInput = {
        runId,
        customerId: "cus_1",
        projectId: "proj_1",
        featureSlug: "tokens",
        idempotencyKey,
        event: {
          id: `evt_${label}_fact_entitlement`,
          slug: "tokens_used",
          timestamp: BASE_NOW,
          properties: { amount: 5 },
        },
        source: {
          workspaceId: "ws_1",
          environment: "test",
          apiKeyId: "key_1",
          sourceType: "api_key" as const,
          sourceId: "key_1",
          sourceName: null,
        },
        now: BASE_NOW,
        ...TEST_ENTITLEMENT_FIELDS,
      }

      await expect(durable.applySyncEvent(eventInput)).rejects.toThrow(expectedError)
      await expect(
        durable.getRunStatus({ runId, customerId: "cus_1", projectId: "proj_1" })
      ).resolves.toMatchObject({ consumedAmount: 0, remainingAmount: 100_000 })
      expect(testState.runSpendBuckets.size).toBe(0)

      testState.entitlementWindowApply.mockResolvedValueOnce({
        allowed: true,
        meterFacts: [createMeterFact()],
      })
      await expect(durable.applySyncEvent(eventInput)).resolves.toMatchObject({
        allowed: true,
        budget: { consumedAmount: 5000 },
      })
      expect(testState.entitlementWindowApply).toHaveBeenCalledTimes(2)
    }
  )

  it("uses the run currency for spend buckets when producer facts carry another currency", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const durable = new RunBudgetDO(createDurableObjectState(), createEnv())

    await durable.startRun({
      runId: "run_eur",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "EUR",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_eur",
      metadata: {},
      now: BASE_NOW,
    })

    testState.entitlementWindowApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [createMeterFact({ currency: "USD" })],
    })
    await durable.applySyncEvent({
      runId: "run_eur",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_eur",
      event: {
        id: "evt_eur",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 5 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key",
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    expect([...testState.runSpendBuckets.values()]).toEqual([
      expect.objectContaining({ currency: "EUR" }),
    ])
  })

  it("serializes concurrent applySyncEvent calls before pricing against remaining budget", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const eventAmount = 7000

    let firstPricingStarted = () => undefined
    let releaseFirstPricing = () => undefined
    let pricingCallCount = 0
    const firstPricingStartedPromise = new Promise<void>((resolve) => {
      firstPricingStarted = resolve
    })
    const releaseFirstPricingPromise = new Promise<void>((resolve) => {
      releaseFirstPricing = resolve
    })

    testState.entitlementWindowApply.mockImplementation(async (input: unknown) => {
      pricingCallCount += 1
      const { remainingAmount } = (
        input as { wallet: { mode: "external_reservation"; remainingAmount: number } }
      ).wallet

      if (pricingCallCount === 1) {
        firstPricingStarted()
        await releaseFirstPricingPromise
      }

      if (remainingAmount < eventAmount) {
        return {
          allowed: false,
          deniedReason: "RUN_BUDGET_EXCEEDED",
          message: "Run budget exceeded",
          meterFacts: [],
        }
      }

      return {
        allowed: true,
        meterFacts: [
          createMeterFact({
            amount: eventAmount,
            amount_after: eventAmount,
            delta: 7,
            value_after: 7,
          }),
        ],
      }
    })

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 10_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    const eventInput = (suffix: string) => ({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: `idem_event_${suffix}`,
      event: {
        id: `evt_${suffix}`,
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 7 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    const first = durable.applySyncEvent(eventInput("1"))
    await firstPricingStartedPromise

    const second = durable.applySyncEvent(eventInput("2"))
    await Promise.resolve()

    expect(testState.entitlementWindowApply).toHaveBeenCalledTimes(1)
    releaseFirstPricing()

    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.allowed).toBe(true)
    expect(secondResult.allowed).toBe(false)
    expect(secondResult.rejectionReason).toBe("RUN_BUDGET_EXCEEDED")

    const firstPricingInput = testState.entitlementWindowApply.mock.calls[0]?.[0] as {
      wallet: { remainingAmount: number }
    }
    const secondPricingInput = testState.entitlementWindowApply.mock.calls[1]?.[0] as {
      wallet: { remainingAmount: number }
    }
    expect(firstPricingInput.wallet.remainingAmount).toBe(10_000)
    expect(secondPricingInput.wallet.remainingAmount).toBe(3000)

    await expect(
      durable.getRunStatus({
        runId: "run_1",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      consumedAmount: 7000,
      remainingAmount: 3000,
    })
  })

  it("rolls back spend when accepted decision idempotency fails", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    const eventInput = {
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_1",
      event: {
        id: "evt_1",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    }

    testState.failRunIdempotencyInsert = true
    await expect(durable.applySyncEvent(eventInput)).rejects.toThrow(
      "run idempotency insert failed"
    )

    const afterFailure = await durable.getRunStatus({
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
    })
    expect(afterFailure.consumedAmount).toBe(0)

    testState.failRunIdempotencyInsert = false
    const retry = await durable.applySyncEvent(eventInput)

    expect(retry.allowed).toBe(true)
    expect(retry.budget.consumedAmount).toBe(5000)
  })

  it("schedules expiresAt and closes the expired run in storage", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000

    await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_expiring_1",
      parentRunId: null,
      runId: "brun_expiring",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    })

    expect(state.alarmAt).toBe(expiresAt)

    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1)
    await durable.alarm()

    // The DO closes the run in its own SQLite storage and releases the wallet
    // reservation. It does NOT write to Postgres — that read model is refreshed
    // worker-side via listRunsRefreshed / the budget-runs-refresh sweep.
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)

    await expect(
      durable.getRunStatus({
        runId: "brun_expiring",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      runId: "brun_expiring",
      status: "expired",
      consumedAmount: 0,
      remainingAmount: 100_000,
    })
  })

  it("retries an existing capture intent with its original flush sequence and amount", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    testState.captureReservationUsage.mockRejectedValueOnce(new Error("wallet write committed"))

    await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_capture_snapshot_1",
      parentRunId: null,
      runId: "brun_capture_snapshot",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_capture_snapshot",
      metadata: {},
      now: BASE_NOW,
    })

    await durable.applySyncEvent({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_capture_snapshot",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_capture_snapshot_1",
      event: {
        id: "evt_capture_snapshot_1",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    await durable.flushCaptures()

    testState.entitlementWindowApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [
        createMeterFact({
          amount: 7000,
          amount_after: 12_000,
          delta: 7,
          timestamp: BASE_NOW + 1000,
          value_after: 12,
        }),
      ],
    })

    await durable.applySyncEvent({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_capture_snapshot",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_capture_snapshot_2",
      event: {
        id: "evt_capture_snapshot_2",
        slug: "tokens_used",
        timestamp: BASE_NOW + 1000,
        properties: { amount: 7 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW + 1000,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    vi.spyOn(Date, "now").mockReturnValue(BASE_NOW + 60_000)
    await durable.flushCaptures()

    expect(testState.captureReservationUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        amount: 5000,
        billingPeriodId: "bp_1",
        flushSeq: BASE_NOW,
        kind: "usage",
        metadata: expect.objectContaining({
          billing_period_id: "bp_1",
          feature_plan_version_item_id: "item_1",
          feature_slug: "tokens",
        }),
        statementKey: "stmt_1",
      })
    )
    expect(testState.captureReservationUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        amount: 5000,
        billingPeriodId: "bp_1",
        flushSeq: BASE_NOW,
        kind: "usage",
        statementKey: "stmt_1",
      })
    )

    await durable.flushCaptures()

    expect(testState.captureReservationUsage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        amount: 7000,
        billingPeriodId: "bp_1",
        flushSeq: BASE_NOW + 60_000,
        kind: "usage",
        statementKey: "stmt_1",
      })
    )
  })

  it("flushes only matching statement buckets for invoicing", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const entitlementWithTwoPeriods = {
      ...TEST_ENTITLEMENT_FIELDS,
      entitlement: {
        ...TEST_ENTITLEMENT_FIELDS.entitlement,
        billingPeriods: [
          ...TEST_ENTITLEMENT_FIELDS.entitlement.billingPeriods,
          {
            billingPeriodId: "bp_2",
            cycleEndAt: BASE_NOW + 172_800_000,
            cycleStartAt: BASE_NOW + 86_400_000,
            featurePlanVersionItemId: "item_1",
            statementKey: "stmt_2",
          },
        ],
      },
    }

    testState.entitlementWindowApply
      .mockResolvedValueOnce({
        allowed: true,
        meterFacts: [createMeterFact()],
      })
      .mockResolvedValueOnce({
        allowed: true,
        meterFacts: [
          createMeterFact({
            amount: 7000,
            amount_after: 12_000,
            delta: 7,
            idempotency_key: "idem_event_invoice_flush_2:ew",
            period_key: "period_2",
            timestamp: BASE_NOW + 86_400_000,
            value_after: 12,
          }),
        ],
      })

    await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_invoice_flush_1",
      parentRunId: null,
      runId: "brun_invoice_flush",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_invoice_flush",
      metadata: {},
      now: BASE_NOW,
    })

    await durable.applySyncEvent({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_invoice_flush",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_invoice_flush_1",
      event: {
        id: "evt_invoice_flush_1",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 5 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...entitlementWithTwoPeriods,
    })

    await durable.applySyncEvent({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_invoice_flush",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_invoice_flush_2",
      event: {
        id: "evt_invoice_flush_2",
        slug: "tokens_used",
        timestamp: BASE_NOW + 1000,
        properties: { amount: 7 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW + 1000,
      ...entitlementWithTwoPeriods,
    })

    expect([...testState.runSpendBuckets.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ billingPeriodId: "bp_1", statementKey: "stmt_1" }),
        expect.objectContaining({ billingPeriodId: "bp_2", statementKey: "stmt_2" }),
      ])
    )

    const invoicingFlush = await durable.flushCapturesForInvoicing({
      statementKey: "stmt_1",
      billingPeriodIds: ["bp_1"],
    })

    expect(invoicingFlush).toEqual({ ok: true, flushed: 1, skipped: 0 })
    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(1)
    expect(testState.captureReservationUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        amount: 5000,
        billingPeriodId: "bp_1",
        statementKey: "stmt_1",
      })
    )

    await durable.flushCaptures()

    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(2)
    expect(testState.captureReservationUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        amount: 7000,
        billingPeriodId: "bp_2",
        statementKey: "stmt_2",
      })
    )
  })

  it("defers expiration while capture intents remain unresolved", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000
    const expiredNow = expiresAt + 1

    testState.captureReservationUsage.mockRejectedValueOnce(
      new Error("wallet temporarily unavailable")
    )

    await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_expiring_capture_retry_1",
      parentRunId: null,
      runId: "brun_expiring_capture_retry",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    })

    await durable.applySyncEvent({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_expiring_capture_retry",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_expiring_capture_retry",
      event: {
        id: "evt_expiring_capture_retry",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    vi.spyOn(Date, "now").mockReturnValue(expiredNow)
    await durable.alarm()

    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(1)
    expect(testState.releaseReservation).not.toHaveBeenCalled()
    await expect(
      durable.getRunStatus({
        runId: "brun_expiring_capture_retry",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      runId: "brun_expiring_capture_retry",
      status: "running",
      consumedAmount: 5000,
      remainingAmount: 95_000,
    })
    // Exponential backoff: after one failed attempt (attemptCount=1) the next
    // capture retry is scheduled 30s * 2^1 = 60s out.
    expect(state.alarmAt).toBe(expiredNow + 60_000)

    vi.spyOn(Date, "now").mockReturnValue(expiredNow + 30_000)
    await durable.alarm()

    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(2)
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)
    await expect(
      durable.getRunStatus({
        runId: "brun_expiring_capture_retry",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      runId: "brun_expiring_capture_retry",
      status: "expired",
      consumedAmount: 5000,
      remainingAmount: 95_000,
    })
  })

  it("closes an expired run with a reconciliation flag once a capture is abandoned", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000
    const expiredNow = expiresAt + 1

    // The wallet never accepts the capture, so every retry fails.
    testState.captureReservationUsage.mockRejectedValue(new Error("wallet unavailable"))

    await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_expiring_capture_exhausted_1",
      parentRunId: null,
      runId: "brun_expiring_capture_exhausted",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_capture_exhausted",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    })

    await durable.applySyncEvent({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_expiring_capture_exhausted",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_capture_exhausted",
      event: {
        id: "evt_capture_exhausted",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    // Drive alarm cycles until the intent reaches MAX_CAPTURE_ATTEMPTS (5) and
    // transitions to terminal `abandoned`. After the fifth failed attempt the
    // run is no longer blocked from closing.
    vi.spyOn(Date, "now").mockReturnValue(expiredNow)
    await durable.alarm()
    await durable.alarm()
    await durable.alarm()

    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(5)
    // The run finally closes (expired) instead of being orphaned forever.
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)
    // A never-silent error log is emitted for the unbilled abandoned capture.
    expect(testState.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("reconciliation"),
      expect.objectContaining({
        recovery_required: true,
        run_id: "brun_expiring_capture_exhausted",
        project_id: "proj_1",
        abandoned_amount: 5000,
      })
    )

    const closed = await durable.getRunStatus({
      runId: "brun_expiring_capture_exhausted",
      customerId: "cus_1",
      projectId: "proj_1",
    })
    expect(closed).toMatchObject({
      runId: "brun_expiring_capture_exhausted",
      status: "expired",
      consumedAmount: 5000,
      remainingAmount: 95_000,
      reconciliationNeeded: true,
    })

    // Skip-guard: an abandoned intent must never be resurrected by a later flush.
    await durable.flushCaptures()
    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(5)
    await expect(
      durable.getRunStatus({
        runId: "brun_expiring_capture_exhausted",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({ status: "expired", reconciliationNeeded: true })
  })

  it("always reschedules an alarm while a retryable capture intent remains", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    // No expiresAt, so the only alarm source under test is capture retry.
    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_reschedule_invariant",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_reschedule_invariant",
      metadata: {},
      now: BASE_NOW,
    })

    await durable.applySyncEvent({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_reschedule_invariant",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_reschedule_invariant",
      event: {
        id: "evt_reschedule_invariant",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    // First flush fails, creating a `failed` intent that still has retries left.
    testState.captureReservationUsage.mockRejectedValue(new Error("wallet down"))
    await durable.flushCaptures()

    state.alarmAt = null
    await durable.alarm()

    // Invariant: a retryable (pending|failed) intent exists, so an alarm is set.
    expect(state.alarmAt).not.toBeNull()

    // Now let the capture succeed; the intent becomes terminal `captured`.
    testState.captureReservationUsage.mockReset()
    testState.captureReservationUsage.mockResolvedValue({ err: null, val: { capturedAmount: 0 } })

    state.alarmAt = null
    await durable.alarm()

    // No retryable intent remains and the run is non-expiring, so no capture
    // alarm is scheduled.
    expect(state.alarmAt).toBeNull()
    await expect(
      durable.getRunStatus({
        runId: "run_reschedule_invariant",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({ status: "running", reconciliationNeeded: false })
  })

  it("reschedules expiresAt when startRun returns an existing running run", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000
    const input = {
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_existing_expiring",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    }

    await durable.startRun(input)
    state.alarmAt = null

    await durable.startRun(input)

    expect(state.alarmAt).toBe(expiresAt)
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
  })

  it("finalizes an expired run only once and clears its expiry marker", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000

    await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_expiring_finalize_1",
      parentRunId: null,
      runId: "brun_finalize_once",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    })

    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1)
    await durable.alarm()

    // Closed + reservation released on the first alarm.
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)
    await expect(
      durable.getRunStatus({
        runId: "brun_finalize_once",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      runId: "brun_finalize_once",
      status: "expired",
      consumedAmount: 0,
      remainingAmount: 100_000,
    })

    // The expiry marker is cleared, so a subsequent alarm does not re-close or
    // re-release the same run.
    await durable.alarm()
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)
  })

  it("preserves expired status when endRun is called after alarm expiration", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)
    const expiresAt = BASE_NOW + 60_000

    await durable.startRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_expiring_terminal_1",
      parentRunId: null,
      runId: "brun_terminal_expired",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      expiresAt,
      now: BASE_NOW,
    })

    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1)
    await durable.alarm()

    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)

    const result = await durable.endRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      runId: "brun_terminal_expired",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: expiresAt + 5_000,
    })

    expect(result).toMatchObject({
      runId: "brun_terminal_expired",
      status: "expired",
      consumedAmount: 0,
      remainingAmount: 100_000,
    })
    expect(testState.releaseReservation).toHaveBeenCalledTimes(1)

    await expect(
      durable.getRunStatus({
        runId: "brun_terminal_expired",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({
      runId: "brun_terminal_expired",
      status: "expired",
    })
  })

  it("endRun calls flush and release, then updates status", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    // Apply some usage
    await durable.applySyncEvent({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      featureSlug: "tokens",
      idempotencyKey: "idem_event_1",
      event: {
        id: "evt_1",
        slug: "tokens_used",
        timestamp: BASE_NOW,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_1",
        environment: "test",
        apiKeyId: "key_1",
        sourceType: "api_key" as const,
        sourceId: "key_1",
        sourceName: null,
      },
      now: BASE_NOW,
      ...TEST_ENTITLEMENT_FIELDS,
    })

    const endedAt = BASE_NOW + 5000
    const result = await durable.endRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt,
    })

    expect(result.status).toBe("completed")
    expect(result.consumedAmount).toBe(5000)
    expect(result.endedAt).toBe(endedAt)
    // Capture was called during flush
    expect(testState.captureReservationUsage).toHaveBeenCalled()
    // Release was called
    expect(testState.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "release:run_1:res_test_123",
      })
    )
  })

  it("getRunStatus returns the current summary", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      currency: "USD",
      budgetAmount: 100_000,
      idempotencyKey: "idem_start_1",
      metadata: {},
      now: BASE_NOW,
    })

    const status = await durable.getRunStatus({
      workloadType: "agent",
      workloadId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
    })

    expect(status).toMatchObject({
      runId: "run_1",
      status: "running",
      budgetAmount: 100_000,
      consumedAmount: 0,
      remainingAmount: 100_000,
    })
  })

  it("getRunStatus throws when run does not exist", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await expect(
      durable.getRunStatus({
        workloadType: "agent",
        workloadId: "agent_1",
        runId: "nonexistent",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).rejects.toThrow("RUN_NOT_FOUND")
  })
})

// --- Test helpers ---

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name")

/**
 * Convert snake_case SQL column name to camelCase JS property name.
 */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Extract column name and comparison value from a drizzle eq() SQL expression.
 *
 * eq(column, value) produces queryChunks:
 *   [StringChunk(''), Column(name), StringChunk(' = '), Param(value), StringChunk('')]
 */
function extractEqInfo(where: unknown): { field: string; value: unknown } | null {
  if (!where || typeof where !== "object") return null
  const chunks = (where as Record<string, unknown>).queryChunks as unknown[]
  if (!Array.isArray(chunks) || chunks.length < 4) return null

  // Find the column chunk (has .name as a string for the SQL column name)
  const columnNames: string[] = []
  const paramValues: unknown[] = []
  let foundEquals = false
  let containsCompositeOperator = false

  for (const chunk of chunks) {
    if (!chunk) continue
    if (typeof chunk !== "object") continue
    // Column: has `.name` that is a string and `.columnType` property
    if (typeof chunk.name === "string" && chunk.columnType) {
      columnNames.push(chunk.name)
    }
    // StringChunk: check for ' = ' operator
    if (Array.isArray(chunk.value)) {
      const text = chunk.value.join("")
      if (text.includes(" = ")) {
        foundEquals = true
      }
      if (text.includes(" AND ") || text.includes(" OR ") || text.includes(" IN ")) {
        containsCompositeOperator = true
      }
    }
    // Param: has `.value` and `.encoder` properties
    if (
      "value" in chunk &&
      !Array.isArray(chunk.value) &&
      !(typeof chunk.name === "string" && chunk.columnType)
    ) {
      paramValues.push(chunk.value)
    }
  }

  if (
    columnNames.length > 0 &&
    paramValues.length === 1 &&
    foundEquals &&
    !containsCompositeOperator
  ) {
    return { field: snakeToCamel(columnNames[columnNames.length - 1]!), value: paramValues[0] }
  }
  return null
}

function isSqlOperator(where: unknown, operator: string): boolean {
  if (!where || typeof where !== "object") return false
  const chunks = (where as Record<string, unknown>).queryChunks as unknown[]
  if (!Array.isArray(chunks)) return false

  return chunks.some((chunk) => {
    if (!chunk || typeof chunk !== "object") return false
    const value = (chunk as Record<string, unknown>).value
    return Array.isArray(value) && value.join("").includes(operator)
  })
}

function sqlTextIncludes(where: unknown, text: string): boolean {
  if (!where || typeof where !== "object") return false
  const chunks = (where as Record<string, unknown>).queryChunks as unknown[]
  if (!Array.isArray(chunks)) return false

  return chunks.some((chunk) => {
    if (!chunk || typeof chunk !== "object") return false
    const value = (chunk as Record<string, unknown>).value
    return Array.isArray(value) && value.join("").includes(text)
  })
}

function extractSingleParamValue(condition: unknown): unknown {
  if (!condition || typeof condition !== "object") return undefined
  const chunks = (condition as Record<string, unknown>).queryChunks as unknown[]
  if (!Array.isArray(chunks)) return undefined

  const values: unknown[] = []
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue
    if ("queryChunks" in chunk) {
      const nested = extractSingleParamValue(chunk)
      if (nested !== undefined) values.push(nested)
      continue
    }
    if (
      "value" in chunk &&
      !Array.isArray(chunk.value) &&
      !(typeof chunk.name === "string" && chunk.columnType)
    ) {
      values.push(chunk.value)
    }
  }

  return values.length === 1 ? values[0] : undefined
}

/**
 * Evaluate a drizzle sql template expression used in update().set().
 * Handles pattern: sql`${column} + ${number}` → row[column] + number
 */
function evaluateSetValue(row: Record<string, unknown>, _key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== "object") return value

  const chunks = (value as Record<string, unknown>).queryChunks as unknown[]
  if (!Array.isArray(chunks)) return value

  // Find column name and numeric operand
  let baseField: string | null = null
  let operator: string | null = null
  let operand: number | null = null

  for (const chunk of chunks) {
    if (!chunk) continue
    // Column with .name and .columnType
    if (typeof chunk.name === "string" && chunk.columnType) {
      baseField = snakeToCamel(chunk.name)
    }
    // StringChunk with operator
    if (Array.isArray(chunk.value)) {
      const str = chunk.value.join("")
      if (str.includes("+")) operator = "+"
      if (str.includes("-")) operator = "-"
    }
    // Raw number in chunks (sql template interpolates numbers directly)
    if (typeof chunk === "number") {
      operand = chunk
    }
    // Param wrapping a number
    if (typeof chunk === "object" && "encoder" in chunk && typeof chunk.value === "number") {
      operand = chunk.value
    }
  }

  if (baseField && operator === "+" && operand !== null) {
    return ((row[baseField] as number) ?? 0) + operand
  }
  if (baseField && operator === "-" && operand !== null) {
    return ((row[baseField] as number) ?? 0) - operand
  }

  return value
}

/**
 * Resolve a drizzle table object to our internal table name.
 * Drizzle stores the SQL table name under Symbol.for('drizzle:Name').
 */
function resolveTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown"
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL]
  if (name === "run_state") return "runState"
  if (name === "run_spend_buckets") return "runSpendBuckets"
  if (name === "run_capture_intents") return "runCaptureIntents"
  if (name === "run_idempotency") return "runIdempotency"
  return "unknown"
}

/**
 * Builds an in-memory fake drizzle database instance that supports the subset
 * of the drizzle API used by RunBudgetDO.
 */
function buildFakeDrizzle() {
  const tables: Record<string, Map<string, Record<string, unknown>>> = {
    runState: new Map(),
    runSpendBuckets: new Map(),
    runCaptureIntents: new Map(),
    runIdempotency: new Map(),
  }
  testState.runSpendBuckets = tables.runSpendBuckets!

  const pkField: Record<string, string> = {
    runState: "runId",
    runSpendBuckets: "bucketKey",
    runCaptureIntents: "intentKey",
    runIdempotency: "idempotencyKey",
  }

  function cloneTables() {
    const snapshot: Record<string, Map<string, Record<string, unknown>>> = {}
    for (const [name, store] of Object.entries(tables)) {
      snapshot[name] = new Map([...store.entries()].map(([key, row]) => [key, { ...row }]))
    }
    return snapshot
  }

  function restoreTables(snapshot: Record<string, Map<string, Record<string, unknown>>>) {
    for (const [name, store] of Object.entries(snapshot)) {
      const table = tables[name]!
      table.clear()
      for (const [key, row] of store.entries()) {
        table.set(key, { ...row })
      }
    }
  }

  function assertInsertAllowed(tableName: string) {
    if (tableName === "runIdempotency" && testState.failRunIdempotencyInsert) {
      throw new Error("run idempotency insert failed")
    }
  }

  /**
   * Filter rows for findMany. For sql template conditions we apply
   * table-specific heuristic logic.
   */
  function filterRows(
    tableName: string,
    rows: Record<string, unknown>[],
    where: unknown
  ): Record<string, unknown>[] {
    if (!where) return rows

    // Try simple eq extraction
    const eqInfo = extractEqInfo(where)
    if (eqInfo) {
      return rows.filter((r) => r[eqInfo.field] === eqInfo.value)
    }

    // For sql template conditions, apply table-specific logic
    switch (tableName) {
      case "runSpendBuckets":
        // consumed_amount > flushed_amount
        return rows.filter(
          (r) => ((r.consumedAmount as number) ?? 0) > ((r.flushedAmount as number) ?? 0)
        )
      case "runCaptureIntents":
        // status IN ('pending', 'failed'), optionally scoped to retryable attempts.
        return rows.filter((r) => {
          const status = r.status as string
          const attemptCount = typeof r.attemptCount === "number" ? r.attemptCount : 0
          const retryableOnly =
            sqlTextIncludes(where, "attempt_count") && sqlTextIncludes(where, "<")
          return (
            (status === "pending" || status === "failed") && (!retryableOnly || attemptCount < 5)
          )
        })
      case "runState":
        if (isSqlOperator(where, ">")) {
          return rows.filter(
            (r) =>
              (r.status as string) === "running" &&
              r.expiresAt != null &&
              (r.expiresAt as number) > Date.now()
          )
        }

        // status = 'running' AND expires_at IS NOT NULL AND expires_at <= now
        return rows.filter(
          (r) =>
            (r.status as string) === "running" &&
            r.expiresAt != null &&
            (r.expiresAt as number) <= Date.now()
        )
      default:
        return rows
    }
  }

  function buildQueryTable(tableName: string) {
    const store = tables[tableName]!
    return {
      findFirst: async (opts?: { where?: unknown }) => {
        const rows = Array.from(store.values())
        if (!opts?.where) return rows[0] ?? undefined
        const eqInfo = extractEqInfo(opts.where)
        if (eqInfo) {
          return rows.find((r) => r[eqInfo.field] === eqInfo.value)
        }
        const filtered = filterRows(tableName, rows, opts.where)
        return filtered[0] ?? undefined
      },
      findMany: async (opts?: { where?: unknown }) => {
        const rows = Array.from(store.values())
        return filterRows(tableName, rows, opts?.where)
      },
    }
  }

  function buildInsert(table: unknown) {
    const tableName = resolveTableName(table)
    const store = tables[tableName]!
    const pk = pkField[tableName]!

    return {
      values: (data: Record<string, unknown>) => {
        let storedData = data
        if (
          tableName === "runIdempotency" &&
          testState.omitTerminalEndedAtFromIdempotency &&
          typeof data.decisionJson === "string"
        ) {
          const decision = JSON.parse(data.decisionJson) as {
            budget?: {
              status: string
              endedAt?: number | null
              consumedAmount: number
              remainingAmount: number
            }
          }
          if (decision.budget) {
            delete decision.budget.endedAt
            decision.budget.status = "failed"
            decision.budget.consumedAmount = 12_345
            decision.budget.remainingAmount = 87_655
          }
          storedData = { ...data, decisionJson: JSON.stringify(decision) }
        }

        const key = storedData[pk] as string
        let handledByConflictClause = false

        const insertPromise = Promise.resolve().then(() => {
          if (!handledByConflictClause) {
            assertInsertAllowed(tableName)
            store.set(key, { ...storedData })
          }
        })

        // Attach conflict handlers that override the default insert.
        const chainable = Object.assign(insertPromise, {
          onConflictDoUpdate: (opts: { target: unknown; set: Record<string, unknown> }) => {
            handledByConflictClause = true
            assertInsertAllowed(tableName)
            const existing = store.get(key)
            if (existing) {
              for (const [field, val] of Object.entries(opts.set)) {
                existing[field] = evaluateSetValue(existing, field, val)
              }
            } else {
              store.set(key, { ...storedData })
            }
            return Promise.resolve()
          },
          onConflictDoNothing: () => {
            handledByConflictClause = true
            assertInsertAllowed(tableName)
            if (!store.has(key)) {
              store.set(key, { ...storedData })
            }
            return Promise.resolve()
          },
        })

        return chainable
      },
    }
  }

  function buildUpdate(table: unknown) {
    const tableName = resolveTableName(table)
    const store = tables[tableName]!

    return {
      set: (updates: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const eqInfo =
            extractEqInfo(condition) ??
            (() => {
              const value = extractSingleParamValue(condition)
              return value === undefined ? null : { field: pkField[tableName]!, value }
            })()
          if (!eqInfo) return Promise.resolve()

          for (const row of store.values()) {
            if (row[eqInfo.field] === eqInfo.value) {
              for (const [key, val] of Object.entries(updates)) {
                row[key] = evaluateSetValue(row, key, val)
              }
              break
            }
          }
          return Promise.resolve()
        },
      }),
    }
  }

  const db = {
    query: {
      runState: buildQueryTable("runState"),
      runSpendBuckets: buildQueryTable("runSpendBuckets"),
      runCaptureIntents: buildQueryTable("runCaptureIntents"),
      runIdempotency: buildQueryTable("runIdempotency"),
    },
    insert: (table: unknown) => buildInsert(table),
    update: (table: unknown) => buildUpdate(table),
    run: (_sql: unknown) => Promise.resolve(),
    transaction: async <T>(callback: (tx: unknown) => Promise<T> | T): Promise<T> => {
      const snapshot = cloneTables()
      try {
        return await callback(db)
      } catch (error) {
        restoreTables(snapshot)
        throw error
      }
    },
  }

  return db
}

let runBudgetDOPromise: Promise<RunBudgetDOConstructor> | null = null

async function loadRunBudgetDO() {
  if (runBudgetDOPromise) return runBudgetDOPromise

  vi.doMock("cloudflare:workers", () => ({
    DurableObject: class {
      protected readonly ctx: FakeDurableObjectState
      constructor(state: FakeDurableObjectState) {
        this.ctx = state
      }
    },
  }))

  vi.doMock("drizzle-orm/durable-sqlite", () => ({
    drizzle: (_storage: unknown, _opts: unknown) => buildFakeDrizzle(),
  }))

  vi.doMock("drizzle-orm/durable-sqlite/migrator", () => ({
    migrate: vi.fn(() => {}),
  }))

  vi.doMock("./drizzle/migrations", () => ({ default: {} }))

  vi.doMock("@unprice/db", () => ({
    and: vi.fn((...args: unknown[]) => args),
    createConnection: testState.createConnection,
    eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  }))

  vi.doMock("@unprice/db/schema", async (importOriginal) => {
    const actual = await importOriginal<typeof DbSchema>()
    return {
      ...actual,
      budgetRuns: actual.budgetRuns ?? {
        id: "budgetRuns.id",
        projectId: "budgetRuns.projectId",
      },
    }
  })

  vi.doMock("@unprice/services/ledger", () => ({
    LedgerGateway: class {},
  }))

  vi.doMock("@unprice/services/wallet", () => ({
    WalletService: class {
      public createReservation = testState.createReservation
      public captureReservationUsage = testState.captureReservationUsage
      public releaseReservation = testState.releaseReservation

      constructor() {
        testState.walletServiceConstructions += 1
      }
    },
  }))

  vi.doMock("~/observability", () => ({
    createDoLogger: vi.fn(() => testState.logger),
  }))

  runBudgetDOPromise = import("./RunBudgetDO").then(
    (module) => (module as { RunBudgetDO: RunBudgetDOConstructor }).RunBudgetDO
  )

  return runBudgetDOPromise
}

function createDurableObjectState(): FakeDurableObjectState {
  let gate = Promise.resolve()

  const state: FakeDurableObjectState = {
    alarmAt: null,
    deletedAlarm: false,
    id: { toString: () => "do_run_budget_123" },
    blockConcurrencyWhile: async <T>(cb: () => Promise<T> | T) => {
      const previous = gate
      let releaseGate: () => void = () => undefined
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })

      await previous

      try {
        return await cb()
      } finally {
        releaseGate()
      }
    },
    storage: {
      deleteAlarm: async () => {
        state.deletedAlarm = true
        state.alarmAt = null
      },
      getAlarm: async () => state.alarmAt,
      setAlarm: async (ts: number) => {
        state.alarmAt = ts
      },
    },
  }
  return state
}

function createEnv() {
  return {
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/unprice",
    DATABASE_READ1_URL: "postgres://user:pass@localhost:5432/unprice",
    DATABASE_READ2_URL: "postgres://user:pass@localhost:5432/unprice",
    entitlementwindow: {
      idFromName: vi.fn((_name: string) => ({ toString: () => "ew_id_123" })),
      get: (_id: unknown) => ({
        apply: testState.entitlementWindowApply,
      }),
    },
  }
}
