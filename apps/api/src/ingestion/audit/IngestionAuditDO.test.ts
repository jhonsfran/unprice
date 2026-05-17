import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const BASE_NOW = Date.UTC(2026, 2, 19, 12, 0, 0)
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

type FakeAuditRow = {
  audit_payload_json: string
  canonical_audit_id: string
  first_seen_at: number
  idempotency_key: string
  payload_hash: string
  published_at: number | null
  rejection_reason: string | null
  result_json: string
  status: "processed" | "rejected"
}

type FakeDbState = {
  rows: Map<string, FakeAuditRow>
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
    expect(db.rows.size).toBe(1)
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
    expect(db.rows.size).toBe(1)
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
    expect(db.rows.size).toBe(1)
    expect(state.alarmAt).toBe(BASE_NOW + 1000)
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
    expect(db.rows.get("idem_publish")?.published_at).toBe(BASE_NOW)
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
    expect(db.rows.get("idem_local")?.published_at).toBe(BASE_NOW)
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

    expect(db.rows.get("idem_retry")?.published_at).toBeNull()
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
    expect(db.rows.get("idem_local_retry")?.published_at).toBeNull()
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
  })

  it("cleanup removes only old published rows", async () => {
    const IngestionAuditDO = await loadIngestionAuditDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    db.rows.set("old_published", {
      idempotency_key: "old_published",
      canonical_audit_id: "canonical_old_published",
      payload_hash: "hash_old_published",
      status: "processed",
      rejection_reason: null,
      result_json: '{"state":"processed"}',
      audit_payload_json: '{"idempotency_key":"old_published"}',
      first_seen_at: BASE_NOW - TEST_AUDIT_RETENTION_MS - 1,
      published_at: BASE_NOW - 1,
    })
    db.rows.set("old_unpublished", {
      idempotency_key: "old_unpublished",
      canonical_audit_id: "canonical_old_unpublished",
      payload_hash: "hash_old_unpublished",
      status: "processed",
      rejection_reason: null,
      result_json: '{"state":"processed"}',
      audit_payload_json: '{"idempotency_key":"old_unpublished"}',
      first_seen_at: BASE_NOW - TEST_AUDIT_RETENTION_MS - 1,
      published_at: null,
    })
    db.rows.set("fresh_published", {
      idempotency_key: "fresh_published",
      canonical_audit_id: "canonical_fresh_published",
      payload_hash: "hash_fresh_published",
      status: "processed",
      rejection_reason: null,
      result_json: '{"state":"processed"}',
      audit_payload_json: '{"idempotency_key":"fresh_published"}',
      first_seen_at: BASE_NOW - 1000,
      published_at: BASE_NOW - 1,
    })
    db.rows.set("within_retention_margin", {
      idempotency_key: "within_retention_margin",
      canonical_audit_id: "canonical_within_retention_margin",
      payload_hash: "hash_within_retention_margin",
      status: "processed",
      rejection_reason: null,
      result_json: '{"state":"processed"}',
      audit_payload_json: '{"idempotency_key":"within_retention_margin"}',
      first_seen_at: BASE_NOW - TEST_INGESTION_MAX_EVENT_AGE_MS - 24 * 60 * 60 * 1000,
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

    expect(db.rows.has("old_published")).toBe(false)
    expect(db.rows.has("old_unpublished")).toBe(true)
    expect(db.rows.has("fresh_published")).toBe(true)
    expect(db.rows.has("within_retention_margin")).toBe(true)
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
      inArray: (column: unknown, values: unknown[]): DrizzleCondition => ({
        kind: "inArray",
        column: getColumnName(column),
        values,
      }),
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
    rows: new Map(),
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
          if (keys.includes("payloadHash")) {
            const row = [...state.rows.values()].find((candidate) =>
              matchesCondition(candidate, condition)
            )
            if (!row) {
              return undefined
            }
            return { payloadHash: row.payload_hash }
          }

          if (keys.includes("cnt")) {
            const cnt = [...state.rows.values()].filter((candidate) =>
              matchesCondition(candidate, condition)
            ).length
            return { cnt }
          }

          if (keys.length === 1 && keys.includes("idempotencyKey")) {
            const row = [...state.rows.values()]
              .filter((candidate) => matchesCondition(candidate, condition))
              .sort((a, b) => a.first_seen_at - b.first_seen_at)
              .at(0)
            if (!row) {
              return undefined
            }
            return { idempotencyKey: row.idempotency_key }
          }

          throw new Error(`Unsupported select().get() keys: ${keys.join(",")}`)
        },
        all() {
          if (keys.includes("idempotencyKey") && keys.includes("payloadHash")) {
            return [...state.rows.values()]
              .filter((candidate) => matchesCondition(candidate, condition))
              .map((row) => ({
                idempotencyKey: row.idempotency_key,
                payloadHash: row.payload_hash,
              }))
          }

          if (keys.length === 1 && keys.includes("idempotencyKey")) {
            return [...state.rows.values()]
              .filter((candidate) => matchesCondition(candidate, condition))
              .map((row) => ({
                idempotencyKey: row.idempotency_key,
              }))
          }

          if (
            keys.includes("idempotencyKey") &&
            keys.includes("canonicalAuditId") &&
            keys.includes("auditPayloadJson") &&
            keys.includes("firstSeenAt")
          ) {
            const rows = [...state.rows.values()]
              .filter((candidate) => matchesCondition(candidate, condition))
              .sort((a, b) => a.first_seen_at - b.first_seen_at)
              .slice(0, limitCount)
              .map((row) => ({
                idempotencyKey: row.idempotency_key,
                canonicalAuditId: row.canonical_audit_id,
                auditPayloadJson: row.audit_payload_json,
                firstSeenAt: row.first_seen_at,
              }))

            return rows
          }

          throw new Error(`Unsupported select().all() keys: ${keys.join(",")}`)
        },
      }
    },

    insert() {
      let rows: Record<string, unknown>[] = []

      const runInsert = () => {
        for (const row of rows) {
          const idempotencyKey = String(row.idempotencyKey)
          if (state.rows.has(idempotencyKey)) {
            continue
          }

          state.rows.set(idempotencyKey, {
            idempotency_key: idempotencyKey,
            canonical_audit_id: String(row.canonicalAuditId),
            payload_hash: String(row.payloadHash),
            status: row.status as "processed" | "rejected",
            rejection_reason:
              row.rejectionReason === null || row.rejectionReason === undefined
                ? null
                : String(row.rejectionReason),
            result_json:
              row.resultJson === null || row.resultJson === undefined ? "" : String(row.resultJson),
            audit_payload_json: String(row.auditPayloadJson),
            first_seen_at: Number(row.firstSeenAt),
            published_at:
              row.publishedAt === null || row.publishedAt === undefined
                ? null
                : Number(row.publishedAt),
          })
        }
      }

      return {
        values(value: Record<string, unknown> | Record<string, unknown>[]) {
          rows = Array.isArray(value) ? value : [value]
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
              for (const row of state.rows.values()) {
                if (!matchesCondition(row, condition)) {
                  continue
                }

                if ("publishedAt" in values) {
                  const publishedAt = values.publishedAt
                  row.published_at =
                    publishedAt === null || publishedAt === undefined ? null : Number(publishedAt)
                }
              }
            },
          }
        },
      }
    },
  }

  return db
}

function matchesCondition(row: FakeAuditRow, condition: DrizzleCondition | undefined): boolean {
  if (!condition) {
    return true
  }

  if (condition.kind === "and") {
    return (condition.conditions ?? []).every((candidate) => matchesCondition(row, candidate))
  }

  const value = getRowValue(row, condition.column)

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

function getRowValue(row: FakeAuditRow, column: string | undefined): unknown {
  if (!column) {
    return undefined
  }
  return row[column as keyof FakeAuditRow]
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
  if (!normalizedQuery.startsWith("DELETE FROM ingestion_audit")) {
    throw new Error(`Unsupported SQL in test: ${normalizedQuery}`)
  }

  const cutoff = Number(params[0] ?? 0)
  const limit = Number(params[1] ?? 0)
  let deleted = 0

  for (const [idempotencyKey, row] of db.rows.entries()) {
    if (deleted >= limit) {
      break
    }
    if (row.published_at === null) {
      continue
    }
    if (row.first_seen_at >= cutoff) {
      continue
    }
    db.rows.delete(idempotencyKey)
    deleted++
  }

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
