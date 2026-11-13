import {
  BUDGET_JOURNAL_SCHEMA_VERSION,
  type BudgetJournalRow,
  budgetJournalRowSchema,
  rejectedJournalDataSchema,
} from "@unprice/lakehouse"
import { formatAmount } from "@unprice/money"

/** One journal row, with all ledger amounts serialized as decimal strings. */
export function buildBudgetJournalRow(
  input: Omit<BudgetJournalRow, "schema_version" | "timestamp" | "data"> & {
    writtenAt: number
    data: unknown
  }
): BudgetJournalRow {
  const { writtenAt, data, ...row } = input
  const serialized: unknown = JSON.parse(
    JSON.stringify(data, (_key, value: unknown) =>
      typeof value === "bigint" ? formatAmount(value) : value
    )
  )
  return budgetJournalRowSchema.parse({
    ...row,
    schema_version: BUDGET_JOURNAL_SCHEMA_VERSION,
    timestamp: new Date(writtenAt).toISOString(),
    data: row.status === "rejected" ? rejectedJournalDataSchema.parse(serialized) : serialized,
  })
}
