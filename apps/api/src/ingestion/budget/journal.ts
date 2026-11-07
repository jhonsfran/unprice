import type { Pipeline } from "cloudflare:pipelines"
import {
  BUDGET_JOURNAL_SCHEMA_VERSION,
  type BudgetJournalRow,
  budgetJournalRowSchema,
} from "@unprice/lakehouse"
import { formatAmount } from "@unprice/money"
import type { Operation } from "@unprice/services/budgets"
import type { Env } from "~/env"

/** One written version of an operation row, as the journal exports it. */
export type JournalEntry = Readonly<{
  seq: number
  writtenAt: number
  /** The row's stored id: `h_<n>`, or the key's hash for a charge, record, or lease. */
  storedId: string
  status: "open" | "settled" | "released" | "done"
  operation: Operation
}>

/** Where the alarm exports written rows (ADR-0008 D7). */
export type BudgetJournal = {
  send(rows: readonly BudgetJournalRow[]): Promise<void>
}

/** The most rows one send carries. */
export const JOURNAL_BATCH = 500

export function journalRowOf(
  budget: Readonly<{ key: string; projectId: string }>,
  entry: JournalEntry
): BudgetJournalRow {
  const { kind } = entry.operation
  return {
    schema_version: BUDGET_JOURNAL_SCHEMA_VERSION,
    project_id: budget.projectId,
    budget_key: budget.key,
    seq: entry.seq,
    operation_id: entry.storedId,
    kind,
    status: entry.status,
    timestamp: new Date(entry.writtenAt).toISOString(),
    // Amounts as decimal strings: JSON has no bigint.
    data: JSON.parse(
      JSON.stringify(entry.operation, (_key, value: unknown) =>
        typeof value === "bigint" ? formatAmount(value) : value
      )
    ),
  }
}

/**
 * The journal stream through its Worker binding. The stream accepts a structurally invalid row and
 * drops it later without an error, so every row is parsed first; a row that fails throws and the
 * cursor stays, so nothing is skipped.
 */
export function pipelineJournal(pipeline: Pipeline): BudgetJournal {
  return {
    async send(rows) {
      const parsed = rows.map((row) => budgetJournalRowSchema.parse(row))
      await pipeline.send(parsed as unknown as Parameters<Pipeline["send"]>[0])
    },
  }
}

/** Local development without a stream: every row counts as exported, so purges still run. */
export const discardJournal: BudgetJournal = {
  async send(rows) {
    for (const row of rows) budgetJournalRowSchema.parse(row)
  },
}

/**
 * The journal stream when bound. Without one, local development discards rows so purges still
 * run; elsewhere the alarm keeps rows unpurged until the binding exists, and the API worker only
 * logs the refused events it could not journal.
 */
export function journalOf(
  env: Pick<Env, "APP_ENV" | "PIPELINE_BUDGET_JOURNAL">
): BudgetJournal | null {
  if (env.PIPELINE_BUDGET_JOURNAL) return pipelineJournal(env.PIPELINE_BUDGET_JOURNAL)
  return env.APP_ENV === "development" ? discardJournal : null
}
