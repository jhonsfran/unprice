import { sha256HexSync } from "@unprice/db/utils"
import {
  type BudgetRecord,
  type HoldOperation,
  type Ledger,
  type Operation,
  RECORD_DEDUPE_MS,
  WINDOW_HISTORY_PERIODS,
  type WindowId,
  dueAt,
  emptyLedger,
  periodOf,
} from "@unprice/services/budgets"
import { and, asc, desc, eq, gt, inArray, lt, lte, min, ne, notInArray } from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import * as schema from "./db/schema"
import type { BudgetStore, BudgetStoreTx, Sync } from "./ports"

type SqliteHandle = DrizzleSqliteDODatabase<typeof schema>

const SINGLETON_ID = 1

/** JSON with bigints tagged, so amounts nested in facts and rows round-trip exactly. */
function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? { $bigint: item.toString() } : item
  )
}

function decode<T>(text: string): T {
  return JSON.parse(text, (_key, item) =>
    item !== null && typeof item === "object" && typeof item.$bigint === "string"
      ? BigInt(item.$bigint)
      : item
  ) as T
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
  const readOperationWhere = (where: ReturnType<typeof eq>) => {
    const row = db.select({ data: operations.dataJson }).from(operations).where(where).get()
    return row ? decode<Operation>(row.data) : null
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
        seq: row.seq,
        lastAt: row.lastAt,
        holdSeq: row.holdSeq,
        held: row.held,
        usage: decode<Ledger["usage"]>(row.usageJson),
      }
    },

    readOperation: (id) => readOperationWhere(eq(operations.id, id)),

    readOperationByKey: (idempotencyKey) =>
      readOperationWhere(eq(operations.keyHash, sha256HexSync(idempotencyKey))),

    readDueHolds(at, limit) {
      return db
        .select({ data: operations.dataJson })
        .from(operations)
        .where(and(eq(operations.status, "open"), lte(operations.dueAt, at)))
        .orderBy(asc(operations.dueAt))
        .limit(limit)
        .all()
        .map((row) => decode<HoldOperation>(row.data))
    },

    readRecordReceipt(idempotencyKey, at) {
      const receipts = schema.budgetRecordReceipts
      const row = db
        .select()
        .from(receipts)
        .where(and(eq(receipts.keyHash, sha256HexSync(idempotencyKey)), gt(receipts.expiresAt, at)))
        .get()
      if (!row) return null
      const { requestHash, amount, crossedJson } = row
      return { requestHash, amount, crossed: decode<string[]>(crossedJson) }
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

    commit({ budget, ledger, entries, operations: changed, now }) {
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
        seq: ledger.seq,
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
      for (const entry of entries) {
        db.insert(schema.budgetEntries)
          .values({ seq: entry.seq, at: entry.at, type: entry.type, factJson: encode(entry) })
          .run()
        for (const period of periodOf(entry)) {
          const history = schema.budgetWindowHistory
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
        if (entry.type === "recorded") {
          // A key whose dedupe ended but is not purged yet is recorded again: replace its receipt.
          const receipt = {
            requestHash: entry.requestHash,
            amount: entry.amount,
            crossedJson: encode(entry.crossed),
            expiresAt: entry.at + RECORD_DEDUPE_MS,
          }
          db.insert(schema.budgetRecordReceipts)
            .values({ keyHash: sha256HexSync(entry.idempotencyKey), ...receipt })
            .onConflictDoUpdate({ target: schema.budgetRecordReceipts.keyHash, set: receipt })
            .run()
        }
      }

      for (const operation of changed) {
        const row = {
          status: statusOf(operation),
          dueAt: dueAt(operation),
          dataJson: encode(operation),
        }
        db.insert(operations)
          .values({
            id: operation.id,
            kind: operation.kind,
            keyHash: sha256HexSync(operation.idempotencyKey),
            ...row,
          })
          .onConflictDoUpdate({ target: operations.id, set: row })
          .run()
      }
    },

    purgeOperations(now, limit) {
      const expired = db
        .select({ id: operations.id })
        .from(operations)
        .where(and(ne(operations.status, "open"), lte(operations.dueAt, now)))
        .orderBy(asc(operations.dueAt))
        .limit(limit)
      db.delete(operations).where(inArray(operations.id, expired)).run()
    },

    pruneJournal(before, limit) {
      const entries = schema.budgetEntries
      const expired = db
        .select({ seq: entries.seq })
        .from(entries)
        .where(lt(entries.at, before))
        .orderBy(asc(entries.seq))
        .limit(limit)
      db.delete(entries).where(inArray(entries.seq, expired)).run()
    },

    purgeRecordReceipts(at, limit) {
      const receipts = schema.budgetRecordReceipts
      const expired = db
        .select({ keyHash: receipts.keyHash })
        .from(receipts)
        .where(lte(receipts.expiresAt, at))
        .orderBy(asc(receipts.expiresAt))
        .limit(limit)
      db.delete(receipts).where(inArray(receipts.keyHash, expired)).run()
    },

    nextDueAt() {
      return (
        db
          .select({ at: min(operations.dueAt) })
          .from(operations)
          .get()?.at ?? null
      )
    },

    oldestReceiptExpiresAt() {
      const receipts = schema.budgetRecordReceipts
      return (
        db
          .select({ at: min(receipts.expiresAt) })
          .from(receipts)
          .get()?.at ?? null
      )
    },

    oldestEntryAt() {
      return (
        db
          .select({ at: schema.budgetEntries.at })
          .from(schema.budgetEntries)
          .orderBy(asc(schema.budgetEntries.seq))
          .limit(1)
          .get()?.at ?? null
      )
    },
  }
}
