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
  WINDOW_HISTORY_PERIODS,
  type WindowId,
  alarmAt,
  emptyLedger,
} from "@unprice/services/budgets"
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  min,
  notInArray,
  sql,
} from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import * as schema from "./db/schema"
import type { BudgetStore, BudgetStoreTx, Sync } from "./ports"

type SqliteHandle = DrizzleSqliteDODatabase<typeof schema>

const SINGLETON_ID = 1

/** JSON with bigints tagged, so amounts in the config, counters, and rows round-trip exactly. */
function encode(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown) =>
    typeof item === "bigint" ? { $bigint: item.toString() } : item
  )
}

function decode<T>(text: string): T {
  return JSON.parse(text, (_key: string, item: unknown) =>
    item !== null &&
    typeof item === "object" &&
    "$bigint" in item &&
    typeof item.$bigint === "string"
      ? BigInt(item.$bigint)
      : item
  ) as T
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
  if (row.kind === "hold" && "amount" in payload && "state" in payload) {
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

/** Ties on `due_at` break by `length(id)`, then `id`, so `h_<n>` sorts by its number. */
function bindInspect(db: SqliteTx): InspectReader {
  const operations = schema.budgetOperations
  const idLength = sql`length(${operations.id})`
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
            : and(
                gte(operations.dueAt, after.dueAt),
                sql`(${operations.dueAt}, ${idLength}, ${operations.id}) > (${after.dueAt}, ${after.id.length}, ${after.id})`
              )
        )
        .orderBy(asc(operations.dueAt), asc(idLength), asc(operations.id))
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
        .orderBy(desc(operations.dueAt), desc(idLength), desc(operations.id))
        .limit(limit)
        .all()
        .map(decodeOperation)
    },
  }
}

function bind(db: SqliteTx): BudgetStoreTx {
  const operations = schema.budgetOperations
  const terminal = sql`${operations.status} IN ('done', 'settled', 'released')`
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
        held: row.held,
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
          .map((row) => ({ ...row, windowId: row.windowId as WindowId }))
      )
    },

    commit({ budget, ledger, purged, operations: changed, periods, retiredWindows, now }) {
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
        held: ledger.held,
        usageJson: encode(ledger.usage),
        operationsJson: encode(ledger.operations),
      }
      db.insert(schema.budgetLedger)
        .values({ id: SINGLETON_ID, ...ledgerRow })
        .onConflictDoUpdate({ target: schema.budgetLedger.id, set: ledgerRow })
        .run()

      // One statement per row: DO SQLite caps bound parameters at 100 per statement.
      const history = schema.budgetWindowHistory
      if (retiredWindows.length > 0) {
        db.delete(history)
          .where(
            sql`${history.windowId} IN (SELECT value FROM json_each(${JSON.stringify(retiredWindows)}))`
          )
          .run()
      }
      for (const period of periods) {
        const ofWindow = eq(history.windowId, period.windowId)
        db.insert(history).values(period).run()
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
        const row = {
          status: statusOf(operation),
          dueAt: alarmAt(operation),
          dataJson: encodeOperation(operation),
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

    purgeOperations(now, limit) {
      const expired = db
        .select({ id: operations.id })
        .from(operations)
        .where(and(terminal, lte(operations.dueAt, now)))
        .orderBy(asc(operations.dueAt))
        .limit(limit)
      db.delete(operations).where(inArray(operations.id, expired)).run()
    },

    nextDueAt() {
      return (
        db
          .select({ at: min(operations.dueAt) })
          .from(operations)
          .get()?.at ?? null
      )
    },
  }
}
