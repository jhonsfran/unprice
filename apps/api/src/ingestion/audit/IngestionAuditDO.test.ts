import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const BASE_NOW = Date.UTC(2026, 2, 19, 12, 0, 0)
const SQL_BOUND_PARAMETER_LIMIT = 100
const TEST_INGESTION_MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TEST_DO_IDEMPOTENCY_TTL_MS = TEST_INGESTION_MAX_EVENT_AGE_MS + 7 * 24 * 60 * 60 * 1000
const TEST_AUDIT_RETENTION_MS = TEST_DO_IDEMPOTENCY_TTL_MS

type DrizzleCondition = {
  kind: "and" | "eq" | "inArray" | "isNull" | "lt"
  column?: string
  value?: unknown
  values?: unknown[]
  conditions?: DrizzleCondition[]
}

type FakeAuditBatchRow = {
  id: number
  first_seen_at: number
  created_at: number
  entries_json: string
  published_at: number | null
}

type FakeDbState = {
  batchRows: FakeAuditBatchRow[]
  publishUpdateBatchSizes: number[]
}

type FakeDurableObjectState = {
  alarmAt: number | null
  blockConcurrencyWhile: <T>(callback: () => Promise<T> | T) => Promise<T>
  id: { toString: () => string }
  storage: {
    getAlarm: () => Promise<number | null>
    setAlarm: (timestamp: number) => Promise<void>
    sql: {
      exec: (query: string, ...params: unknown[]) => { toArray: <T>() => T[] }
    }
  }
}

const testState = {
  db: null as FakeDbState | null,
  logger: {
    debug: vi.fn(),
    emit: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    info: vi.fn(),
    set: vi.fn(),
    warn: vi.fn(),
  },
  migrate: vi.fn(),
}

describe("IngestionAuditDO", () => {
  beforeEach(() => {
    for (const fn of Object.values(testState.logger)) fn.mockReset()
    testState.migrate.mockReset()
    vi.spyOn(Date, "now").mockReturnValue(BASE_NOW)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
    testState.db = null
  })

  it("runs drizzle migrations during initialization", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    testState.db = createFakeDbState()

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: { send: vi.fn() },
      } as never
    )

    await durableObject.commit([])

    expect(testState.migrate).toHaveBeenCalledTimes(1)
  })

  it("inserts a fresh row and schedules alarm", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: { send: vi.fn() },
      } as never
    )

    const result = await durableObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_1",
        payloadHash: "hash_1",
      }),
    ])

    expect(result).toEqual({
      inserted: 1,
      duplicates: 0,
      conflicts: 0,
    })
    expect(db.batchRows).toHaveLength(1)
    expect(JSON.parse(db.batchRows[0]!.entries_json)).toHaveLength(1)
    expect(state.alarmAt).toBe(BASE_NOW + 1000)
  })

  it("counts duplicate and conflicting rows without inserting twice", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: { send: vi.fn() },
      } as never
    )

    const result = await durableObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_shared",
        payloadHash: "hash_a",
      }),
      createLedgerEntry({
        idempotencyKey: "idem_shared",
        payloadHash: "hash_a",
      }),
      createLedgerEntry({
        idempotencyKey: "idem_shared",
        payloadHash: "hash_b",
      }),
    ])

    expect(result).toEqual({
      inserted: 1,
      duplicates: 1,
      conflicts: 1,
    })
    expect(db.batchRows).toHaveLength(1)
    expect(JSON.parse(db.batchRows[0]!.entries_json)).toHaveLength(1)
  })

  it("commits large fresh batches within Durable Object SQL parameter limits", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: { send: vi.fn() },
      } as never
    )

    const entries = createLedgerEntries(125)
    const result = await durableObject.commit(entries)

    expect(result).toEqual({
      inserted: 125,
      duplicates: 0,
      conflicts: 0,
    })
    expect(db.batchRows).toHaveLength(1)
    expect(JSON.parse(db.batchRows[0]!.entries_json)).toHaveLength(125)
    expect(state.alarmAt).toBe(BASE_NOW + 1000)
  })

  it("classifies a concurrent commit for the same idempotency key as a duplicate", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    const getAlarmStarted = createDeferred<void>()
    const getAlarmResult = createDeferred<number | null>()
    state.storage.getAlarm = async () => {
      getAlarmStarted.resolve()
      return await getAlarmResult.promise
    }

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: { send: vi.fn() },
      } as never
    )

    const entry = createLedgerEntry({
      idempotencyKey: "idem_concurrent",
      payloadHash: "hash_concurrent",
    })
    const first = durableObject.commit([entry])

    await getAlarmStarted.promise
    const second = durableObject.commit([entry])
    getAlarmResult.resolve(null)

    await expect(Promise.all([first, second])).resolves.toEqual([
      { inserted: 1, duplicates: 0, conflicts: 0 },
      { inserted: 0, duplicates: 1, conflicts: 0 },
    ])
    expect(db.batchRows).toHaveLength(1)
    expect(state.alarmAt).toBe(BASE_NOW + 1000)
  })

  it("recovers compact audit dedupe after Durable Object eviction", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const db = createFakeDbState()
    testState.db = db

    const firstObject = new IngestionAuditDO(
      createDurableObjectState() as never,
      {
        PIPELINE_EVENTS: { send: vi.fn() },
      } as never
    )
    const entry = createLedgerEntry({
      idempotencyKey: "idem_recovered",
      payloadHash: "hash_recovered",
    })

    await firstObject.commit([entry])

    const recoveredObject = new IngestionAuditDO(
      createDurableObjectState() as never,
      {
        PIPELINE_EVENTS: { send: vi.fn() },
      } as never
    )
    const replay = await recoveredObject.commit([entry])

    expect(replay).toEqual({ inserted: 0, duplicates: 1, conflicts: 0 })
    expect(db.batchRows).toHaveLength(1)

    const conflict = await recoveredObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_recovered",
        payloadHash: "hash_conflict",
      }),
    ])

    expect(conflict).toEqual({ inserted: 0, duplicates: 0, conflicts: 1 })
    expect(db.batchRows).toHaveLength(1)
  })

  it("hydrates valid compact audit dedupe while poison rows remain retryable", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const validEntry = createLedgerEntry({
      idempotencyKey: "idem_valid_after_poison",
      payloadHash: "hash_valid_after_poison",
    })
    const pipelineEvents = {
      send: vi.fn().mockResolvedValue(undefined),
    }
    testState.db = db
    db.batchRows.push({
      id: 1,
      first_seen_at: BASE_NOW - 1,
      created_at: BASE_NOW - 1,
      entries_json: "{not valid json",
      published_at: null,
    })
    db.batchRows.push({
      id: 2,
      first_seen_at: BASE_NOW,
      created_at: BASE_NOW,
      entries_json: JSON.stringify([validEntry]),
      published_at: null,
    })

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: pipelineEvents,
      } as never
    )

    const duplicate = await durableObject.commit([validEntry])
    await durableObject.alarm()

    expect(duplicate).toEqual({ inserted: 0, duplicates: 1, conflicts: 0 })
    expect(pipelineEvents.send).not.toHaveBeenCalled()
    expect(db.batchRows.map((row) => row.published_at)).toEqual([null, null])
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
    expect(testState.logger.warn).toHaveBeenCalledWith(
      "failed to parse ingestion audit batch entries",
      expect.objectContaining({
        error: expect.any(String),
      })
    )
  })

  it("publishes large outbox batches within Durable Object SQL parameter limits", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const pipelineEvents = {
      send: vi.fn().mockResolvedValue(undefined),
    }
    testState.db = db

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: pipelineEvents,
      } as never
    )

    await durableObject.commit(createLedgerEntries(125))
    await durableObject.alarm()

    expect(pipelineEvents.send).toHaveBeenCalledTimes(1)
    expect(pipelineEvents.send.mock.calls[0]?.[0]).toHaveLength(125)
    expect(db.batchRows.every((row) => row.published_at === BASE_NOW)).toBe(true)
  })

  it("updates published audit markers in chunks by compact batch row count", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const pipelineEvents = {
      send: vi.fn().mockResolvedValue(undefined),
    }
    testState.db = db

    for (const [index, entry] of createLedgerEntries(125).entries()) {
      db.batchRows.push({
        id: index + 1,
        first_seen_at: BASE_NOW + index,
        created_at: BASE_NOW + index,
        entries_json: JSON.stringify([entry]),
        published_at: null,
      })
    }

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: pipelineEvents,
      } as never
    )

    await durableObject.alarm()

    expect(pipelineEvents.send).toHaveBeenCalledTimes(1)
    expect(pipelineEvents.send.mock.calls[0]?.[0]).toHaveLength(125)
    expect(db.batchRows.every((row) => row.published_at === BASE_NOW)).toBe(true)
    expect(db.publishUpdateBatchSizes).toEqual([99, 26])
  })

  it("marks unpublished rows as published after successful pipeline flush", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const pipelineEvents = {
      send: vi.fn().mockResolvedValue(undefined),
    }
    testState.db = db

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: pipelineEvents,
      } as never
    )

    await durableObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_publish",
        payloadHash: "hash_publish",
      }),
    ])

    await durableObject.alarm()

    expect(pipelineEvents.send).toHaveBeenCalledTimes(1)
    expect(db.batchRows[0]?.published_at).toBe(BASE_NOW)
  })

  it("publishes to the local pipeline URL in development", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const pipelineEvents = {
      send: vi.fn().mockResolvedValue(undefined),
    }
    testState.db = db
    vi.stubGlobal("fetch", fetchMock)

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        APP_ENV: "development",
        LOCAL_PIPELINE_URL: "http://127.0.0.1:4195/ingest",
        PIPELINE_EVENTS: pipelineEvents,
      } as never
    )

    await durableObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_local",
        payloadHash: "hash_local",
      }),
    ])

    await durableObject.alarm()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4195/ingest",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      })
    )
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(JSON.parse(String(request?.body))).toEqual([{ idempotency_key: "idem_local" }])
    expect(pipelineEvents.send).not.toHaveBeenCalled()
    expect(db.batchRows[0]?.published_at).toBe(BASE_NOW)
  })

  it("keeps rows unpublished and retries alarm when pipeline send fails", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const pipelineEvents = {
      send: vi.fn().mockRejectedValue(new Error("pipeline down")),
    }
    testState.db = db

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: pipelineEvents,
      } as never
    )

    await durableObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_retry",
        payloadHash: "hash_retry",
      }),
    ])

    await durableObject.alarm()

    expect(db.batchRows[0]?.published_at).toBeNull()
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
  })

  it("keeps rows unpublished and retries alarm when local pipeline send fails", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    testState.db = db
    vi.stubGlobal("fetch", fetchMock)

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        APP_ENV: "development",
        LOCAL_PIPELINE_URL: "http://127.0.0.1:4195/ingest",
        PIPELINE_EVENTS: {
          send: vi.fn().mockResolvedValue(undefined),
        },
      } as never
    )

    await durableObject.commit([
      createLedgerEntry({
        idempotencyKey: "idem_local_retry",
        payloadHash: "hash_local_retry",
      }),
    ])

    await durableObject.alarm()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.batchRows[0]?.published_at).toBeNull()
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
  })

  it("cleanup removes only old published batch rows", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    db.batchRows.push({
      id: 1,
      first_seen_at: BASE_NOW - TEST_AUDIT_RETENTION_MS - 1,
      created_at: BASE_NOW - TEST_AUDIT_RETENTION_MS - 1,
      entries_json: "[]",
      published_at: BASE_NOW - 1,
    })
    db.batchRows.push({
      id: 2,
      first_seen_at: BASE_NOW - TEST_AUDIT_RETENTION_MS - 1,
      created_at: BASE_NOW - TEST_AUDIT_RETENTION_MS - 1,
      entries_json: "[]",
      published_at: null,
    })
    db.batchRows.push({
      id: 3,
      first_seen_at: BASE_NOW - 1000,
      created_at: BASE_NOW - 1000,
      entries_json: "[]",
      published_at: BASE_NOW - 1,
    })
    db.batchRows.push({
      id: 4,
      first_seen_at: BASE_NOW - TEST_INGESTION_MAX_EVENT_AGE_MS - 24 * 60 * 60 * 1000,
      created_at: BASE_NOW - TEST_INGESTION_MAX_EVENT_AGE_MS - 24 * 60 * 60 * 1000,
      entries_json: "[]",
      published_at: BASE_NOW - 1,
    })

    const durableObject = new IngestionAuditDO(
      state as never,
      {
        PIPELINE_EVENTS: {
          send: vi.fn().mockRejectedValue(new Error("pipeline down")),
        },
      } as never
    )

    await durableObject.alarm()

    expect(db.batchRows.map((row) => row.id)).toEqual([2, 3, 4])
  })
})

async function loadIngestionAuditDO() {
  vi.doMock("cloudflare:workers", () => ({
    DurableObject: class {
      protected readonly ctx: FakeDurableObjectState

      constructor(state: FakeDurableObjectState) {
        this.ctx = state
      }
    },
  }))

  vi.doMock("@unprice/lakehouse", () => ({
    parseLakehouseEvent: vi.fn((_source: string, payload: unknown) => payload),
  }))

  vi.doMock("@unprice/observability", () => ({}))

  vi.doMock("~/observability", () => ({
    createDoLogger: vi.fn(() => testState.logger),
    runDoOperation: vi.fn(
      async <T>(_params: unknown, fn: (logger: typeof testState.logger) => Promise<T>) =>
        fn(testState.logger)
    ),
  }))

  vi.doMock("drizzle-orm/durable-sqlite", () => ({
    drizzle: vi.fn(() => {
      if (!testState.db) {
        throw new Error("Missing fake drizzle db for IngestionAuditDO test")
      }
      return buildFakeDrizzle(testState.db)
    }),
  }))

  vi.doMock("drizzle-orm/durable-sqlite/migrator", () => ({
    migrate: testState.migrate,
  }))

  vi.doMock("./drizzle/migrations", () => ({
    default: [],
  }))

  vi.doMock("drizzle-orm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("drizzle-orm")>()
    return {
      ...actual,
      and: (...conditions: DrizzleCondition[]): DrizzleCondition => ({ kind: "and", conditions }),
      asc: (column: unknown) => ({ kind: "asc", value: column }),
      eq: (column: unknown, value: unknown): DrizzleCondition => ({
        kind: "eq",
        column: getColumnName(column),
        value,
      }),
      inArray: (column: unknown, values: unknown[]): DrizzleCondition => {
        assertSqlBoundParameterCount(values.length)
        return {
          kind: "inArray",
          column: getColumnName(column),
          values,
        }
      },
      isNull: (column: unknown): DrizzleCondition => ({
        kind: "isNull",
        column: getColumnName(column),
      }),
      lt: (column: unknown, value: unknown): DrizzleCondition => ({
        kind: "lt",
        column: getColumnName(column),
        value,
      }),
      sql: () => ({ kind: "sql" }),
    }
  })

  const module = (await import("./IngestionAuditDO")) as {
    IngestionAuditDO: new (
      state: FakeDurableObjectState,
      env: unknown
    ) => {
      alarm: () => Promise<void>
      commit: (entries: ReturnType<typeof createLedgerEntry>[]) => Promise<{
        conflicts: number
        duplicates: number
        inserted: number
      }>
    }
  }

  return module.IngestionAuditDO
}

function createDurableObjectState(): FakeDurableObjectState {
  const state: FakeDurableObjectState = {
    alarmAt: null,
    id: { toString: () => "do_audit_123" },
    blockConcurrencyWhile: async (callback) => await callback(),
    storage: {
      getAlarm: async () => state.alarmAt,
      setAlarm: async (timestamp) => {
        state.alarmAt = timestamp
      },
      sql: {
        exec: (query: string, ...params: unknown[]) => execSqlCleanup(testState.db, query, params),
      },
    },
  }

  return state
}

function createFakeDbState(): FakeDbState {
  return {
    batchRows: [],
    publishUpdateBatchSizes: [],
  }
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

function getColumnName(column: unknown): string {
  if (column && typeof column === "object" && "name" in column) {
    const value = (column as { name?: unknown }).name
    if (typeof value === "string") {
      return value
    }
  }
  return ""
}

function buildFakeDrizzle(state: FakeDbState) {
  let nextBatchId = 1

  const db = {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields)
      let condition: DrizzleCondition | undefined
      let limitCount: number | undefined

      return {
        from() {
          return this
        },
        where(cond: DrizzleCondition) {
          condition = cond
          return this
        },
        orderBy() {
          return this
        },
        limit(count: number) {
          limitCount = count
          return this
        },
        get() {
          if (keys.length === 1 && keys.includes("id")) {
            const row = [...state.batchRows]
              .filter((candidate) => matchesBatchCondition(candidate, condition))
              .sort((a, b) => a.first_seen_at - b.first_seen_at)
              .at(0)
            if (!row) {
              return undefined
            }
            return { id: row.id }
          }

          throw new Error(`Unsupported select().get() keys: ${keys.join(",")}`)
        },
        all() {
          if (keys.includes("entriesJson")) {
            return [...state.batchRows]
              .filter((candidate) => matchesBatchCondition(candidate, condition))
              .sort((a, b) => a.first_seen_at - b.first_seen_at)
              .slice(0, limitCount)
              .map((row) => ({
                id: row.id,
                entriesJson: row.entries_json,
              }))
          }

          throw new Error(`Unsupported select().all() keys: ${keys.join(",")}`)
        },
      }
    },

    insert() {
      let rows: Record<string, unknown>[] = []

      const runInsert = () => {
        for (const row of rows) {
          if ("entriesJson" in row) {
            state.batchRows.push({
              id: nextBatchId++,
              first_seen_at: Number(row.firstSeenAt),
              created_at: Number(row.createdAt),
              entries_json: String(row.entriesJson),
              published_at:
                row.publishedAt === null || row.publishedAt === undefined
                  ? null
                  : Number(row.publishedAt),
            })
          }
        }
      }

      return {
        values(value: Record<string, unknown> | Record<string, unknown>[]) {
          rows = Array.isArray(value) ? value : [value]
          assertSqlBoundParameterCount(rows.length * 4)
          return this
        },
        onConflictDoNothing() {
          return {
            run: runInsert,
          }
        },
        run: runInsert,
      }
    },

    update() {
      let values: Record<string, unknown> = {}

      return {
        set(nextValues: Record<string, unknown>) {
          values = nextValues
          return this
        },
        where(condition: DrizzleCondition) {
          return {
            run() {
              assertSqlBoundParameterCount(
                Object.keys(values).length + countConditionBoundParameters(condition)
              )
              if (condition.column === "id") {
                if (condition.kind === "inArray") {
                  state.publishUpdateBatchSizes.push(condition.values?.length ?? 0)
                }
                for (const row of state.batchRows) {
                  if (!matchesBatchCondition(row, condition)) {
                    continue
                  }

                  if ("publishedAt" in values) {
                    const publishedAt = values.publishedAt
                    row.published_at =
                      publishedAt === null || publishedAt === undefined ? null : Number(publishedAt)
                  }
                }
                return
              }
            },
          }
        },
      }
    },
  }

  return db
}

function matchesBatchCondition(
  row: FakeAuditBatchRow,
  condition: DrizzleCondition | undefined
): boolean {
  if (!condition) {
    return true
  }

  if (condition.kind === "and") {
    return (condition.conditions ?? []).every((candidate) => matchesBatchCondition(row, candidate))
  }

  const value = getBatchRowValue(row, condition.column)

  if (condition.kind === "eq") {
    return value === condition.value
  }

  if (condition.kind === "inArray") {
    return (condition.values ?? []).includes(value)
  }

  if (condition.kind === "isNull") {
    return value === null
  }

  if (condition.kind === "lt") {
    return Number(value) < Number(condition.value)
  }

  return false
}

function countConditionBoundParameters(condition: DrizzleCondition | undefined): number {
  if (!condition) {
    return 0
  }

  if (condition.kind === "and") {
    return (condition.conditions ?? []).reduce(
      (total, nested) => total + countConditionBoundParameters(nested),
      0
    )
  }

  if (condition.kind === "inArray") {
    return condition.values?.length ?? 0
  }

  if (condition.kind === "eq" || condition.kind === "lt") {
    return 1
  }

  return 0
}

function assertSqlBoundParameterCount(count: number): void {
  if (count > SQL_BOUND_PARAMETER_LIMIT) {
    throw new Error(`too many SQL variables: ${count}`)
  }
}

function getBatchRowValue(row: FakeAuditBatchRow, column: string | undefined): unknown {
  if (!column) {
    return undefined
  }
  return row[column as keyof FakeAuditBatchRow]
}

function execSqlCleanup(
  db: FakeDbState | null,
  query: string,
  params: unknown[]
): { toArray: <T>() => T[] } {
  if (!db) {
    throw new Error("Missing fake drizzle db for cleanup")
  }

  const normalizedQuery = query.replace(/\s+/g, " ").trim()
  if (!normalizedQuery.startsWith("DELETE FROM ingestion_audit_batches")) {
    throw new Error(`Unsupported SQL in test: ${normalizedQuery}`)
  }

  const cutoff = Number(params[0] ?? 0)
  const limit = Number(params[1] ?? 0)
  let deleted = 0

  const remaining: FakeAuditBatchRow[] = []
  for (const row of db.batchRows) {
    if (deleted < limit && row.published_at !== null && row.first_seen_at < cutoff) {
      deleted++
      continue
    }
    remaining.push(row)
  }
  db.batchRows.splice(0, db.batchRows.length, ...remaining)

  return {
    toArray() {
      return []
    },
  } as { toArray: <T>() => T[] }
}

function createLedgerEntry(overrides: {
  idempotencyKey: string
  payloadHash: string
}) {
  return {
    auditPayloadJson: JSON.stringify({
      idempotency_key: overrides.idempotencyKey,
    }),
    canonicalAuditId: `canonical_${overrides.idempotencyKey}`,
    firstSeenAt: BASE_NOW,
    idempotencyKey: overrides.idempotencyKey,
    payloadHash: overrides.payloadHash,
    rejectionReason: undefined,
    resultJson: JSON.stringify({ state: "processed" }),
    status: "processed" as const,
  }
}

function createLedgerEntries(count: number) {
  return Array.from({ length: count }, (_, index) =>
    createLedgerEntry({
      idempotencyKey: `idem_large_${index.toString().padStart(3, "0")}`,
      payloadHash: `hash_large_${index.toString().padStart(3, "0")}`,
    })
  )
}
