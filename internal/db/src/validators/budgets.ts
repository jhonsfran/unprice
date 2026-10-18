import { AMOUNT_PATTERN, type Amount, formatAmount, parseAmount } from "@unprice/money"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"

extendZodWithOpenApi(z)

// The one definition of the budget wire contract. Input schemas parse straight into the core's
// types (amounts in base units, instants in epoch ms), and `@unprice/services/budgets` imports the
// window lists, the limit cap, and the timing constants from here, so the descriptions below
// always state the values the core enforces. Everything is trusted after this boundary.

export const BUDGET_WINDOWS = ["hour", "day", "week", "month", "never"] as const

/** Windows that take an `anchor`: periods of that length starting at the anchor instead of UTC. */
export const BUDGET_ANCHORED_WINDOWS = ["day", "week", "month"] as const

export const MAX_BUDGET_LIMITS = 16
export const MAX_RETAINED_ANCHORED_WINDOWS = 32

export const MIN_HOLD_TTL_MS = 1_000
export const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1000
export const MAX_HOLD_TTL_MS = 24 * 60 * 60 * 1000
/**
 * Settled and released holds and charge rows answer this long after they close; an open hold has
 * no retention until it closes, by its caller or by expiry. They are the idempotency record and the
 * tombstone that answers replays; after it, a hold is retired and can no longer be settled or
 * released. A budget accepts `record` this long past its `closesAt`.
 */
export const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000
/** `record` accepts usage that occurred at most this long ago (`TOO_LATE` beyond it). */
export const RECORD_ACCEPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** `record` rejects `occurredAt` further than this ahead of the budget's clock. */
export const RECORD_FUTURE_SKEW_MS = 5 * 60 * 1000
/**
 * A record's row answers this long: within it a replay never counts again and a changed request
 * under the same key is a conflict. It must exceed the accept window plus the skew, so a replay
 * the row no longer catches is already `TOO_LATE`.
 */
export const RECORD_DEDUPE_MS = 8 * 24 * 60 * 60 * 1000
/** `get` returns this many ended periods per limited window, newest first; no more are kept. */
export const WINDOW_HISTORY_PERIODS = 12
/**
 * A budget with a `closesAt` deletes its storage this long after it closes, once no row is left to
 * settle, purge, or replay. Until then the closed budget stays readable.
 */
export const CLOSED_BUDGET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const DURATION_UNITS = [
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000],
] as const

/** The largest whole unit, for descriptions: 900000 is "15 minutes". */
export function describeDuration(ms: number): string {
  for (const [unit, size] of DURATION_UNITS) {
    if (ms % size === 0) {
      const count = ms / size
      return `${count} ${unit}${count === 1 ? "" : "s"}`
    }
  }
  return `${ms} ms`
}

export const budgetKeyInputSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:/_.@-]{0,127}$/, "letters, digits and : / _ . @ -")
  .openapi({
    description:
      "The budget's key, chosen by you and unique within the project. Up to 128 letters, digits, and `: / _ . @ -`, starting with a letter or digit.",
    example: "customer:acme",
  })

export const budgetAmountInputSchema = z
  .string()
  .regex(AMOUNT_PATTERN, "a non-negative decimal string with at most 8 decimal places")
  .openapi({
    description:
      "A non-negative decimal string in the budget's unit, with at most 8 decimal places. Strings keep amounts exact.",
    example: "0.05",
  })

/** The pattern bounds an amount's shape; this bounds its size and turns it into base units. */
function toAmount(text: string, ctx: z.RefinementCtx): Amount {
  const parsed = parseAmount(text)
  if (parsed.ok) return parsed.amount
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid amount: ${parsed.reason}` })
  return z.NEVER
}

const budgetDecimalSchema = z
  .string()
  .openapi({ description: "A decimal amount in the budget's unit" })

export const budgetHoldIdSchema = z
  .string()
  .regex(/^h_[1-9][0-9]{0,15}$/, "hold ids look like h_<n>")
  .openapi({ description: "The hold, as returned by authorize", example: "h_42" })

export const budgetWindowSchema = z.enum(BUDGET_WINDOWS).openapi({
  description:
    "The period a limit counts over. hour, day, week (ISO, from Monday), and month are UTC calendar periods unless anchored; never counts for the life of the budget.",
  example: "month",
})

const budgetEnforceSchema = z.enum(["hard", "soft"]).openapi({
  description:
    "hard denies authorize and charge that would exceed the limit; soft never denies. Either kind is reported in `crossed` once usage passes it, and only a record can pass a hard limit.",
  example: "hard",
})

const budgetIdempotencyKeySchema = z.string().min(1).max(256).openapi({
  description:
    "Up to 256 characters. A retry with the same key and the same request replays the first answer; the same key with a different request returns 409.",
  example: "run_8f2c:step_3",
})

/** Every instant on the wire is epoch milliseconds, like the rest of the API. */
const budgetEpochMsSchema = z.number().int()

const budgetInstantInputSchema = budgetEpochMsSchema.nonnegative()

const budgetTtlInputSchema = z.number().int().min(MIN_HOLD_TTL_MS).max(MAX_HOLD_TTL_MS)

const budgetResetsAtSchema = budgetEpochMsSchema.nullable().openapi({
  description: "When the limit's current period ends, in epoch milliseconds; null for never",
})

const budgetReplayedSchema = z.boolean().openapi({
  description: "True when this answer replays an earlier request instead of applying it again",
})

const budgetCrossedSchema = z.array(z.string()).openapi({
  description:
    "Limit ids whose consumed amount first exceeded the limit's amount. A hard limit crosses only after recorded usage took its room. Reservations do not trigger crossings. Replays preserve the original result.",
})

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
        z
          .object({
            id: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, "letters, digits and _ . : -")
              .optional()
              .openapi({
                description:
                  "Unique within the budget. Defaults to the window name. The id fixes the limit's recurring schedule. Equivalent UTC anchors share usage. A different schedule under the same id returns 409, so use a new id for a different schedule.",
                example: "month",
              }),
            amount: budgetAmountInputSchema.transform(toAmount),
            window: budgetWindowSchema,
            anchor: budgetInstantInputSchema.optional().openapi({
              description:
                "Anchors a day, week, or month window, in epoch milliseconds: periods start at this instant and repeat every window. A month anchored on the 31st starts on the last day of shorter months. Equivalent UTC anchors share one counter. Usage counts from the moment the schedule is first tracked. Removed schedules retain current usage until their period ends. A budget retains at most 32 distinct anchored schedules.",
              example: 1_792_022_400_000,
            }),
            enforce: budgetEnforceSchema.optional().openapi({ description: "Defaults to hard" }),
          })
          .refine(
            (limit) =>
              limit.anchor === undefined ||
              (BUDGET_ANCHORED_WINDOWS as readonly string[]).includes(limit.window),
            { path: ["anchor"], message: "only day, week, and month windows take an anchor" }
          )
      )
      .max(MAX_BUDGET_LIMITS)
      .openapi({
        description: `Up to ${MAX_BUDGET_LIMITS} limits. Every hard limit must have room for a hold or charge. An empty list makes a budget that only counts.`,
      }),
    closesAt: budgetInstantInputSchema
      .nullable()
      .optional()
      .openapi({
        description: `When the budget closes, in epoch milliseconds. From then on authorize and charge return 409, record is accepted for ${describeDuration(OPERATION_RETENTION_MS)} more, and settle and release keep working. ${describeDuration(CLOSED_BUDGET_RETENTION_MS)} after closesAt, once nothing is left to settle or replay, the budget is deleted: get returns 404 and an upsert creates it anew. An upsert replaces the whole definition, so omitting closesAt or sending null leaves the budget open and clears any close time it had.`,
        example: 1_798_761_599_000,
      }),
    holds: z
      .object({
        defaultTtlMs: budgetTtlInputSchema.optional().openapi({
          description: `TTL for an authorize that sends no ttlMs, in milliseconds. Defaults to ${DEFAULT_HOLD_TTL_MS} (${describeDuration(DEFAULT_HOLD_TTL_MS)}).`,
          example: DEFAULT_HOLD_TTL_MS,
        }),
        maxTtlMs: budgetTtlInputSchema.optional().openapi({
          description: `The largest ttlMs an authorize may ask for, in milliseconds. Defaults to ${MAX_HOLD_TTL_MS} (${describeDuration(MAX_HOLD_TTL_MS)}).`,
          example: MAX_HOLD_TTL_MS,
        }),
      })
      .strict()
      .optional()
      .openapi({
        description: `Hold timing. Both TTLs must be between ${MIN_HOLD_TTL_MS} and ${MAX_HOLD_TTL_MS} ms, and the default must not exceed the max. An omitted TTL takes its default on every upsert.`,
      }),
    onUnavailable: z.literal("deny").optional().openapi({
      description: "Deny new work when Unprice cannot be reached. Defaults to deny.",
      example: "deny",
    }),
  })
  .strict()
  .transform(({ key, unit, limits, holds, onUnavailable, closesAt }) => ({
    key,
    unit: /^[A-Z]{3}$/.test(unit) ? `money:${unit}` : unit,
    config: {
      limits: limits.map(({ id, enforce, ...limit }) => ({
        ...limit,
        id: id ?? limit.window,
        enforce: enforce ?? "hard",
      })),
      holds: {
        defaultTtlMs: holds?.defaultTtlMs ?? DEFAULT_HOLD_TTL_MS,
        maxTtlMs: holds?.maxTtlMs ?? MAX_HOLD_TTL_MS,
      },
      onUnavailable: onUnavailable ?? "deny",
      closesAt: closesAt ?? null,
    },
  }))
  .superRefine(({ config }, ctx) => {
    const seen = new Set<string>()
    config.limits.forEach((limit, index) => {
      if (seen.has(limit.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["limits", index, "id"],
          message: `duplicate limit id ${limit.id}`,
        })
      }
      seen.add(limit.id)
    })
    if (config.holds.defaultTtlMs > config.holds.maxTtlMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["holds", "defaultTtlMs"],
        message: "defaultTtlMs must not exceed maxTtlMs",
      })
    }
  })

/**
 * A budget's config as the core holds it: amounts in base units, instants in epoch ms, every
 * default filled. Invariants: limit ids are unique and at most MAX_BUDGET_LIMITS; every amount is
 * in [0, AMOUNT_MAX]; MIN_HOLD_TTL_MS <= defaultTtlMs <= maxTtlMs <= MAX_HOLD_TTL_MS; only day,
 * week, and month windows carry an anchor.
 */
export type BudgetConfig = z.output<typeof upsertBudgetInputSchema>["config"]
export type BudgetConfigInput = Omit<z.input<typeof upsertBudgetInputSchema>, "key" | "unit">

/** The wire form of a config; parsing it back returns the same config. */
export function formatBudgetConfig(config: BudgetConfig) {
  return {
    limits: config.limits.map((limit) => ({ ...limit, amount: formatAmount(limit.amount) })),
    holds: { ...config.holds },
    onUnavailable: "deny" as const,
    closesAt: config.closesAt,
  } satisfies BudgetConfigInput
}

export const authorizeBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    amount: budgetAmountInputSchema
      .openapi({
        description:
          "The maximum permitted usage to reserve against every hard limit. Settle final usage up to this amount, or release after confirming zero usage and no continuing work.",
      })
      .transform(toAmount),
    ttlMs: z.number().int().positive().optional().openapi({
      description: `The execution deadline, in milliseconds. Defaults to the budget's holds.defaultTtlMs and must not exceed holds.maxTtlMs. A hold still open at expiry is settled at its full amount, never released: the capacity stays used until its window resets, and a later settle succeeds only for that amount.`,
      example: 60_000,
    }),
    idempotencyKey: budgetIdempotencyKeySchema,
  })
  .strict()

/** The hold id is the idempotency key: the same amount replays, another amount is a conflict. */
export const settleBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    holdId: budgetHoldIdSchema,
    amount: budgetAmountInputSchema
      .openapi({
        description:
          "Final usage after work has stopped. Must not exceed the authorized amount. Settlement returns the unused reservation. An amount above the reservation returns 409 and leaves the hold unchanged.",
      })
      .transform(toAmount),
  })
  .strict()

export const releaseBudgetInputSchema = z
  .object({ key: budgetKeyInputSchema, holdId: budgetHoldIdSchema })
  .strict()

export const chargeBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    amount: budgetAmountInputSchema
      .openapi({ description: "The amount to consume now, checked against every hard limit" })
      .transform(toAmount),
    idempotencyKey: budgetIdempotencyKeySchema,
  })
  .strict()

/** Record accepts usage within RECORD_ACCEPT_WINDOW_MS, and dedupes its key for RECORD_DEDUPE_MS. */
export const recordBudgetInputSchema = chargeBudgetInputSchema
  .extend({
    amount: budgetAmountInputSchema
      .openapi({
        description:
          "The amount to record. It always counts, even past a hard limit; recording after work does not authorize that work retroactively.",
      })
      .transform(toAmount),
    idempotencyKey: budgetIdempotencyKeySchema.openapi({
      description: `Up to 256 characters, usually the event id. For ${describeDuration(RECORD_DEDUPE_MS)}, the same key with the same amount replays instead of counting again, and with another amount returns 409.`,
      example: "evt_01J9Z3",
    }),
    occurredAt: z
      .number()
      .int()
      .nonnegative()
      .openapi({
        description: `When the usage happened, in epoch milliseconds: the event's own time, not the time of the call. Must be within the last ${describeDuration(RECORD_ACCEPT_WINDOW_MS)} and at most ${describeDuration(RECORD_FUTURE_SKEW_MS)} ahead. It bounds acceptance only; usage counts in the window it arrives in.`,
        example: 1_792_000_000_000,
      }),
  })
  .strict()

export const getBudgetQuerySchema = z.object({ key: budgetKeyInputSchema })

export const budgetBalanceSchema = z.object({
  remaining: budgetDecimalSchema.nullable().openapi({
    description: "The least remaining over hard limits; null when the budget has no hard limit",
  }),
  held: budgetDecimalSchema.openapi({ description: "The sum of open holds" }),
  limits: z.array(
    z.object({
      id: z.string(),
      window: budgetWindowSchema,
      enforce: budgetEnforceSchema,
      amount: budgetDecimalSchema.openapi({ description: "The limit" }),
      consumed: budgetDecimalSchema.openapi({ description: "Used in the current period" }),
      held: budgetDecimalSchema.openapi({ description: "Held by open holds" }),
      remaining: budgetDecimalSchema.openapi({
        description:
          "amount - consumed - held; negative for a soft limit, or a hard limit a record passed",
      }),
      resetsAt: budgetResetsAtSchema,
    })
  ),
  asOf: budgetEpochMsSchema.openapi({
    description: "When this balance was computed, in epoch milliseconds",
  }),
})

export const budgetSchema = z.object({
  key: z.string(),
  unit: z.string().openapi({
    description: "money:<code>, credits:<id>, or units:<slug>",
    example: "money:USD",
  }),
  version: z.number().int().openapi({
    description: "Increments on every upsert that changes the budget",
  }),
  limits: z.array(
    z.object({
      id: z.string(),
      amount: budgetDecimalSchema,
      window: budgetWindowSchema,
      anchor: budgetEpochMsSchema.optional().openapi({
        description: "The anchor instant of an anchored window, in epoch milliseconds",
      }),
      enforce: budgetEnforceSchema,
    })
  ),
  holds: z.object({ defaultTtlMs: z.number().int(), maxTtlMs: z.number().int() }),
  onUnavailable: z.literal("deny"),
  closesAt: budgetEpochMsSchema
    .nullable()
    .openapi({ description: "When the budget closes, in epoch milliseconds, or null" }),
  closed: z.boolean().openapi({ description: "True from closesAt on" }),
  balance: budgetBalanceSchema,
})

/** One ended period of a window that had usage; `windowId` is the window, or `<window>@<anchor>`. */
export const budgetWindowPeriodSchema = z.object({
  windowId: z.string().openapi({ example: "month" }),
  start: budgetEpochMsSchema.openapi({ description: "Period start, in epoch milliseconds" }),
  end: budgetEpochMsSchema.openapi({
    description: "Period end (exclusive), in epoch milliseconds",
  }),
  consumed: budgetDecimalSchema.openapi({ description: "Used in the period" }),
})

export const upsertBudgetResponseSchema = z.object({
  changes: z
    .array(
      z.object({
        change: z.string().openapi({
          description:
            "limit.added, limit.removed, limit.amount, limit.enforce, limits.order, holds, or closesAt. Creating a budget lists each limit as limit.added.",
          example: "limit.amount",
        }),
        limitId: z.string().optional().openapi({ description: "The limit that changed" }),
        from: z.string().optional().openapi({ description: "The previous value" }),
        to: z.string().optional().openapi({ description: "The new value" }),
      })
    )
    .openapi({ description: "What this upsert changed; empty when it changed nothing" }),
  budget: budgetSchema,
})

export const getBudgetResponseSchema = z.object({
  budget: budgetSchema,
  history: z.array(budgetWindowPeriodSchema).openapi({
    description: `The last ${WINDOW_HISTORY_PERIODS} ended periods with usage of each limited window, newest first. Older periods are not kept.`,
  }),
})

export const authorizeBudgetResponseSchema = z.object({
  allowed: z.literal(true),
  holdId: budgetHoldIdSchema,
  amount: budgetDecimalSchema.openapi({ description: "The amount held" }),
  expiresAt: budgetEpochMsSchema.openapi({
    description:
      "The deadline for work, in epoch milliseconds. A hold still open then is settled at its full amount.",
  }),
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

export const settleBudgetResponseSchema = z.object({
  holdId: budgetHoldIdSchema,
  actual: budgetDecimalSchema.openapi({ description: "The amount settled" }),
  released: budgetDecimalSchema.openapi({ description: "The unused part of the hold, returned" }),
  expired: z.boolean().openapi({ description: "Settled at or after the hold's expiresAt" }),
  crossed: budgetCrossedSchema,
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

export const releaseBudgetResponseSchema = z.object({
  holdId: budgetHoldIdSchema,
  released: budgetDecimalSchema.openapi({
    description: "The amount returned: the whole hold",
  }),
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

export const chargeBudgetResponseSchema = z.object({
  allowed: z.literal(true),
  amount: budgetDecimalSchema.openapi({ description: "The amount consumed" }),
  crossed: budgetCrossedSchema,
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

export const recordBudgetResponseSchema = z.object({
  amount: budgetDecimalSchema.openapi({ description: "The amount consumed" }),
  crossed: budgetCrossedSchema,
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

/** `details` on a 402: the limit that blocked the request and what would let it through. */
export const budgetExceededDetailsSchema = z.object({
  kind: z.literal("budget_exceeded"),
  blocked: z
    .object({
      limitId: z.string(),
      window: budgetWindowSchema,
      remaining: budgetDecimalSchema,
      held: budgetDecimalSchema,
      resetsAt: budgetResetsAtSchema,
      remedy: z.enum(["release_holds", "wait_for_reset", "raise_limit"]).openapi({
        description:
          "release_holds: releasing holds makes the request fit all failing limits. wait_for_reset: resetting the failing windows makes the request fit with holds unchanged. raise_limit: neither action alone is sufficient; one or more limits need a change.",
      }),
    })
    .openapi({
      description:
        "A failing hard limit smaller than the request, or otherwise the one that resets last. Other limits can also block the request. The remedy considers all failing limits.",
    }),
  balance: budgetBalanceSchema,
})

/** `details` on a 409 for a budget past its `closesAt`. */
export const budgetClosedDetailsSchema = z.object({
  kind: z.literal("budget_closed"),
  closedAt: budgetEpochMsSchema.openapi({
    description: "When the budget closed, in epoch milliseconds",
  }),
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

export const budgetHoldAmountExceededDetailsSchema = z.object({
  kind: z.literal("hold_amount_exceeded"),
  holdId: budgetHoldIdSchema,
  maximum: budgetDecimalSchema,
  actual: budgetDecimalSchema,
})

export const budgetLimitBelowUsageDetailsSchema = z.object({
  kind: z.literal("limit_below_usage"),
  limitId: z.string(),
  minimum: budgetDecimalSchema,
  requested: budgetDecimalSchema,
})

export const budgetWindowCapacityExceededDetailsSchema = z.object({
  kind: z.literal("window_capacity_exceeded"),
  maximum: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
})
