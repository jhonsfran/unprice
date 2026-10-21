import { formatAmount } from "@unprice/money"
import { z } from "zod"
import {
  BUDGET_ANCHORED_WINDOWS,
  CLOSED_BUDGET_RETENTION_MS,
  DEFAULT_HOLD_TTL_MS,
  MAX_BUDGET_LIMITS,
  MAX_HOLD_TTL_MS,
  MIN_HOLD_TTL_MS,
  OPERATION_RETENTION_MS,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_DEDUPE_MS,
  RECORD_FUTURE_SKEW_MS,
  WINDOW_HISTORY_PERIODS,
  budgetAmountInputSchema,
  budgetBlockedSchema,
  budgetCrossedSchema,
  budgetDecimalSchema,
  budgetEnforceSchema,
  budgetEpochMsSchema,
  budgetHoldIdSchema,
  budgetIdempotencyKeySchema,
  budgetInstantInputSchema,
  budgetKeyInputSchema,
  budgetLeaseKeySchema,
  budgetReplayedSchema,
  budgetResetsAtSchema,
  budgetTtlInputSchema,
  budgetWindowSchema,
  describeDuration,
  toAmount,
} from "./budget-shared"

export {
  BUDGET_WINDOWS,
  BUDGET_ANCHORED_WINDOWS,
  MAX_BUDGET_LIMITS,
  MAX_RETAINED_ANCHORED_WINDOWS,
  MIN_HOLD_TTL_MS,
  DEFAULT_HOLD_TTL_MS,
  MAX_HOLD_TTL_MS,
  OPERATION_RETENTION_MS,
  LEASE_REFUSAL_RETENTION_MS,
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_FUTURE_SKEW_MS,
  RECORD_DEDUPE_MS,
  WINDOW_HISTORY_PERIODS,
  CLOSED_BUDGET_RETENTION_MS,
  describeDuration,
  budgetKeyInputSchema,
  budgetAmountInputSchema,
  budgetHoldIdSchema,
  budgetWindowSchema,
} from "./budget-shared"

// The one definition of the budget wire contract. Input schemas parse straight into the core's
// types (amounts in base units, instants in epoch ms), and `@unprice/services/budgets` imports the
// window lists, the limit cap, and the timing constants from here, so the descriptions below
// always state the values the core enforces. Everything is trusted after this boundary.

const budgetDefinitionFields = {
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
      description: `When the budget closes, in epoch milliseconds. From then on authorize and charge return 409, record is accepted for ${describeDuration(OPERATION_RETENTION_MS)} more, and settle and release keep working. ${describeDuration(CLOSED_BUDGET_RETENTION_MS)} after closesAt, once nothing is left to settle or replay, the budget is deleted: get returns 404 and an upsert creates it anew. An upsert replaces the whole definition, so omitting closesAt or sending null leaves the budget open and clears any close time it had. A runtime key cannot close a budget in the past: an earlier closesAt takes effect now.`,
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
}

const budgetDefinitionObject = z.object(budgetDefinitionFields).strict()

function toBudgetDefinition({
  unit,
  limits,
  holds,
  onUnavailable,
  closesAt,
}: z.output<typeof budgetDefinitionObject>) {
  return {
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
  }
}

function withValidLimits(
  { config }: ReturnType<typeof toBudgetDefinition>,
  ctx: z.RefinementCtx
): void {
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
}

/** A budget without its key: what an upsert sends, and what `ifMissing` creates. */
export const budgetDefinitionInputSchema = budgetDefinitionObject
  .transform(toBudgetDefinition)
  .superRefine(withValidLimits)

export const upsertBudgetInputSchema = z
  .object({ key: budgetKeyInputSchema, ...budgetDefinitionFields })
  .strict()
  .transform(({ key, ...definition }) => ({ key, ...toBudgetDefinition(definition) }))
  .superRefine(withValidLimits)

const ifMissingSchema = budgetDefinitionInputSchema.optional().openapi({
  description:
    "The budget to create when the key has none: an upsert body without the key, created as a runtime key would. An existing budget ignores it and is never changed by it. The reply says created: true when this call created the budget.",
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
    ifMissing: ifMissingSchema,
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

const chargeFields = {
  key: budgetKeyInputSchema,
  amount: budgetAmountInputSchema
    .openapi({ description: "The amount to consume now, checked against every hard limit" })
    .transform(toAmount),
  idempotencyKey: budgetIdempotencyKeySchema,
}

export const chargeBudgetInputSchema = z
  .object({ ...chargeFields, ifMissing: ifMissingSchema })
  .strict()

/** Record accepts usage within RECORD_ACCEPT_WINDOW_MS, and dedupes its key for RECORD_DEDUPE_MS. */
export const recordBudgetInputSchema = z
  .object(chargeFields)
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
        description: `When the usage happened, in epoch milliseconds: the event's own time, not the time of the call. Must be at most ${describeDuration(RECORD_ACCEPT_WINDOW_MS)} old and at most ${describeDuration(RECORD_FUTURE_SKEW_MS)} ahead. It bounds acceptance only; usage counts in the window it arrives in.`,
        example: 1_792_000_000_000,
      }),
  })
  .strict()

export const getBudgetQuerySchema = z.object({ key: budgetKeyInputSchema })

export const budgetBalanceSchema = z.object({
  remaining: budgetDecimalSchema.nullable().openapi({
    description: "The least remaining over hard limits; null when the budget has no hard limit",
  }),
  held: budgetDecimalSchema.openapi({
    description: "The sum of open holds and the unreported part of open leases",
  }),
  limits: z.array(
    z.object({
      id: z.string(),
      window: budgetWindowSchema,
      enforce: budgetEnforceSchema,
      amount: budgetDecimalSchema.openapi({ description: "The limit" }),
      consumed: budgetDecimalSchema.openapi({ description: "Used in the current period" }),
      held: budgetDecimalSchema.openapi({ description: "Held by open holds and leases" }),
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

const operationCount = z.number().int().nonnegative()

/** Accepted calls that changed the budget, per verb, since it was created. */
export const budgetOperationsSchema = z
  .object({
    upsert: operationCount,
    authorize: operationCount,
    settle: operationCount,
    release: operationCount,
    charge: operationCount,
    record: operationCount,
    lease: operationCount,
    report: operationCount,
  })
  .openapi({
    description:
      "Accepted calls that changed the budget, per verb, since it was created. Replays, rejections, reads, upserts that changed nothing, and holds and leases the alarm closed at expiry are not counted.",
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
  operations: budgetOperationsSchema,
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

const budgetCreatedSchema = z.boolean().openapi({
  description: "Whether this call created the budget from its ifMissing",
  example: false,
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
  created: budgetCreatedSchema,
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
  created: budgetCreatedSchema,
})

export const recordBudgetResponseSchema = z.object({
  amount: budgetDecimalSchema.openapi({ description: "The amount consumed" }),
  crossed: budgetCrossedSchema,
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

export const budgetExceededDetailsSchema = z.object({
  kind: z.literal("budget_exceeded"),
  blocked: budgetBlockedSchema,
  balance: budgetBalanceSchema,
})

/** `details` on a 409 for a budget past its `closesAt`. */
export const budgetClosedDetailsSchema = z.object({
  kind: z.literal("budget_closed"),
  closedAt: budgetEpochMsSchema.openapi({
    description: "When the budget closed, in epoch milliseconds",
  }),
})

export const leaseBudgetInputSchema = z
  .object({
    key: budgetKeyInputSchema,
    leaseKey: budgetLeaseKeySchema,
    amount: budgetAmountInputSchema
      .openapi({
        description:
          "Capacity to debit now against every hard limit and spend locally. Near a limit less is granted; when nothing fits, 402.",
      })
      .transform(toAmount),
    ttlMs: z
      .number()
      .int()
      .positive()
      .openapi({
        description: `How long the lease lives without a report, in milliseconds: at least ${MIN_HOLD_TTL_MS} and at most the budget's holds.maxTtlMs. A report renews it once less than half remains. A lease still open at expiry counts its whole grant as used until the window resets.`,
        example: 60_000,
      }),
    ifMissing: ifMissingSchema,
  })
  .strict()

const reportFields = {
  key: budgetKeyInputSchema,
  leaseKey: budgetLeaseKeySchema,
  seq: z.number().int().positive().openapi({
    description:
      "1 for the first report on a lease, then one more each time. Resending the last seq with the same body replays its answer; any other seq returns 409.",
    example: 1,
  }),
  captured: budgetAmountInputSchema
    .openapi({
      description:
        "Usage spent from the lease so far, cumulative: never below the last report and never above the grant. A lost report is covered by the next.",
    })
    .transform(toAmount),
}

export const reportBudgetInputSchema = z.discriminatedUnion("final", [
  z
    .object({
      ...reportFields,
      final: z.literal(false),
      extend: budgetAmountInputSchema
        .openapi({
          description:
            "More capacity to add to the lease. Near a hard limit less is granted, and the capture still applies.",
        })
        .transform(toAmount),
    })
    .strict(),
  z
    .object({
      ...reportFields,
      final: z.literal(true).openapi({
        description:
          "Closes the lease: counts `captured` and returns the rest of the grant. After expiresAt only a final report is accepted, until the expired lease is counted.",
      }),
    })
    .strict(),
])

const budgetLeaseSchema = z.object({
  leaseKey: z.string(),
  seq: z
    .number()
    .int()
    .nonnegative()
    .openapi({ description: "The last report applied; 0 before the first" }),
  granted: budgetDecimalSchema.openapi({
    description: "Debited for this lease so far: the grant plus every extension",
  }),
  captured: budgetDecimalSchema.openapi({ description: "Usage reported so far" }),
  expiresAt: budgetEpochMsSchema.openapi({
    description:
      "When the lease expires without a report, in epoch milliseconds. At expiry its whole grant counts as used.",
  }),
  status: z.enum(["open", "closed", "expired"]),
})

const budgetLeaseTermsSchema = z
  .object({
    holds: z.object({ defaultTtlMs: z.number().int(), maxTtlMs: z.number().int() }),
    closesAt: budgetEpochMsSchema.nullable(),
  })
  .openapi({
    description: "The budget's hold TTL bounds and close time, so holds spent locally follow them",
  })

export const leaseBudgetResponseSchema = z.object({
  lease: budgetLeaseSchema,
  terms: budgetLeaseTermsSchema,
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
  created: budgetCreatedSchema,
})

export const reportBudgetResponseSchema = z.object({
  lease: budgetLeaseSchema,
  terms: budgetLeaseTermsSchema,
  extension: z.object({
    requested: budgetDecimalSchema,
    granted: budgetDecimalSchema,
    denied: z
      .discriminatedUnion("kind", [budgetExceededDetailsSchema, budgetClosedDetailsSchema])
      .optional()
      .openapi({
        description:
          "Why less than requested was granted, shaped like the error details of a denied charge; absent when all of it was",
      }),
  }),
  released: budgetDecimalSchema.openapi({
    description: "A final report's unused grant, returned; 0 otherwise",
  }),
  crossed: budgetCrossedSchema,
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

export type UpsertBudgetInput = z.infer<typeof upsertBudgetInputSchema>
export type AuthorizeBudgetInput = z.infer<typeof authorizeBudgetInputSchema>
export type SettleBudgetInput = z.infer<typeof settleBudgetInputSchema>
export type ReleaseBudgetInput = z.infer<typeof releaseBudgetInputSchema>
export type ChargeBudgetInput = z.infer<typeof chargeBudgetInputSchema>
export type RecordBudgetInput = z.infer<typeof recordBudgetInputSchema>
export type BudgetBalanceResponse = z.infer<typeof budgetBalanceSchema>
export type BudgetResponse = z.infer<typeof budgetSchema>
export type BudgetOperations = z.infer<typeof budgetOperationsSchema>
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

export type ReleaseBudgetResponse = z.infer<typeof releaseBudgetResponseSchema>
