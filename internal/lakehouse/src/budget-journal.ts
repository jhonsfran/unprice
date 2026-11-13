import { z } from "zod"
import { getLakehouseSourceSchema } from "./registry"
import { buildLakehouseEventZodSchema, lakehouseJsonValueSchema } from "./zod"

export const BUDGET_JOURNAL_SCHEMA_VERSION =
  getLakehouseSourceSchema("budget_journal").currentVersion

/** Fully qualified Basin Catalog table, as provisioned by configure-lakehouse-pipelines.sh. */
export const BUDGET_JOURNAL_TABLE = `lakehouse.${getLakehouseSourceSchema("budget_journal").sinkTable}`

/**
 * The stream accepts a structurally invalid row and drops it later without an error, so every row
 * is parsed with this schema before it is sent (ADR-0008 D7).
 */
export const budgetJournalRowSchema = buildLakehouseEventZodSchema("budget_journal").extend({
  schema_version: z.number().int(),
  data: lakehouseJsonValueSchema,
  project_id: z.string().min(1),
  budget_key: z.string().min(1),
  // 0 for a rejected event: the budget never wrote it.
  seq: z.number().int().nonnegative(),
  operation_id: z.string().min(1),
  kind: z.enum(["hold", "charge", "record", "lease"]),
  status: z.enum(["open", "settled", "released", "done", "rejected"]),
  timestamp: z.iso.datetime(),
})

export type BudgetJournalRow = z.infer<typeof budgetJournalRowSchema>

/** A refusal written by the API, before it enters the budget's operation store. */
export const rejectedJournalDataSchema = z.looseObject({
  customerId: z.string(),
  idempotencyKey: z.string(),
  event: z.looseObject({
    slug: z.string(),
    properties: z.record(z.string(), lakehouseJsonValueSchema),
  }),
  occurredAt: z.number().int().optional(),
  rejection: z.looseObject({ code: z.string() }),
})
