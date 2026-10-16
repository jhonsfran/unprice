import { sha256HexSync } from "@unprice/db/utils"
import {
  type BudgetRecord,
  type Entry,
  type HoldOperation,
  type Ledger,
  type Operation,
  dueAt,
  emptyLedger,
} from "@unprice/services/budgets"
import { and, asc, eq, inArray, lt, lte, min, ne } from "drizzle-orm"
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
            keyHash:
              operation.kind === "late_settle" ? null : sha256HexSync(operation.idempotencyKey),
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
      return db
        .delete(operations)
        .where(inArray(operations.id, expired))
        .returning({ id: operations.id })
        .all().length
    },

    readJournalBase() {
      const row = db
        .select({ ledgerJson: schema.budgetJournalBase.ledgerJson })
        .from(schema.budgetJournalBase)
        .where(eq(schema.budgetJournalBase.id, SINGLETON_ID))
        .get()
      return row ? decode<Ledger>(row.ledgerJson) : emptyLedger
    },

    readJournalHead(before, limit) {
      return db
        .select({ factJson: schema.budgetEntries.factJson })
        .from(schema.budgetEntries)
        .where(lt(schema.budgetEntries.at, before))
        .orderBy(asc(schema.budgetEntries.seq))
        .limit(limit)
        .all()
        .map((row) => decode<Entry>(row.factJson))
    },

    compactJournal(base) {
      const row = { seq: base.seq, ledgerJson: encode(base) }
      db.insert(schema.budgetJournalBase)
        .values({ id: SINGLETON_ID, ...row })
        .onConflictDoUpdate({ target: schema.budgetJournalBase.id, set: row })
        .run()
      db.delete(schema.budgetEntries).where(lte(schema.budgetEntries.seq, base.seq)).run()
    },

    nextDueAt() {
      return (
        db
          .select({ at: min(operations.dueAt) })
          .from(operations)
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
