import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { budgetRuns } from "../schema/budget-runs"

export const runStatusSchema = z.enum([
  "running",
  "completed",
  "expired",
  "canceled",
  "budget_exceeded",
  "failed",
])

export const startRunInputSchema = z.object({
  customerId: z.string().min(1).optional(),
  budgetAmount: z.number().positive(),
  currency: z.string().min(3).max(12),
  idempotencyKey: z.string().min(1),
  agentId: z.string().min(1).nullable().optional(),
  traceId: z.string().min(1).nullable().optional(),
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

export const runSummarySchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  customerId: z.string(),
  budgetAmount: z.number(),
  consumedAmount: z.number(),
  remainingAmount: z.number(),
  currency: z.string(),
  agentId: z.string().nullable(),
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
export type RunSummary = z.infer<typeof runSummarySchema>
export type RunSyncDecision = z.infer<typeof runSyncDecisionSchema>
