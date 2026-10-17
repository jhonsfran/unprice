import { sha256HexSync } from "@unprice/db/utils"
import {
  type BudgetRecord,
  type ChargeOperation,
  type HoldOperation,
  type Ledger,
  type Operation,
  WINDOW_HISTORY_PERIODS,
  type WindowId,
  dueAt,
  emptyLedger,
} from "@unprice/services/budgets"
import { and, asc, desc, eq, inArray, lte, min, notInArray, sql } from "drizzle-orm"
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

type Payload = Omit<HoldOperation, "kind" | "id"> | Omit<ChargeOperation, "kind" | "id">

/** `kind` and `id` live in their own columns, so the payload leaves them out. */
function encodeOperation({ kind: _kind, id: _id, ...payload }: Operation): string {
  return encode(payload)
}

function decodeOperation(
  row: Pick<typeof schema.budgetOperations.$inferSelect, "id" | "kind" | "dataJson">
): Operation {
  const payload = decode<Payload>(row.dataJson)
  if (row.kind === "hold" && "state" in payload) return { ...payload, kind: "hold", id: row.id }
  if (row.kind !== "hold" && "crossed" in payload) {
    return { ...payload, kind: row.kind, id: `o:${payload.idempotencyKey}` }
  }
  throw new Error(`budget operation ${row.id} does not match its kind ${row.kind}`)
}

/**
 * Holds keep their minted `h_<n>`. Charge and record rows are keyed by their key's hash, so a
 * 256-character idempotency key never becomes a 256-character primary key.
 */
function storedId(operation: Operation): string {
  return operation.kind === "hold" ? operation.id : `o:${sha256HexSync(operation.idempotencyKey)}`
}

function statusOf(operation: Operation): (typeof schema.budgetOperations.$inferInsert)["status"] {
  return operation.kind === "hold" ? operation.state.status : "done"
}

export class BudgetSqliteStore implements BudgetStore {
  constructor(private readonly db: SqliteHandle) {}

  atomically<T>(fn: (tx: BudgetStoreTx) => Sync<T>): T {
    return this.db.transaction((tx) => fn(bind(tx)))
  }
}

function bind(
  db: SqliteHandle | Parameters<Parameters<SqliteHandle["transaction"]>[0]>[0]
): BudgetStoreTx {
  const operations = schema.budgetOperations
  const terminal = sql`${operations.status} IN ('done', 'settled', 'released')`
  const readOperationWhere = (where: ReturnType<typeof eq>) => {
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
      }
    },

    readOperation: (id) => readOperationWhere(eq(operations.id, id)),

    readOperationByKey: (idempotencyKey) =>
      readOperationWhere(eq(sql`${operations.dataJson} ->> '$.idempotencyKey'`, idempotencyKey)),

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
        // An open hold has no retention end; the due index skips it by status, not by this value.
        const row = {
          status: statusOf(operation),
          dueAt: dueAt(operation) ?? 0,
          dataJson: encodeOperation(operation),
        }
        const insert = db
          .insert(operations)
          .values({ id: storedId(operation), kind: operation.kind, ...row })
        if (operation.kind === "hold") {
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
          .where(terminal)
          .get()?.at ?? null
      )
    },
  }
}
