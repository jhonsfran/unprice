import { z } from "zod"
import { type LakehouseEventForSource, getLakehouseSourceSchema } from "./registry"
import { buildLakehouseEventZodSchema } from "./zod"

export const BUDGET_JOURNAL_SCHEMA_VERSION =
  getLakehouseSourceSchema("budget_journal").currentVersion

/** Fully qualified Basin Catalog table, as provisioned by configure-lakehouse-pipelines.sh. */
export const BUDGET_JOURNAL_TABLE = `lakehouse.${getLakehouseSourceSchema("budget_journal").sinkTable}`

export type BudgetJournalRow = Omit<LakehouseEventForSource<"budget_journal">, "timestamp"> & {
  timestamp: string
}

/**
 * The stream accepts a structurally invalid row and drops it later without an error, so every row
 * is parsed with this schema before it is sent (ADR-0008 D7).
 */
export const budgetJournalRowSchema = buildLakehouseEventZodSchema("budget_journal").extend({
  project_id: z.string().min(1),
  budget_key: z.string().min(1),
  seq: z.number().int().positive(),
  operation_id: z.string().min(1),
  kind: z.enum(["hold", "charge", "record", "lease"]),
  status: z.enum(["open", "settled", "released", "done"]),
  timestamp: z.iso.datetime(),
}) as unknown as z.ZodType<BudgetJournalRow>
