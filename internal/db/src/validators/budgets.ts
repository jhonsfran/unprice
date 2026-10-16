import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"

extendZodWithOpenApi(z)

// The patterns mirror `@unprice/services/budgets`, which this package cannot import. The core
// re-parses amounts and config; keys and hold ids are trusted after this boundary.

export const budgetKeyInputSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:/_.@-]{0,127}$/, "letters, digits and : / _ . @ -")
  .openapi({ description: "The budget's key, chosen by you", example: "customer:acme" })

const decimalPattern = /^\d{1,19}(\.\d{1,8})?$/

export const budgetAmountInputSchema = z
  .string()
  .regex(decimalPattern, "a non-negative decimal string with at most 8 decimal places")
  .openapi({ description: "A decimal amount in the budget's unit", example: "0.05" })

const budgetDecimalSchema = z
  .string()
  .openapi({ description: "A decimal amount in the budget's unit; negative after an overrun" })

export const budgetHoldIdSchema = z
  .string()
  .regex(/^h_[1-9][0-9]{0,15}$/, "hold ids look like h_<n>")
  .openapi({ example: "h_42" })

export const budgetWindowSchema = z.enum(["hour", "day", "week", "month", "never"])

const budgetEnforceSchema = z.enum(["hard", "soft"])

const budgetIdempotencyKeySchema = z.string().min(1).max(256)

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
          enforce: budgetEnforceSchema.optional(),
        })
      )
      .max(16),
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

export const recordBudgetInputSchema = chargeBudgetInputSchema

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
      enforce: budgetEnforceSchema,
    })
  ),
  holds: z.object({ defaultTtlMs: z.number().int(), maxTtlMs: z.number().int() }),
  onUnavailable: z.union([z.enum(["deny", "allow"]), z.object({ allowUpTo: budgetDecimalSchema })]),
  balance: budgetBalanceSchema,
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

export const getBudgetResponseSchema = z.object({ budget: budgetSchema })

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

export type UpsertBudgetInput = z.infer<typeof upsertBudgetInputSchema>
export type AuthorizeBudgetInput = z.infer<typeof authorizeBudgetInputSchema>
export type SettleBudgetInput = z.infer<typeof settleBudgetInputSchema>
export type ReleaseBudgetInput = z.infer<typeof releaseBudgetInputSchema>
export type ChargeBudgetInput = z.infer<typeof chargeBudgetInputSchema>
export type BudgetBalanceResponse = z.infer<typeof budgetBalanceSchema>
export type BudgetResponse = z.infer<typeof budgetSchema>
export type BudgetExceededDetails = z.infer<typeof budgetExceededDetailsSchema>
