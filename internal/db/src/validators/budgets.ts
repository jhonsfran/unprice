import { AMOUNT_PATTERN } from "@unprice/money"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"

extendZodWithOpenApi(z)

// The one definition of the budget wire contract. `@unprice/services/budgets` imports the window
// list and the limit cap from here; keys and hold ids are trusted after this boundary.

export const BUDGET_WINDOWS = ["hour", "day", "week", "month", "never"] as const

/** Windows that take an `anchor`: periods of that length starting at the anchor instead of UTC. */
export const BUDGET_ANCHORED_WINDOWS = ["day", "week", "month"] as const

export const MAX_BUDGET_LIMITS = 16

export const budgetKeyInputSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:/_.@-]{0,127}$/, "letters, digits and : / _ . @ -")
  .openapi({ description: "The budget's key, chosen by you", example: "customer:acme" })

export const budgetAmountInputSchema = z
  .string()
  .regex(AMOUNT_PATTERN, "a non-negative decimal string with at most 8 decimal places")
  .openapi({ description: "A decimal amount in the budget's unit", example: "0.05" })

const budgetDecimalSchema = z
  .string()
  .openapi({ description: "A decimal amount in the budget's unit; negative after an overrun" })

export const budgetHoldIdSchema = z
  .string()
  .regex(/^h_[1-9][0-9]{0,15}$/, "hold ids look like h_<n>")
  .openapi({ example: "h_42" })

export const budgetWindowSchema = z.enum(BUDGET_WINDOWS)

const budgetEnforceSchema = z.enum(["hard", "soft"])

const budgetIdempotencyKeySchema = z.string().min(1).max(256)

const budgetInstantInputSchema = z.string().datetime({ offset: true })

export const upsertBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    unit: z
      .string()
      .regex(/^([A-Z]{3}|money:[A-Z]{3}|credits:[a-z0-9_-]{1,64}|units:[a-z0-9_-]{1,64})$/)
      .openapi({
        description: "A currency code (shorthand for money:<code>), credits:<id>, or units:<slug>",
        example: "USD",
      }),
    limits: z
      .array(
        z.object({
          id: z.string().optional().openapi({ description: "Defaults to the window name" }),
          amount: budgetAmountInputSchema,
          window: budgetWindowSchema,
          anchor: budgetInstantInputSchema.optional().openapi({
            description:
              "Anchors a day, week, or month window: periods start at this instant and repeat every window. A month anchored on the 31st starts on the last day of shorter months. Usage counts from the moment the anchor is first set.",
            example: "2026-10-15T00:00:00Z",
          }),
          enforce: budgetEnforceSchema.optional(),
        })
      )
      .max(MAX_BUDGET_LIMITS),
    closesAt: budgetInstantInputSchema.nullable().optional().openapi({
      description:
        "When the budget closes. From then on authorize and charge return 409, record is accepted for 24 hours more, and settle and release keep working. Omit or send null to keep it open.",
      example: "2026-12-31T23:59:59Z",
    }),
    holds: z
      .object({
        defaultTtlMs: z.number().int().optional(),
        maxTtlMs: z.number().int().optional(),
      })
      .strict()
      .optional(),
    onUnavailable: z
      .union([z.enum(["deny", "allow"]), z.object({ allowUpTo: budgetAmountInputSchema })])
      .optional(),
  })
  .strict()

export const authorizeBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    amount: budgetAmountInputSchema,
    ttlMs: z.number().int().positive().optional(),
    idempotencyKey: budgetIdempotencyKeySchema,
  })
  .strict()

/** The hold id is the idempotency key: the same amount replays, another amount is a conflict. */
export const settleBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    holdId: budgetHoldIdSchema,
    amount: budgetAmountInputSchema,
  })
  .strict()

export const releaseBudgetInputSchema = z
  .object({ key: budgetKeyInputSchema, holdId: budgetHoldIdSchema })
  .strict()

export const chargeBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    amount: budgetAmountInputSchema,
    idempotencyKey: budgetIdempotencyKeySchema,
  })
  .strict()

/** Record accepts usage that occurred within the last 7 days, and dedupes its key for 8 days. */
export const recordBudgetInputSchema = chargeBudgetInputSchema
  .extend({
    occurredAt: z.number().int().nonnegative().openapi({
      description:
        "When the usage happened, in epoch milliseconds. Must be within the last 7 days and at most 5 minutes ahead. Send the same value on a retry.",
      example: 1_792_000_000_000,
    }),
  })
  .strict()

export const getBudgetQuerySchema = z.object({ key: budgetKeyInputSchema })

export const budgetBalanceSchema = z.object({
  remaining: budgetDecimalSchema.nullable().openapi({
    description: "The least remaining over hard limits; null when the budget has no hard limit",
  }),
  held: budgetDecimalSchema,
  limits: z.array(
    z.object({
      id: z.string(),
      window: budgetWindowSchema,
      enforce: budgetEnforceSchema,
      amount: budgetDecimalSchema,
      consumed: budgetDecimalSchema,
      held: budgetDecimalSchema,
      remaining: budgetDecimalSchema,
      resetsAt: z.number().int().nullable(),
    })
  ),
  asOf: z.number().int(),
})

export const budgetSchema = z.object({
  key: z.string(),
  unit: z.string(),
  version: z.number().int(),
  limits: z.array(
    z.object({
      id: z.string(),
      amount: budgetDecimalSchema,
      window: budgetWindowSchema,
      anchor: z.string().optional(),
      enforce: budgetEnforceSchema,
    })
  ),
  holds: z.object({ defaultTtlMs: z.number().int(), maxTtlMs: z.number().int() }),
  onUnavailable: z.union([z.enum(["deny", "allow"]), z.object({ allowUpTo: budgetDecimalSchema })]),
  closesAt: z.string().nullable(),
  closed: z.boolean(),
  balance: budgetBalanceSchema,
})

/** One ended period of a window that had usage; `windowId` is the window, or `<window>@<anchor>`. */
export const budgetWindowPeriodSchema = z.object({
  windowId: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  consumed: budgetDecimalSchema,
})

export const upsertBudgetResponseSchema = z.object({
  changes: z.array(
    z.object({
      change: z.string(),
      limitId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
  ),
  budget: budgetSchema,
})

export const getBudgetResponseSchema = z.object({
  budget: budgetSchema,
  history: z.array(budgetWindowPeriodSchema).openapi({
    description:
      "The last 12 ended periods with usage of each limited window, newest first. Hourly periods are kept 30 days.",
  }),
})

export const authorizeBudgetResponseSchema = z.object({
  allowed: z.literal(true),
  holdId: budgetHoldIdSchema,
  amount: budgetDecimalSchema,
  expiresAt: z.number().int(),
  replayed: z.boolean(),
  balance: budgetBalanceSchema,
})

export const settleBudgetResponseSchema = z.object({
  holdId: budgetHoldIdSchema,
  actual: budgetDecimalSchema,
  covered: budgetDecimalSchema,
  released: budgetDecimalSchema,
  overrun: budgetDecimalSchema,
  late: z.boolean(),
  expired: z.boolean(),
  crossed: z.array(z.string()),
  replayed: z.boolean(),
  balance: budgetBalanceSchema,
})

export const releaseBudgetResponseSchema = z.object({
  holdId: budgetHoldIdSchema,
  released: budgetDecimalSchema,
  replayed: z.boolean(),
  balance: budgetBalanceSchema,
})

export const chargeBudgetResponseSchema = z.object({
  allowed: z.literal(true),
  amount: budgetDecimalSchema,
  crossed: z.array(z.string()),
  replayed: z.boolean(),
  balance: budgetBalanceSchema,
})

export const recordBudgetResponseSchema = z.object({
  amount: budgetDecimalSchema,
  crossed: z.array(z.string()),
  replayed: z.boolean(),
  balance: budgetBalanceSchema,
})

/** `details` on a 402: the limit that blocked the request and what would let it through. */
export const budgetExceededDetailsSchema = z.object({
  kind: z.literal("budget_exceeded"),
  blocked: z.object({
    limitId: z.string(),
    window: budgetWindowSchema,
    remaining: budgetDecimalSchema,
    held: budgetDecimalSchema,
    resetsAt: z.number().int().nullable(),
    remedy: z.enum(["release_holds", "wait_for_reset", "raise_limit"]),
  }),
  balance: budgetBalanceSchema,
})

/** `details` on a 409 for a budget past its `closesAt`. */
export const budgetClosedDetailsSchema = z.object({
  kind: z.literal("budget_closed"),
  closedAt: z.number().int(),
})

export type UpsertBudgetInput = z.infer<typeof upsertBudgetInputSchema>
export type AuthorizeBudgetInput = z.infer<typeof authorizeBudgetInputSchema>
export type SettleBudgetInput = z.infer<typeof settleBudgetInputSchema>
export type ReleaseBudgetInput = z.infer<typeof releaseBudgetInputSchema>
export type ChargeBudgetInput = z.infer<typeof chargeBudgetInputSchema>
export type RecordBudgetInput = z.infer<typeof recordBudgetInputSchema>
export type BudgetBalanceResponse = z.infer<typeof budgetBalanceSchema>
export type BudgetResponse = z.infer<typeof budgetSchema>
export type BudgetExceededDetails = z.infer<typeof budgetExceededDetailsSchema>
