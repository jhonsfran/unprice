import { z } from "zod"
import {
  budgetDecimalSchema,
  budgetEnforceSchema,
  budgetEpochMsSchema,
  budgetWindowSchema,
} from "./budget-shared"
import { searchParamsSchemaDataTable } from "./utils"

// The dashboard catalog: one Postgres row per budget, written after each upsert. It holds
// configuration facts only; a balance would be stale within milliseconds of a hot budget's writes.

/** hard when any limit is hard, soft when every limit is soft, none without limits. */
export const budgetCapSchema = z.enum(["hard", "soft", "none"])

/** Derived from closesAt at read time: open without one, closing before it, closed from it. */
export const budgetCatalogStatusSchema = z.enum(["open", "closing", "closed"])

export const budgetCatalogLimitSchema = z.object({
  id: z.string(),
  window: budgetWindowSchema,
  enforce: budgetEnforceSchema,
  amount: budgetDecimalSchema,
})

export const budgetCatalogFactsSchema = z.object({
  key: z.string(),
  unit: z.string(),
  version: z.number().int(),
  cap: budgetCapSchema,
  limits: z.array(budgetCatalogLimitSchema),
  closesAt: budgetEpochMsSchema.nullable(),
})

export const budgetCatalogRowSchema = budgetCatalogFactsSchema.extend({
  id: z.string(),
  status: budgetCatalogStatusSchema,
  createdAt: budgetEpochMsSchema,
  updatedAt: budgetEpochMsSchema,
})

/** Keeps the values a filter knows, so a stale URL drops a value instead of failing the page. */
function knownFilterValues<T extends z.ZodTypeAny>(schema: T) {
  return z.array(z.unknown()).transform((values) =>
    values.flatMap((value) => {
      const parsed = schema.safeParse(value)
      return parsed.success ? [parsed.data as z.output<T>] : []
    })
  )
}

/** The data-table search, where `search` is a key prefix. */
export const listBudgetsInputSchema = searchParamsSchemaDataTable.extend({
  filters: z
    .object({
      status: knownFilterValues(budgetCatalogStatusSchema).optional(),
      unit: knownFilterValues(z.string()).optional(),
      cap: knownFilterValues(budgetCapSchema).optional(),
    })
    .default({}),
})

export type BudgetCap = z.infer<typeof budgetCapSchema>
export type BudgetCatalogStatus = z.infer<typeof budgetCatalogStatusSchema>
export type BudgetCatalogLimit = z.infer<typeof budgetCatalogLimitSchema>
export type BudgetCatalogFacts = z.infer<typeof budgetCatalogFactsSchema>
export type BudgetCatalogRow = z.infer<typeof budgetCatalogRowSchema>
export type ListBudgetsInput = z.infer<typeof listBudgetsInputSchema>
