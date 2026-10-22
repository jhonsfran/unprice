import { z } from "zod"
import { budgetDecimalSchema, budgetEpochMsSchema, budgetHoldIdSchema } from "./budget-shared"
import { releaseBudgetInputSchema } from "./budgets"

// An operator's release of one hold from the dashboard. ADR-0006 B3: a release asserts that the
// work used nothing, so the operator states a reason and the use case audits the call.

export const budgetAuditActionSchema = z.enum(["release_hold"])

/** requested before the call; applied or rejected once the budget answered. */
export const budgetAuditStatusSchema = z.enum(["requested", "applied", "rejected"])

/** What a release can be refused with, as the budget's own rejection. */
export const budgetReleaseRejectionSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("BUDGET_NOT_FOUND") }),
  z.object({ code: z.literal("HOLD_NOT_FOUND"), holdId: z.string() }),
  z.object({ code: z.literal("HOLD_RETIRED"), holdId: z.string() }),
  z.object({
    code: z.literal("HOLD_CLOSED"),
    holdId: z.string(),
    status: z.enum(["settled", "released", "expired"]),
  }),
])

export const budgetReleaseRejectionCodeSchema = z.enum([
  "BUDGET_NOT_FOUND",
  "HOLD_NOT_FOUND",
  "HOLD_RETIRED",
  "HOLD_CLOSED",
])

/**
 * The internal release route's 404 and 409 detail. The public route answers only NOT_FOUND or
 * CONFLICT, which cannot tell a missing hold from a missing budget or an expired hold from a
 * retired one; the audit row records which.
 */
export const budgetReleaseRejectedDetailsSchema = z.object({
  kind: z.literal("release_rejected"),
  rejection: budgetReleaseRejectionSchema,
})

export const releaseBudgetInternalInputSchema = releaseBudgetInputSchema
  .extend({ projectId: z.string().min(1), holdCreatedAt: budgetEpochMsSchema })
  .strict()

export const budgetOperatorReasonSchema = z.string().trim().min(10).max(500)

/** The dashboard's release: the operator attests that the work stopped and used nothing. */
export const releaseBudgetHoldInputSchema = z.object({
  id: z.string(),
  holdId: budgetHoldIdSchema,
  holdCreatedAt: budgetEpochMsSchema,
  reason: budgetOperatorReasonSchema,
  confirm: z.literal(true),
})

const budgetAuditRowBaseSchema = z.object({
  id: z.string(),
  budgetId: z.string(),
  action: budgetAuditActionSchema,
  subject: z.string(),
  subjectCreatedAt: budgetEpochMsSchema,
  actorUserId: z.string(),
  reason: z.string(),
  createdAt: budgetEpochMsSchema,
  updatedAt: budgetEpochMsSchema,
})

export const budgetAuditRowSchema = z.discriminatedUnion("status", [
  budgetAuditRowBaseSchema.extend({ status: z.literal("requested") }),
  budgetAuditRowBaseSchema.extend({ status: z.literal("applied"), released: budgetDecimalSchema }),
  budgetAuditRowBaseSchema.extend({
    status: z.literal("rejected"),
    rejectionCode: budgetReleaseRejectionCodeSchema,
  }),
])

export type BudgetAuditAction = z.infer<typeof budgetAuditActionSchema>
export type BudgetAuditStatus = z.infer<typeof budgetAuditStatusSchema>
export type BudgetReleaseRejection = z.infer<typeof budgetReleaseRejectionSchema>
export type BudgetReleaseRejectionCode = z.infer<typeof budgetReleaseRejectionCodeSchema>
export type BudgetAuditRow = z.infer<typeof budgetAuditRowSchema>
export type ReleaseBudgetInternalInput = z.input<typeof releaseBudgetInternalInputSchema>
