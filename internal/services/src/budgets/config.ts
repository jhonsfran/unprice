/** Budget config (ADR-0006 B1): the parsed limits and hold settings, and the audit of an upsert. */

import { MAX_BUDGET_LIMITS } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { type Amount, formatAmount, parseAmount } from "@unprice/money"
import { z } from "zod"
import { UnPriceBudgetError } from "./model"
import { BUDGET_WINDOWS, type BudgetWindow } from "./windows"

export const MIN_HOLD_TTL_MS = 1_000
export const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1000
export const MAX_HOLD_TTL_MS = 24 * 60 * 60 * 1000
/** RFC 4006 Tcc: an expired hold keeps counting for this many TTLs before it lapses. */
export const HOLD_LAPSE_TTL_MULTIPLIER = 2
/**
 * Closed holds, lapsed holds, and charge/record rows are kept this long after they close. They
 * are the idempotency record and the tombstone that answers replays and late settles; after it, a
 * hold is retired and can no longer be settled or released.
 */
export const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000

const amountSchema = z.string().transform((text, ctx): Amount => {
  const parsed = parseAmount(text)
  if (parsed.ok) return parsed.amount
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid amount: ${parsed.reason}` })
  return z.NEVER
})

const ttlSchema = z.number().int().min(MIN_HOLD_TTL_MS).max(MAX_HOLD_TTL_MS)

const budgetLimitSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, "letters, digits and _ . : -"),
  amount: amountSchema,
  window: z.enum(BUDGET_WINDOWS),
  enforce: z.enum(["hard", "soft"]).default("hard"),
})

/**
 * Invariants:
 * - limit ids are unique, at most MAX_BUDGET_LIMITS limits
 * - every amount is a parsed `Amount` in [0, AMOUNT_MAX]
 * - MIN_HOLD_TTL_MS <= defaultTtlMs <= maxTtlMs <= MAX_HOLD_TTL_MS
 * Usage is counted per canonical window, not per limit, so renaming a limit, changing its window,
 * or removing and re-adding it never resets or forgets consumption.
 */
export const budgetConfigSchema = z
  .object({
    limits: z.array(budgetLimitSchema).max(MAX_BUDGET_LIMITS),
    holds: z
      .object({
        defaultTtlMs: ttlSchema.default(DEFAULT_HOLD_TTL_MS),
        maxTtlMs: ttlSchema.default(MAX_HOLD_TTL_MS),
      })
      .default({}),
    /** Stored here and applied by the SDK (B9). The core never reads it. */
    onUnavailable: z
      .union([z.enum(["deny", "allow"]), z.object({ allowUpTo: amountSchema })])
      .default("deny"),
  })
  .superRefine((config, ctx) => {
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

export type BudgetConfig = z.output<typeof budgetConfigSchema>
export type BudgetConfigInput = z.input<typeof budgetConfigSchema>
export type BudgetLimit = BudgetConfig["limits"][number]

export function parseBudgetConfig(input: unknown): Result<BudgetConfig, UnPriceBudgetError> {
  const parsed = budgetConfigSchema.safeParse(input)
  if (parsed.success) return Ok(parsed.data)
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  return Err(new UnPriceBudgetError({ code: "INVALID_CONFIG", issues }))
}

/** The JSON-safe form of a config; `parseBudgetConfig(formatBudgetConfig(c))` returns `c`. */
export function formatBudgetConfig(config: BudgetConfig): BudgetConfigInput {
  return {
    limits: config.limits.map((limit) => ({ ...limit, amount: formatAmount(limit.amount) })),
    holds: { ...config.holds },
    onUnavailable:
      typeof config.onUnavailable === "string"
        ? config.onUnavailable
        : { allowUpTo: formatAmount(config.onUnavailable.allowUpTo) },
  }
}

export type BudgetRecord = Readonly<{
  key: string
  projectId: string
  /** `money:<ISO currency> | credits:<id> | units:<slug>`, validated at the API boundary. */
  unit: string
  version: number
  config: BudgetConfig
}>

/** Audit trail of an upsert (B1: changing `enforce` writes an audit entry). */
export type ConfigChange =
  | Readonly<{ change: "limit.added"; limitId: string }>
  | Readonly<{ change: "limit.removed"; limitId: string }>
  | Readonly<{ change: "limit.amount"; limitId: string; from: Amount; to: Amount }>
  | Readonly<{ change: "limit.window"; limitId: string; from: BudgetWindow; to: BudgetWindow }>
  | Readonly<{
      change: "limit.enforce"
      limitId: string
      from: BudgetLimit["enforce"]
      to: BudgetLimit["enforce"]
    }>
  | Readonly<{ change: "limits.order" }>
  | Readonly<{ change: "holds" }>
  | Readonly<{ change: "onUnavailable" }>

export function diffConfig(prev: BudgetConfig, next: BudgetConfig): ConfigChange[] {
  const changes: ConfigChange[] = []
  const prevById = new Map(prev.limits.map((limit) => [limit.id, limit]))
  const nextIds = new Set(next.limits.map((limit) => limit.id))

  for (const limit of next.limits) {
    const before = prevById.get(limit.id)
    if (!before) {
      changes.push({ change: "limit.added", limitId: limit.id })
      continue
    }
    if (before.amount !== limit.amount) {
      changes.push({
        change: "limit.amount",
        limitId: limit.id,
        from: before.amount,
        to: limit.amount,
      })
    }
    if (before.window !== limit.window) {
      changes.push({
        change: "limit.window",
        limitId: limit.id,
        from: before.window,
        to: limit.window,
      })
    }
    if (before.enforce !== limit.enforce) {
      changes.push({
        change: "limit.enforce",
        limitId: limit.id,
        from: before.enforce,
        to: limit.enforce,
      })
    }
  }
  for (const limit of prev.limits) {
    if (!nextIds.has(limit.id)) changes.push({ change: "limit.removed", limitId: limit.id })
  }

  const kept = prev.limits.filter((limit) => nextIds.has(limit.id)).map((limit) => limit.id)
  const keptInNext = next.limits.filter((limit) => prevById.has(limit.id)).map((limit) => limit.id)
  if (kept.join("\n") !== keptInNext.join("\n")) changes.push({ change: "limits.order" })

  if (
    prev.holds.defaultTtlMs !== next.holds.defaultTtlMs ||
    prev.holds.maxTtlMs !== next.holds.maxTtlMs
  ) {
    changes.push({ change: "holds" })
  }
  if (!sameUnavailable(prev.onUnavailable, next.onUnavailable)) {
    changes.push({ change: "onUnavailable" })
  }
  return changes
}

function sameUnavailable(
  a: BudgetConfig["onUnavailable"],
  b: BudgetConfig["onUnavailable"]
): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b
  return a.allowUpTo === b.allowUpTo
}
