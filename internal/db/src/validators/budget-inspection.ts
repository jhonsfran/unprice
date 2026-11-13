import { z } from "zod"
import {
  budgetAmountInputSchema,
  budgetBlockedSchema,
  budgetDecimalSchema,
  budgetEpochMsSchema,
  budgetHoldIdSchema,
  budgetIdempotencyKeySchema,
  budgetKeyInputSchema,
  budgetLeaseKeySchema,
  toAmount,
} from "./budget-shared"
import {
  budgetClosedDetailsSchema,
  budgetExceededDetailsSchema,
  budgetSchema,
  budgetWindowPeriodSchema,
} from "./budgets"

// The dashboard's inspection of one budget, through the internal inspect route. Operation rows
// travel as the budget core keeps them, amounts as decimals, except that each usage vector (a
// hold's reservation, a settle's actual, a charge's usage) travels as its amount.

/** An event as the budget priced it: per feature, the statement it counts in and its lines. */
const budgetPricedEventSchema = z.object({
  slug: z.string(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  at: budgetEpochMsSchema,
  features: z.array(
    z.object({
      featureSlug: z.string(),
      periodId: z.string(),
      late: z.boolean(),
      cardId: z.string().nullable(),
      rowId: z.string().nullable(),
      lines: z.array(
        z.object({
          positionKey: z.string(),
          property: z.string().nullable(),
          before: budgetDecimalSchema,
          after: budgetDecimalSchema,
          amount: budgetDecimalSchema,
          cost: budgetDecimalSchema.nullable(),
        })
      ),
      meterQuantity: budgetDecimalSchema,
      amount: budgetDecimalSchema,
      cost: budgetDecimalSchema.nullable(),
    })
  ),
})

const budgetSettledHoldStateSchema = z.object({
  status: z.literal("settled"),
  closedAt: budgetEpochMsSchema,
  actual: budgetDecimalSchema,
  crossed: z.array(z.string()),
  byExpiry: z.literal(true).optional(),
  /** The event the hold consumed: the settle's, or at expiry the estimate's. */
  priced: budgetPricedEventSchema.optional(),
  /** An expired estimate no statement could take; the ledger consumed what it reserved. */
  unbilled: z.object({ reason: z.string() }).optional(),
})

export const budgetHoldOperationSchema = z.object({
  kind: z.literal("hold"),
  id: z.string(),
  idempotencyKey: z.string(),
  amount: budgetDecimalSchema,
  ttlMs: z.number().int().nullable(),
  createdAt: budgetEpochMsSchema,
  expiresAt: budgetEpochMsSchema,
  /** The event the hold was authorized for, priced as the most it can cost. */
  estimate: budgetPricedEventSchema.optional(),
  state: z.discriminatedUnion("status", [
    z.object({ status: z.literal("open") }),
    budgetSettledHoldStateSchema,
    z.object({ status: z.literal("released"), closedAt: budgetEpochMsSchema }),
  ]),
})

export const budgetChargeOperationSchema = z.object({
  kind: z.enum(["charge", "record"]),
  id: z.string(),
  idempotencyKey: z.string(),
  amount: budgetDecimalSchema,
  createdAt: budgetEpochMsSchema,
  crossed: z.array(z.string()),
  priced: budgetPricedEventSchema.optional(),
})

export const budgetLeaseOperationSchema = z.object({
  kind: z.literal("lease"),
  id: z.string(),
  leaseKey: z.string(),
  requested: budgetDecimalSchema,
  ttlMs: z.number().int(),
  createdAt: budgetEpochMsSchema,
  granted: budgetDecimalSchema,
  captured: budgetDecimalSchema,
  last: z
    .object({
      seq: z.number().int(),
      request: z.discriminatedUnion("final", [
        z.object({
          final: z.literal(false),
          captured: budgetDecimalSchema,
          extend: budgetDecimalSchema,
        }),
        z.object({ final: z.literal(true), captured: budgetDecimalSchema }),
      ]),
      extended: budgetDecimalSchema,
      denied: z
        .discriminatedUnion("code", [
          z.object({ code: z.literal("LIMIT_EXCEEDED"), blocked: budgetBlockedSchema }),
          z.object({ code: z.literal("BUDGET_CLOSED"), closedAt: budgetEpochMsSchema }),
        ])
        .nullable(),
      crossed: z.array(z.string()),
    })
    .nullable(),
  expiresAt: budgetEpochMsSchema,
  state: z.discriminatedUnion("status", [
    z.object({ status: z.literal("open") }),
    z.object({ status: z.literal("closed"), closedAt: budgetEpochMsSchema }),
    z.object({ status: z.literal("expired"), closedAt: budgetEpochMsSchema }),
    z.object({
      status: z.literal("refused"),
      closedAt: budgetEpochMsSchema,
      blocked: budgetBlockedSchema,
    }),
  ]),
})

export const budgetReservationSchema = z.union([
  budgetHoldOperationSchema,
  budgetLeaseOperationSchema,
])

export const budgetOperationSchema = z.union([
  budgetHoldOperationSchema,
  budgetChargeOperationSchema,
  budgetLeaseOperationSchema,
])

/** A row's place in the budget's `due_at` order; opaque to callers, who pass it back. */
export const budgetInspectCursorSchema = z.object({
  dueAt: budgetEpochMsSchema,
  id: z.string().min(1).max(80),
})

export const budgetInspectFindSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("hold"), holdId: budgetHoldIdSchema }),
  z.object({ by: z.literal("idempotencyKey"), idempotencyKey: budgetIdempotencyKeySchema }),
  z.object({ by: z.literal("lease"), leaseKey: budgetLeaseKeySchema }),
])

/** What a caller asks of a budget beside its snapshot. `probe` stays a decimal string here. */
export const inspectBudgetQuerySchema = z.object({
  after: budgetInspectCursorSchema.optional(),
  find: budgetInspectFindSchema.optional(),
  probe: budgetAmountInputSchema.optional(),
})

export const inspectBudgetRequestSchema = inspectBudgetQuerySchema
  .extend({
    projectId: z.string().min(1),
    key: budgetKeyInputSchema,
    probe: budgetAmountInputSchema.transform(toAmount).optional(),
  })
  .strict()

export const inspectBudgetResponseSchema = z.object({
  budget: budgetSchema,
  history: z.array(budgetWindowPeriodSchema),
  expiringNext: z.object({
    rows: z.array(budgetReservationSchema).openapi({
      description: "Open holds and leases, the earliest to expire first",
    }),
    examined: z.number().int().nonnegative().openapi({ description: "Rows the walk read" }),
    next: budgetInspectCursorSchema.nullable().openapi({
      description: "Pass as `after` to scan further; null once the walk reached the end",
    }),
  }),
  listed: budgetDecimalSchema.openapi({
    description: "What the listed reservations hold; equals balance.held when all are listed",
  }),
  closedRecently: z.array(budgetOperationSchema).openapi({
    description: "Rows closed in the last hour, newest first",
  }),
  found: budgetOperationSchema.nullable().optional().openapi({
    description: "Present when the request had `find`; null when no row matched",
  }),
  probe: z
    .object({
      amount: budgetDecimalSchema,
      rejection: z
        .discriminatedUnion("code", [
          budgetClosedDetailsSchema
            .omit({ kind: true })
            .extend({ code: z.literal("BUDGET_CLOSED") }),
          budgetExceededDetailsSchema
            .omit({ kind: true })
            .extend({ code: z.literal("LIMIT_EXCEEDED") }),
        ])
        .nullable(),
    })
    .optional()
    .openapi({
      description:
        "Present when the request had `probe`; rejection is null when new work would pass now",
    }),
})

export type InspectBudgetQuery = z.infer<typeof inspectBudgetQuerySchema>
export type InspectBudgetRequest = z.input<typeof inspectBudgetRequestSchema>
export type InspectBudgetResponse = z.infer<typeof inspectBudgetResponseSchema>
