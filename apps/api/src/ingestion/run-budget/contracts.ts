import { entitlementMeterFactSchemaV1 } from "@unprice/analytics"
import { z } from "zod"
import { activeGrantSchema, entitlementConfigSchema } from "../entitlements/contracts"

export const runStatusSchema = z.enum([
  "running",
  "completed",
  "expired",
  "canceled",
  "budget_exceeded",
  "failed",
])

export const runBudgetSummarySchema = z.object({
  runId: z.string().min(1),
  status: runStatusSchema,
  budgetAmount: z.number().int().nonnegative(),
  consumedAmount: z.number().int().nonnegative(),
  remainingAmount: z.number().int().nonnegative(),
  walletReservationId: z.string().nullable().optional(),
  walletError: z.string().optional(),
})

const workloadTypeSchema = z.enum(["agent", "workflow", "job", "tool", "custom"])

const sourceSchema = z.object({
  workspaceId: z.string().min(1),
  environment: z.string().min(1),
  apiKeyId: z.string().nullable(),
  sourceType: z.enum(["api_key", "system", "unknown"]),
  sourceId: z.string().min(1),
  sourceName: z.string().nullable(),
})

const eventSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  timestamp: z.number().finite(),
  properties: z.record(z.unknown()),
})

/**
 * Grant shape passed through to the EntitlementWindowDO.
 */
const runGrantSchema = activeGrantSchema

/**
 * Entitlement config passed through to the EntitlementWindowDO.
 */
const runEntitlementConfigSchema = entitlementConfigSchema

export const startRunInputSchema = z.object({
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  runId: z.string().min(1),
  budgetAmount: z.number().int().positive(),
  currency: z.string().min(3).max(12),
  idempotencyKey: z.string().min(1),
  workloadType: workloadTypeSchema.nullable().optional(),
  workloadId: z.string().min(1).nullable().optional(),
  traceId: z.string().min(1).nullable().optional(),
  parentRunId: z.string().min(1).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  expiresAt: z.number().finite().nullable().optional(),
  now: z.number().finite(),
})

export const applyRunSyncEventInputSchema = z.object({
  runId: z.string().min(1),
  customerId: z.string().min(1),
  projectId: z.string().min(1),
  featureSlug: z.string().min(1),
  idempotencyKey: z.string().min(1),
  event: eventSchema,
  source: sourceSchema,
  now: z.number().finite(),
  /** The resolved customer entitlement ID for correct DO addressing */
  customerEntitlementId: z.string().min(1),
  /** Full entitlement config for the EntitlementWindowDO */
  entitlement: runEntitlementConfigSchema,
  /** Active grants for the entitlement */
  grants: z.array(runGrantSchema).min(1),
})

export const endRunInputSchema = z.object({
  runId: z.string().min(1),
  customerId: z.string().min(1),
  projectId: z.string().min(1),
  status: z.enum(["completed", "expired", "canceled"]),
  endedAt: z.number().finite(),
})

export const getRunStatusInputSchema = z.object({
  runId: z.string().min(1),
  customerId: z.string().min(1),
  projectId: z.string().min(1),
})

export const runBudgetDecisionSchema = z.object({
  allowed: z.boolean(),
  state: z.enum(["processed", "rejected"]),
  rejectionReason: z
    .enum(["LIMIT_EXCEEDED", "WALLET_EMPTY", "LATE_EVENT_CLOSED_PERIOD", "RUN_BUDGET_EXCEEDED"])
    .optional(),
  message: z.string().optional(),
  budget: runBudgetSummarySchema,
  meterFacts: z.array(entitlementMeterFactSchemaV1).default([]),
})

export type StartRunInput = z.infer<typeof startRunInputSchema>
export type ApplyRunSyncEventInput = z.infer<typeof applyRunSyncEventInputSchema>
export type EndRunInput = z.infer<typeof endRunInputSchema>
export type GetRunStatusInput = z.infer<typeof getRunStatusInputSchema>
export type RunBudgetDecision = z.infer<typeof runBudgetDecisionSchema>
export type RunBudgetSummary = z.infer<typeof runBudgetSummarySchema>
