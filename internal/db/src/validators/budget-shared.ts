import { AMOUNT_PATTERN, type Amount, parseAmount } from "@unprice/money"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"

extendZodWithOpenApi(z)

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
/**
 * A refused lease answers this long, so a late copy of the request (an HTTP retry sent while the
 * first attempt was still in flight) replays the 402 instead of taking capacity no process holds.
 * Far longer than a copy stays in flight, and far shorter than OPERATION_RETENTION_MS, because a
 * process facing a full budget is refused again every flush interval.
 */
export const LEASE_REFUSAL_RETENTION_MS = 10 * 60 * 1000
/**
 * `record` accepts usage that occurred at most this long ago (`TOO_LATE` beyond it): as long as
 * every other retry stays safe, and short enough that a hot budget's receipts fit its object.
 */
export const RECORD_ACCEPT_WINDOW_MS = 24 * 60 * 60 * 1000
/** `record` rejects `occurredAt` further than this ahead of the budget's clock. */
export const RECORD_FUTURE_SKEW_MS = 5 * 60 * 1000
/**
 * A record's row answers this long: within it a replay never counts again and a changed request
 * under the same key is a conflict. It must exceed the accept window plus the skew, so a replay
 * the row no longer catches is already `TOO_LATE`.
 */
export const RECORD_DEDUPE_MS = 25 * 60 * 60 * 1000
/** `get` returns this many ended periods per limited window, newest first; no more are kept. */
export const WINDOW_HISTORY_PERIODS = 12
/**
 * A budget with a `closesAt` deletes its storage this long after it closes, once no row is left to
 * settle, purge, or replay. Until then the closed budget stays readable.
 */
export const CLOSED_BUDGET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

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
export function toAmount(text: string, ctx: z.RefinementCtx): Amount {
  const parsed = parseAmount(text)
  if (parsed.ok) return parsed.amount
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid amount: ${parsed.reason}` })
  return z.NEVER
}

export const budgetDecimalSchema = z
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

export const budgetEnforceSchema = z.enum(["hard", "soft"]).openapi({
  description:
    "hard denies authorize and charge that would exceed the limit; soft never denies. Either kind is reported in `crossed` once usage passes it, and only a record can pass a hard limit.",
  example: "hard",
})

export const budgetIdempotencyKeySchema = z.string().min(1).max(256).openapi({
  description:
    "Up to 256 characters. A retry with the same key and the same request replays the first answer; the same key with a different request returns 409.",
  example: "run_8f2c:step_3",
})

/** Every instant on the wire is epoch milliseconds, like the rest of the API. */
export const budgetEpochMsSchema = z.number().int()

export const budgetInstantInputSchema = budgetEpochMsSchema.nonnegative()

export const budgetTtlInputSchema = z.number().int().min(MIN_HOLD_TTL_MS).max(MAX_HOLD_TTL_MS)

export const budgetResetsAtSchema = budgetEpochMsSchema.nullable().openapi({
  description: "When the limit's current period ends, in epoch milliseconds; null for never",
})

export const budgetReplayedSchema = z.boolean().openapi({
  description: "True when this answer replays an earlier request instead of applying it again",
})

export const budgetCrossedSchema = z.array(z.string()).openapi({
  description:
    "Limit ids whose consumed amount first exceeded the limit's amount. A hard limit crosses only after recorded usage took its room. Reservations do not trigger crossings. Replays preserve the original result.",
})

/** The limit that blocked a request and what would let it through. */
export const budgetBlockedSchema = z
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
  })

export const budgetLeaseKeySchema = z
  .string()
  .min(1)
  .max(256)
  .openapi({
    description: `Up to 256 characters, one per lease, chosen by the client. Retrying a grant with the same key, amount, and ttlMs replays it, and replays a 402 for ${describeDuration(LEASE_REFUSAL_RETENTION_MS)}; another amount or ttlMs returns 409. Lease keys and idempotency keys are separate.`,
    example: "lease_01J9Z3",
  })
