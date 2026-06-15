import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const BASE_NOW = Date.UTC(2026, 2, 19, 12, 0, 0)

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

const testState = {
  createReservation: vi.fn(),
  captureReservationUsage: vi.fn(),
  releaseReservation: vi.fn(),
  entitlementWindowApply: vi.fn(),
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
  beforeEach(() => {
    for (const fn of Object.values(testState.logger)) fn.mockReset()
    testState.createReservation.mockReset()
    testState.captureReservationUsage.mockReset()
    testState.releaseReservation.mockReset()
    testState.entitlementWindowApply.mockReset()

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
      meterFacts: [
        {
          amount: 5000,
          customer_entitlement_id: "ce_1",
          statement_key: "stmt_1",
          period_key: "period_1",
          feature_id: "feat_1",
          period_start_at: BASE_NOW - 60_000,
          period_end_at: BASE_NOW + 60_000,
          currency: "USD",
        },
      ],
    })

    vi.spyOn(Date, "now").mockReturnValue(BASE_NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("startRun creates a wallet reservation and persists run state", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    const result = await durable.startRun({
      agentId: "agent_1",
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
  })

  it("startRun is idempotent - returns existing run state", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    const input = {
      agentId: "agent_1",
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
  })

  it("applySyncEvent returns cached decision for duplicate idempotency keys", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      agentId: "agent_1",
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
      agentId: "agent_1",
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
    }

    const first = await durable.applySyncEvent(eventInput)
    const second = await durable.applySyncEvent(eventInput)

    expect(first).toEqual(second)
    expect(first.allowed).toBe(true)
    // EntitlementWindowDO only called once
    expect(testState.entitlementWindowApply).toHaveBeenCalledTimes(1)
  })

  it("applySyncEvent denies when run is not in running status", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      agentId: "agent_1",
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
      agentId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: BASE_NOW + 1000,
    })

    const result = await durable.applySyncEvent({
      agentId: "agent_1",
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
    })

    expect(result.allowed).toBe(false)
    expect(result.state).toBe("rejected")
    expect(result.rejectionReason).toBe("RUN_BUDGET_EXCEEDED")
    expect(result.message).toContain("completed")
    expect(testState.entitlementWindowApply).not.toHaveBeenCalled()
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
      agentId: "agent_1",
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
      agentId: "agent_1",
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
    })

    expect(result.allowed).toBe(false)
    expect(result.rejectionReason).toBe("LIMIT_EXCEEDED")
    expect(result.message).toBe("Usage limit exceeded")
  })

  it("applySyncEvent updates consumed amount and schedules alarm", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      agentId: "agent_1",
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
      agentId: "agent_1",
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
    })

    expect(result.allowed).toBe(true)
    expect(result.budget.consumedAmount).toBe(5000)
    expect(result.budget.remainingAmount).toBe(95_000)
    // Alarm scheduled since consumedAmount > flushedAmount
    expect(state.alarmAt).toBe(BASE_NOW + 10_000)
  })

  it("endRun calls flush and release, then updates status", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      agentId: "agent_1",
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
      agentId: "agent_1",
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
    })

    const result = await durable.endRun({
      agentId: "agent_1",
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: BASE_NOW + 5000,
    })

    expect(result.status).toBe("completed")
    expect(result.consumedAmount).toBe(5000)
    // Capture was called during flush
    expect(testState.captureReservationUsage).toHaveBeenCalled()
    // Release was called
    expect(testState.releaseReservation).toHaveBeenCalled()
  })

  it("getRunStatus returns the current summary", async () => {
    const RunBudgetDO = await loadRunBudgetDO()
    const state = createDurableObjectState()
    const env = createEnv()
    const durable = new RunBudgetDO(state, env)

    await durable.startRun({
      agentId: "agent_1",
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
      agentId: "agent_1",
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
        agentId: "agent_1",
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
  let columnName: string | null = null
  let paramValue: unknown = undefined
  let foundEquals = false

  for (const chunk of chunks) {
    if (!chunk) continue
    // Column: has `.name` that is a string and `.columnType` property
    if (typeof chunk.name === "string" && chunk.columnType) {
      columnName = chunk.name
    }
    // StringChunk: check for ' = ' operator
    if (Array.isArray(chunk.value) && chunk.value.includes(" = ")) {
      foundEquals = true
    }
    // Param: has `.value` and `.encoder` properties
    if ("encoder" in chunk && "value" in chunk) {
      paramValue = chunk.value
    }
  }

  if (columnName && foundEquals && paramValue !== undefined) {
    return { field: snakeToCamel(columnName), value: paramValue }
  }
  return null
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
    if ("encoder" in chunk && typeof chunk.value === "number") {
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

  const pkField: Record<string, string> = {
    runState: "runId",
    runSpendBuckets: "bucketKey",
    runCaptureIntents: "intentKey",
    runIdempotency: "idempotencyKey",
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
        // status IN ('pending', 'failed') AND attempt_count < 5
        return rows.filter(
          (r) =>
            ((r.status as string) === "pending" || (r.status as string) === "failed") &&
            ((r.attemptCount as number) ?? 0) < 5
        )
      case "runState":
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
        const key = data[pk] as string

        // Create a Promise that inserts the data (fulfills the await)
        const insertPromise = Promise.resolve().then(() => {
          store.set(key, { ...data })
        })

        // Attach conflict handlers that override the default insert
        const chainable = Object.assign(insertPromise, {
          onConflictDoUpdate: (opts: { target: unknown; set: Record<string, unknown> }) => {
            const existing = store.get(key)
            if (existing) {
              for (const [field, val] of Object.entries(opts.set)) {
                existing[field] = evaluateSetValue(existing, field, val)
              }
            } else {
              store.set(key, { ...data })
            }
            return Promise.resolve()
          },
          onConflictDoNothing: () => {
            if (!store.has(key)) {
              store.set(key, { ...data })
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
          const eqInfo = extractEqInfo(condition)
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

  return {
    query: {
      runState: buildQueryTable("runState"),
      runSpendBuckets: buildQueryTable("runSpendBuckets"),
      runCaptureIntents: buildQueryTable("runCaptureIntents"),
      runIdempotency: buildQueryTable("runIdempotency"),
    },
    insert: (table: unknown) => buildInsert(table),
    update: (table: unknown) => buildUpdate(table),
    run: (_sql: unknown) => Promise.resolve(),
  }
}

async function loadRunBudgetDO() {
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
    createConnection: vi.fn(() => ({})),
  }))

  vi.doMock("@unprice/services/ledger", () => ({
    LedgerGateway: class {},
  }))

  vi.doMock("@unprice/services/wallet", () => ({
    WalletService: class {
      public createReservation = testState.createReservation
      public captureReservationUsage = testState.captureReservationUsage
      public releaseReservation = testState.releaseReservation
    },
  }))

  vi.doMock("~/observability", () => ({
    createDoLogger: vi.fn(() => testState.logger),
  }))

  const module = (await import("./RunBudgetDO")) as {
    RunBudgetDO: new (
      state: FakeDurableObjectState,
      env: unknown
    ) => {
      startRun: (input: unknown) => Promise<unknown>
      applySyncEvent: (input: unknown) => Promise<unknown>
      endRun: (input: unknown) => Promise<unknown>
      getRunStatus: (input: unknown) => Promise<unknown>
      flushCaptures: () => Promise<void>
      alarm: () => Promise<void>
    }
  }

  return module.RunBudgetDO
}

function createDurableObjectState(): FakeDurableObjectState {
  const state: FakeDurableObjectState = {
    alarmAt: null,
    deletedAlarm: false,
    id: { toString: () => "do_run_budget_123" },
    blockConcurrencyWhile: async <T>(cb: () => Promise<T> | T) => await cb(),
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
      idFromName: (_name: string) => ({ toString: () => "ew_id_123" }),
      get: (_id: unknown) => ({
        apply: testState.entitlementWindowApply,
      }),
    },
  }
}
