import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import { budgetRuns } from "../schema/budget-runs"

extendZodWithOpenApi(z)

export const runStatusSchema = z.enum([
  "running",
  "completed",
  "expired",
  "canceled",
  "budget_exceeded",
  "failed",
])

const workloadTypes = ["agent", "workflow", "job", "tool", "custom"] as const

export const workloadTypeSchema = z.enum(workloadTypes)

const nullableWorkloadTypeSchema = workloadTypeSchema.nullable().openapi({
  enum: [...workloadTypes, null],
})

export const startRunInputSchema = z.object({
  customerId: z.string().min(1).optional(),
  /** Budget in currency minor units (cents). e.g. 500 = $5.00 USD. */
  budgetAmount: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  workloadType: nullableWorkloadTypeSchema.optional(),
  workloadId: z.string().min(1).nullable().optional(),
  traceId: z.string().min(1).nullable().optional(),
  parentRunId: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
})

export const applyRunSyncEventInputSchema = z.object({
  featureSlug: z.string().min(1),
  idempotencyKey: z.string().min(1),
  id: z.string().min(1).optional(),
  eventSlug: z.string().min(1).optional(),
  timestamp: z.number().int().positive().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
})

export const endRunInputSchema = z.object({
  status: z.enum(["completed", "canceled", "failed"]).default("completed"),
})

const runSummaryCommonShape = {
  runId: z.string(),
  status: runStatusSchema,
  customerId: z.string(),
  currency: z.string(),
  workloadType: nullableWorkloadTypeSchema,
  workloadId: z.string().nullable(),
  traceId: z.string().nullable(),
  parentRunId: z.string().nullable(),
}

export const runLedgerSummarySchema = z.object({
  ...runSummaryCommonShape,
  budgetAmount: z.number().int().describe("Budget in pgledger scale 8."),
  consumedAmount: z.number().int().describe("Consumed amount in pgledger scale 8."),
  remainingAmount: z.number().int().describe("Remaining amount in pgledger scale 8."),
})

export const runSummarySchema = z.object({
  ...runSummaryCommonShape,
  budgetAmount: z.number().int().openapi({
    description: "Budget in currency minor units (cents).",
  }),
  consumedAmount: z.number().int().openapi({
    description: "Consumed in currency minor units (cents).",
  }),
  remainingAmount: z.number().int().openapi({
    description: "Remaining in currency minor units (cents).",
  }),
})

export const runLedgerSyncDecisionSchema = z.object({
  accepted: z.boolean(),
  reason: z.enum([
    "accepted",
    "duplicate",
    "insufficient_budget",
    "expired",
    "not_running",
    "entitlement_denied",
  ]),
  run: runLedgerSummarySchema,
})

export const runSyncDecisionSchema = z.object({
  accepted: z.boolean(),
  reason: z.enum([
    "accepted",
    "duplicate",
    "insufficient_budget",
    "expired",
    "not_running",
    "entitlement_denied",
  ]),
  run: runSummarySchema,
})

export const budgetRunSelectSchema = createSelectSchema(budgetRuns)
export const budgetRunInsertSchema = createInsertSchema(budgetRuns)

export type BudgetRun = z.infer<typeof budgetRunSelectSchema>
export type StartRunInput = z.infer<typeof startRunInputSchema>
export type ApplyRunSyncEventInput = z.infer<typeof applyRunSyncEventInputSchema>
export type EndRunInput = z.infer<typeof endRunInputSchema>
export type RunLedgerSummary = z.infer<typeof runLedgerSummarySchema>
export type RunLedgerSyncDecision = z.infer<typeof runLedgerSyncDecisionSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type RunSyncDecision = z.infer<typeof runSyncDecisionSchema>
