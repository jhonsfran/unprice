import { sha256HexSync } from "@unprice/db/utils"
import {
  type BudgetRecord,
  type ChargeOperation,
  type HoldOperation,
  type InspectReader,
  type LeaseOperation,
  type Ledger,
  type Operation,
  type ReservationOperation,
  type Statement,
  WINDOW_HISTORY_PERIODS,
  type WindowId,
  type WindowPeriod,
  alarmAt,
  emptyLedger,
} from "@unprice/services/budgets"
import type { CardRows } from "@unprice/services/pricing"
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  min,
  notInArray,
  or,
  sql,
} from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import * as schema from "./db/schema"
import type { BudgetStore, BudgetStoreTx, Sync } from "./ports"

type SqliteHandle = DrizzleSqliteDODatabase<typeof schema>

const SINGLETON_ID = 1

const BIGINT_TAG = "$bigint"

function isRecord(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === "object" && !Array.isArray(item)
}

/** Renames the keys of `item` that start with `$`; null when none does. */
function renamedDollarKeys(item: Record<string, unknown>, rename: (key: string) => string) {
  const keys = Object.keys(item)
  if (!keys.some((key) => key.startsWith("$"))) return null
  // fromEntries defines own properties, so a `__proto__` key stays a key.
  return Object.fromEntries(keys.map((key) => [key.startsWith("$") ? rename(key) : key, item[key]]))
}

/**
 * JSON with bigints tagged as `{"$bigint": "<decimal>"}`, so amounts in the config, usage vectors,
 * counters, and rows round-trip exactly. Event properties are caller data and may name a key
 * `$bigint`, so every key that starts with `$` is stored with one more `$`: an unescaped
 * `$bigint` key is always the tag.
 */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown) => {
    if (typeof item === "bigint") return { [BIGINT_TAG]: item.toString() }
    return isRecord(item) ? (renamedDollarKeys(item, (key) => `$${key}`) ?? item) : item
  })
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_key: string, item: unknown) => {
    if (!isRecord(item)) return item
    const keys = Object.keys(item)
    const tag = item[BIGINT_TAG]
    if (keys.length === 1 && keys[0] === BIGINT_TAG && typeof tag === "string") return BigInt(tag)
    return renamedDollarKeys(item, (key) => key.slice(1)) ?? item
  }) as T
}

type Payload =
  | Omit<HoldOperation, "kind" | "id">
  | Omit<ChargeOperation, "kind" | "id">
  | Omit<LeaseOperation, "kind" | "id">

/** `kind` and `id` live in their own columns, so the payload leaves them out. */
function encodeOperation({ kind: _kind, id: _id, ...payload }: Operation): string {
  return encode(payload)
}

function decodeOperation(
  row: Pick<typeof schema.budgetOperations.$inferSelect, "id" | "kind" | "dataJson">
): Operation {
  const payload = decode<Payload>(row.dataJson)
  if (row.kind === "lease" && "leaseKey" in payload) {
    return { ...payload, kind: "lease", id: `l:${payload.leaseKey}` }
  }
  if (row.kind === "hold" && "reserved" in payload && "state" in payload) {
    return { ...payload, kind: "hold", id: row.id }
  }
  if ((row.kind === "charge" || row.kind === "record") && "crossed" in payload) {
    return { ...payload, kind: row.kind, id: `o:${payload.idempotencyKey}` }
  }
  throw new Error(`budget operation ${row.id} does not match its kind ${row.kind}`)
}

/**
 * Holds keep their minted `h_<n>`. Charge, record, and lease rows are keyed by their key's hash, so
 * a 256-character key never becomes a 256-character primary key.
 */
function storedId(operation: Operation): string {
  if (operation.kind === "hold") return operation.id
  if (operation.kind === "lease") return leaseId(operation.leaseKey)
  return `o:${sha256HexSync(operation.idempotencyKey)}`
}

const leaseId = (leaseKey: string) => `l:${sha256HexSync(leaseKey)}`

/**
 * The first `seq` of a budget's journal: its first write's clock times 1,000. A key deleted and
 * created again starts above every `seq` the deleted budget used, so `(budget key, seq)` stays
 * unique while it writes fewer than 1,000 rows per millisecond it lived.
 */
const firstSeqAt = (now: number) => now * 1_000

function statusOf(operation: Operation): (typeof schema.budgetOperations.$inferInsert)["status"] {
  if (operation.kind === "hold") return operation.state.status
  return operation.kind === "lease" && operation.state.status === "open" ? "open" : "done"
}

export class BudgetSqliteStore implements BudgetStore {
  constructor(private readonly db: SqliteHandle) {}

  atomically<T>(fn: (tx: BudgetStoreTx) => Sync<T>): T {
    return this.db.transaction((tx) => fn(bind(tx)))
  }

  inspecting<T>(fn: (tx: BudgetStoreTx & InspectReader) => Sync<T>): T {
    return this.db.transaction((tx) => fn({ ...bind(tx), ...bindInspect(tx) }))
  }
}

type SqliteTx = SqliteHandle | Parameters<Parameters<SqliteHandle["transaction"]>[0]>[0]

/** Inspection walks the composite `(due_at, id)` index in both directions. */
function bindInspect(db: SqliteTx): InspectReader {
  const operations = schema.budgetOperations
  const columns = {
    id: operations.id,
    kind: operations.kind,
    status: operations.status,
    dueAt: operations.dueAt,
    dataJson: operations.dataJson,
  }

  return {
    walkReservations(after, limit) {
      const examined = db
        .select(columns)
        .from(operations)
        .where(
          after === null
            ? undefined
            : sql`(${operations.dueAt}, ${operations.id}) > (${after.dueAt}, ${after.id})`
        )
        .orderBy(asc(operations.dueAt), asc(operations.id))
        .limit(limit)
        .all()
      const rows = examined.flatMap((row): ReservationOperation[] => {
        if (row.status !== "open") return []
        const operation = decodeOperation(row)
        if (operation.kind === "hold" || operation.kind === "lease") return [operation]
        throw new Error(`open row ${row.id} is not a hold or a lease`)
      })
      const last = examined.at(-1)
      return {
        rows,
        examined: examined.length,
        last: last ? { dueAt: last.dueAt, id: last.id } : null,
      }
    },

    readDueBetween(from, to, limit) {
      return db
        .select(columns)
        .from(operations)
        .where(and(gt(operations.dueAt, from), lte(operations.dueAt, to)))
        .orderBy(desc(operations.dueAt), desc(operations.id))
        .limit(limit)
        .all()
        .map(decodeOperation)
    },
  }
}

type StatementTotals = Pick<Statement, "quantity" | "amount" | "cost">

/** A JSON array bound as one parameter: DO SQLite caps bound parameters at 100 per statement. */
const jsonList = (values: readonly string[]) =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`

function bind(db: SqliteTx): BudgetStoreTx {
  const operations = schema.budgetOperations
  const statements = schema.budgetStatements
  const positions = schema.budgetPositions
  /** The statements `where` selects, each with its positions. */
  const readStatementsWhere = (where: SQL | undefined): Statement[] => {
    const rows = db.select().from(statements).where(where).all()
    if (rows.length === 0) return []
    const byPeriod = new Map<string, Record<string, bigint>>()
    const moved = db
      .select()
      .from(positions)
      .where(sql`${positions.periodId} IN ${jsonList(rows.map((row) => row.periodId))}`)
      .all()
    for (const { periodId, positionKey, value } of moved) {
      // Without a prototype, a position key is never an inherited member.
      const held = byPeriod.get(periodId) ?? Object.create(null)
      held[positionKey] = BigInt(value)
      byPeriod.set(periodId, held)
    }
    return rows.map(({ totalsJson, ...row }) => ({
      ...row,
      ...decode<StatementTotals>(totalsJson),
      positions: { ...byPeriod.get(row.periodId) },
    }))
  }

  const terminal = sql`${operations.status} IN ('done', 'settled', 'released')`
  const exportedSeq = sql`(SELECT ${schema.budgetLedger.exportedSeq} FROM ${schema.budgetLedger} WHERE ${schema.budgetLedger.id} = ${SINGLETON_ID})`
  const readOperationWhere = (where: SQL) => {
    const row = db
      .select({ id: operations.id, kind: operations.kind, dataJson: operations.dataJson })
      .from(operations)
      .where(where)
      .get()
    return row ? decodeOperation(row) : null
  }

  return {
    readBudget() {
      const row = db
        .select()
        .from(schema.budgetRecord)
        .where(eq(schema.budgetRecord.id, SINGLETON_ID))
        .get()
      if (!row) return null
      return {
        key: row.key,
        projectId: row.projectId,
        unit: row.unit,
        version: row.version,
        config: decode<BudgetRecord["config"]>(row.configJson),
      }
    },

    readLedger() {
      const row = db
        .select()
        .from(schema.budgetLedger)
        .where(eq(schema.budgetLedger.id, SINGLETON_ID))
        .get()
      if (!row) return emptyLedger
      return {
        lastAt: row.lastAt,
        holdSeq: row.holdSeq,
        held: decode<Ledger["held"]>(row.heldJson),
        usage: decode<Ledger["usage"]>(row.usageJson),
        operations: decode<Ledger["operations"]>(row.operationsJson),
      }
    },

    readOperation: (id) => readOperationWhere(eq(operations.id, id)),

    // A charge or record by its id; a hold through the partial key index, whose `kind = 'hold'`
    // must be a literal for SQLite to use it.
    readOperationByKey: (idempotencyKey) =>
      readOperationWhere(eq(operations.id, `o:${sha256HexSync(idempotencyKey)}`)) ??
      readOperationWhere(
        sql`${operations.kind} = 'hold' AND ${operations.dataJson} ->> '$.idempotencyKey' = ${idempotencyKey}`
      ),

    readLease(leaseKey) {
      const operation = readOperationWhere(eq(operations.id, leaseId(leaseKey)))
      if (!operation || operation.kind === "lease") return operation
      throw new Error(`row for ${leaseKey} is not a lease`)
    },

    // Asked only when an upsert changes pricing, so the scan without a status index is rare.
    hasOpenReservations() {
      return (
        db
          .select({ id: operations.id })
          .from(operations)
          .where(eq(operations.status, "open"))
          .limit(1)
          .all().length > 0
      )
    },

    readExpired(now, limit) {
      return (
        db
          .select({ id: operations.id, kind: operations.kind, dataJson: operations.dataJson })
          .from(operations)
          .where(and(eq(operations.status, "open"), lte(operations.dueAt, now)))
          // `h_<n>` sorts by its number once shorter ids come first.
          .orderBy(asc(operations.dueAt), asc(sql`length(${operations.id})`), asc(operations.id))
          .limit(limit)
          .all()
          .map((row): ReservationOperation => {
            const operation = decodeOperation(row)
            if (operation.kind === "hold" || operation.kind === "lease") return operation
            throw new Error(`open row ${row.id} is not a hold or a lease`)
          })
      )
    },

    readCards(cardIds) {
      if (cardIds.length === 0) return {}
      const cards = schema.budgetCards
      const rows = db
        .select({ cardId: cards.cardId, cardJson: cards.cardJson })
        .from(cards)
        .where(sql`${cards.cardId} IN ${jsonList(cardIds)}`)
        .all()
      return Object.fromEntries(rows.map((row) => [row.cardId, decode<CardRows>(row.cardJson)]))
    },

    readStatements: (periodIds) =>
      periodIds.length === 0
        ? []
        : readStatementsWhere(sql`${statements.periodId} IN ${jsonList(periodIds)}`),

    readFeatureStatements: (features, from, to) =>
      features.length === 0
        ? []
        : readStatementsWhere(
            and(
              sql`${statements.featureSlug} IN ${jsonList(features)}`,
              or(
                eq(statements.state, "open"),
                and(sql`${statements.start} < ${to}`, gt(statements.end, from))
              )
            )
          ),

    readSealable: (statementKey, at) =>
      readStatementsWhere(
        and(
          eq(statements.statementKey, statementKey),
          lte(statements.end, at),
          sql`${statements.state} IN ('open', 'sealed')`
        )
      ),

    readUnfinishedStatements: () =>
      readStatementsWhere(sql`${statements.state} IN ('open', 'sealed')`),

    cacheCards(cards, at) {
      const table = schema.budgetCards
      for (const card of cards) {
        const row = { cardJson: encode(card), refreshedAt: at }
        db.insert(table)
          .values({ cardId: card.card.id, ...row })
          .onConflictDoUpdate({ target: table.cardId, set: row })
          .run()
      }
    },

    readHistory(windowIds, limit) {
      const history = schema.budgetWindowHistory
      return windowIds.flatMap((windowId) =>
        db
          .select()
          .from(history)
          .where(eq(history.windowId, windowId))
          .orderBy(desc(history.start))
          .limit(limit)
          .all()
          .map(({ consumedJson, ...row }) => ({
            ...row,
            windowId: row.windowId as WindowId,
            consumed: decode<WindowPeriod["consumed"]>(consumedJson),
          }))
      )
    },

    commit({
      budget,
      ledger,
      purged,
      operations: changed,
      periods,
      retiredWindows,
      statements: written,
      positions: moved,
      now,
    }) {
      for (const { positions: _positions, quantity, amount, cost, ...statement } of written) {
        const row = { ...statement, totalsJson: encode({ quantity, amount, cost }) }
        db.insert(statements)
          .values(row)
          .onConflictDoUpdate({ target: statements.periodId, set: row })
          .run()
      }
      for (const { periodId, positionKey, value } of moved) {
        db.insert(positions)
          .values({ periodId, positionKey, value: value.toString() })
          .onConflictDoUpdate({
            target: [positions.periodId, positions.positionKey],
            set: { value: value.toString() },
          })
          .run()
      }
      if (budget) {
        const record = {
          key: budget.key,
          projectId: budget.projectId,
          unit: budget.unit,
          version: budget.version,
          configJson: encode(budget.config),
          updatedAt: now,
        }
        db.insert(schema.budgetRecord)
          .values({ id: SINGLETON_ID, ...record })
          .onConflictDoUpdate({ target: schema.budgetRecord.id, set: record })
          .run()
      }

      const ledgerRow = {
        lastAt: ledger.lastAt,
        holdSeq: ledger.holdSeq,
        heldJson: encode(ledger.held),
        usageJson: encode(ledger.usage),
        operationsJson: encode(ledger.operations),
      }
      // The same write reserves a `seq` for each changed row: the last reserved comes back.
      const reservedSeqs = changed.length
      const ledgerTable = schema.budgetLedger
      const lastSeq = sql`CASE WHEN ${ledgerTable.journalSeq} = 0 THEN ${firstSeqAt(now)} ELSE ${ledgerTable.journalSeq} END + ${reservedSeqs}`
      const reserved = db
        .insert(ledgerTable)
        .values({ id: SINGLETON_ID, ...ledgerRow, journalSeq: firstSeqAt(now) + reservedSeqs })
        .onConflictDoUpdate({
          target: ledgerTable.id,
          set: { ...ledgerRow, journalSeq: reservedSeqs === 0 ? ledgerTable.journalSeq : lastSeq },
        })
        .returning({ journalSeq: ledgerTable.journalSeq })
        .get()
      if (!reserved) throw new Error("the ledger write returned no row")
      let seq = reserved.journalSeq - reservedSeqs

      // One statement per row: DO SQLite caps bound parameters at 100 per statement.
      const history = schema.budgetWindowHistory
      if (retiredWindows.length > 0) {
        db.delete(history)
          .where(
            sql`${history.windowId} IN (SELECT value FROM json_each(${JSON.stringify(retiredWindows)}))`
          )
          .run()
      }
      for (const { consumed, ...period } of periods) {
        const ofWindow = eq(history.windowId, period.windowId)
        db.insert(history)
          .values({ ...period, consumedJson: encode(consumed) })
          .run()
        // Keep what `get` can return and no more.
        const kept = db
          .select({ start: history.start })
          .from(history)
          .where(ofWindow)
          .orderBy(desc(history.start))
          .limit(WINDOW_HISTORY_PERIODS)
        db.delete(history)
          .where(and(ofWindow, notInArray(history.start, kept)))
          .run()
      }

      // Before the upserts: a row past its retention frees its key for the row that reuses it.
      for (const operation of purged) {
        db.delete(operations)
          .where(eq(operations.id, storedId(operation)))
          .run()
      }
      for (const operation of changed) {
        seq += 1
        const row = {
          status: statusOf(operation),
          dueAt: alarmAt(operation),
          dataJson: encodeOperation(operation),
          seq,
          writtenAt: now,
        }
        const insert = db
          .insert(operations)
          .values({ id: storedId(operation), kind: operation.kind, ...row })
        if (operation.kind === "hold" || operation.kind === "lease") {
          insert.onConflictDoUpdate({ target: operations.id, set: row }).run()
        } else {
          insert.run()
        }
      }
    },

    readUnexported(limit) {
      return db
        .select({
          id: operations.id,
          kind: operations.kind,
          status: operations.status,
          dataJson: operations.dataJson,
          seq: operations.seq,
          writtenAt: operations.writtenAt,
        })
        .from(operations)
        .where(gt(operations.seq, exportedSeq))
        .orderBy(asc(operations.seq))
        .limit(limit)
        .all()
        .map((row) => ({
          seq: row.seq,
          writtenAt: row.writtenAt,
          storedId: row.id,
          status: row.status,
          operation: decodeOperation(row),
        }))
    },

    markExported(seq) {
      db.update(schema.budgetLedger)
        .set({ exportedSeq: sql`max(${schema.budgetLedger.exportedSeq}, ${seq})` })
        .where(eq(schema.budgetLedger.id, SINGLETON_ID))
        .run()
    },

    purgeOperations(now, limit) {
      const expired = db
        .select({ id: operations.id })
        .from(operations)
        .where(and(terminal, lte(operations.dueAt, now), lte(operations.seq, exportedSeq)))
        .orderBy(asc(operations.dueAt))
        .limit(limit)
      db.delete(operations).where(inArray(operations.id, expired)).run()
    },

    nextDueAt() {
      return (
        db
          .select({ at: min(operations.dueAt) })
          .from(operations)
          .where(or(eq(operations.status, "open"), lte(operations.seq, exportedSeq)))
          .get()?.at ?? null
      )
    },
  }
}
