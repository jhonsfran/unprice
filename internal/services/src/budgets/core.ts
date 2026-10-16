/**
 * Pure budget core (ADR-0006 B1-B3, B7). No clock, no I/O, no crypto.
 *
 * The journal of facts is the source of truth. `decide` owns every policy rule and returns facts
 * or a rejection; `evolve` folds a fact into the projections with arithmetic only. A store keeps
 * three projections folded in the same transaction: the ledger (one row), one row per operation
 * (open hold, closed tombstone, idempotency record), and the entries themselves. Every fact
 * carries its own deltas, so the ledger fold needs neither config nor operation rows, and the
 * ledger and the operation rows are two independent folds that `checkTransition` compares.
 */

import { BaseError, Err, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import { AMOUNT_MAX, type Amount, type SignedAmount, amountSchema, formatAmount } from "./amount"
import { BUDGET_WINDOWS, type BudgetWindow, budgetWindowBounds } from "./windows"

export const MIN_HOLD_TTL_MS = 1_000
export const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1000
export const MAX_HOLD_TTL_MS = 24 * 60 * 60 * 1000
/** RFC 4006 Tcc: an expired hold keeps counting for this many TTLs before it lapses. */
export const HOLD_LAPSE_TTL_MULTIPLIER = 2
/**
 * Closed holds, lapsed holds, and charge/record rows are kept this long after they close. They
 * are the idempotency record and the tombstone that answers replays and late settles.
 */
export const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000
export const MAX_BUDGET_LIMITS = 16

const ZERO = BigInt(0)

// Config

export const budgetKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:/_.@-]{0,127}$/, "letters, digits and : / _ . @ -")

/** `money:<ISO currency> | credits:<id> | units:<slug>`. */
export const budgetUnitSchema = z
  .string()
  .regex(/^(money:[A-Z]{3}|credits:[a-z0-9_-]{1,64}|units:[a-z0-9_-]{1,64})$/)
export type BudgetUnit = z.infer<typeof budgetUnitSchema>

/** Public hold ids are `h_<n>`, minted from `Ledger.holdSeq`. */
export const holdIdSchema = z.string().regex(/^h_[1-9][0-9]{0,15}$/, "hold ids look like h_<n>")

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
  /** Immutable after creation. */
  unit: BudgetUnit
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

// Projections

export type WindowUsage = Readonly<{ start: number; consumed: Amount }>

/**
 * The aggregate: one row, rewritten by every accepted command, O(1) in history.
 * - `seq` is the last journal entry; `lastAt` its time. `transition` clamps its clock to
 *   `lastAt`, so windows only roll forward.
 * - `holdSeq` counts holds ever placed. `h_<n>` with n <= holdSeq was minted.
 * - `held` = sum of `amount` over open holds (including expired ones not yet lapsed).
 * - `usage` has all five canonical windows; `usage.never.consumed` is lifetime consumption.
 */
export type Ledger = Readonly<{
  seq: number
  lastAt: number
  holdSeq: number
  held: Amount
  usage: Readonly<Record<BudgetWindow, WindowUsage>>
}>

export const emptyLedger: Ledger = {
  seq: 0,
  lastAt: 0,
  holdSeq: 0,
  held: ZERO,
  usage: {
    hour: { start: 0, consumed: ZERO },
    day: { start: 0, consumed: ZERO },
    week: { start: 0, consumed: ZERO },
    month: { start: 0, consumed: ZERO },
    never: { start: 0, consumed: ZERO },
  },
}

/**
 * A hold is open until it is settled, released, or lapses. "Expired" is not a stored state: it is
 * `now >= expiresAt` on an open hold, which still counts and still settles normally.
 * Per state: open counts `amount`; lapsed returned `amount`; settled has covered + released =
 * amount (both 0 when late, because the lapse already returned it); released returned `released`.
 */
export type HoldState =
  | Readonly<{ status: "open" }>
  | Readonly<{ status: "lapsed"; lapsedAt: number }>
  | Readonly<{
      status: "settled"
      closedAt: number
      actual: Amount
      covered: Amount
      released: Amount
      overrun: Amount
      late: boolean
      crossed: readonly string[]
    }>
  | Readonly<{ status: "released"; closedAt: number; released: Amount }>

export type HoldOperation = Readonly<{
  kind: "hold"
  id: string
  idempotencyKey: string
  requestHash: string
  amount: Amount
  createdAt: number
  expiresAt: number
  lapsesAt: number
  state: HoldState
}>

/** A charge or record row; id `o_<seq>` of its entry. Pure idempotency record. */
export type ChargeOperation = Readonly<{
  kind: "charge" | "record"
  id: string
  idempotencyKey: string
  requestHash: string
  amount: Amount
  createdAt: number
  crossed: readonly string[]
}>

/** A settle on a minted hold whose row was already purged: consumed as late usage (B3). */
export type LateSettlement = Readonly<{
  kind: "late_settle"
  id: string
  actual: Amount
  createdAt: number
  crossed: readonly string[]
}>

export type Operation = HoldOperation | ChargeOperation | LateSettlement

/**
 * What `transition` reads. Never the full history: only the row the command addresses and the
 * open holds the store found due.
 */
export type BudgetView = Readonly<{
  budget: BudgetRecord | null
  ledger: Ledger
  /**
   * The row this command addresses: by idempotency key for authorize, charge, and record; by hold
   * id for settle and release. Null when it never existed or was purged.
   */
  target: Operation | null
  /** Open holds with `lapsesAt <= max(clock, ledger.lastAt)`, any subset; the alarm sweeps the rest. */
  due: readonly HoldOperation[]
}>

/** Projections after folding: the budget, the ledger, and the rows this transition saw. */
export type BudgetState = Readonly<{
  budget: BudgetRecord | null
  ledger: Ledger
  operations: ReadonlyMap<string, Operation>
}>

// Journal

export type Fact =
  | Readonly<{ type: "budget.configured"; budget: BudgetRecord; changes: readonly ConfigChange[] }>
  | Readonly<{
      type: "hold.placed"
      holdId: string
      idempotencyKey: string
      requestHash: string
      amount: Amount
      expiresAt: number
      lapsesAt: number
      crossed: readonly string[]
    }>
  | Readonly<{ type: "hold.lapsed"; holdId: string; released: Amount }>
  | Readonly<{
      type: "hold.settled"
      holdId: string
      actual: Amount
      /** Consumed out of the hold. */
      covered: Amount
      /** Returned to capacity by this settle (0 when late). */
      released: Amount
      /** Consumed beyond the hold: actual - covered. */
      overrun: Amount
      late: boolean
      crossed: readonly string[]
    }>
  | Readonly<{ type: "hold.released"; holdId: string; released: Amount }>
  | Readonly<{
      type: "charged" | "recorded"
      idempotencyKey: string
      requestHash: string
      amount: Amount
      crossed: readonly string[]
    }>

export type Entry = Readonly<{ seq: number; at: number }> & Fact

/**
 * The single table of ledger effects.
 *
 * | fact               | held                  | consumed |
 * | hold.placed        | +amount               | 0        |
 * | hold.lapsed        | -released             | 0        |
 * | hold.settled       | -(covered + released) | +actual  |
 * | hold.released      | -released             | 0        |
 * | charged, recorded  | 0                     | +amount  |
 * | budget.configured  | 0                     | 0        |
 */
export function ledgerDelta(fact: Fact): { held: SignedAmount; consumed: Amount } {
  switch (fact.type) {
    case "hold.placed":
      return { held: fact.amount, consumed: ZERO }
    case "hold.lapsed":
    case "hold.released":
      return { held: -fact.released, consumed: ZERO }
    case "hold.settled":
      return { held: -(fact.covered + fact.released), consumed: fact.actual }
    case "charged":
    case "recorded":
      return { held: ZERO, consumed: fact.amount }
    case "budget.configured":
      return { held: ZERO, consumed: ZERO }
  }
}

// Commands, outcomes, rejections

export type Cost = Readonly<{ amount: Amount }>

/**
 * `requestHash` is a digest of `requestFingerprint(command)` computed by the caller, so this
 * module stays free of crypto. Settle and release are keyed by hold id and need no hash.
 */
export type BudgetCommand =
  | Readonly<{
      type: "upsert"
      key: string
      projectId: string
      unit: BudgetUnit
      config: BudgetConfig
    }>
  | Readonly<{
      type: "authorize"
      idempotencyKey: string
      requestHash: string
      cost: Cost
      ttlMs?: number
    }>
  | Readonly<{ type: "settle"; holdId: string; cost: Cost }>
  | Readonly<{ type: "release"; holdId: string }>
  | Readonly<{ type: "charge"; idempotencyKey: string; requestHash: string; cost: Cost }>
  | Readonly<{ type: "record"; idempotencyKey: string; requestHash: string; cost: Cost }>
  | Readonly<{ type: "get" }>
  | Readonly<{ type: "sweep" }>

type KeyedCommand = Extract<BudgetCommand, { idempotencyKey: string }>

/**
 * Canonical request text for the idempotency hash. Excludes the key and every clock value, and
 * includes the verb, so one key reused across verbs conflicts.
 */
export function requestFingerprint(
  command: Pick<KeyedCommand, "type" | "cost"> & { ttlMs?: number }
): string {
  const amount = command.cost.amount.toString()
  if (command.type !== "authorize") return `${command.type}|${amount}`
  return `authorize|${amount}|${command.ttlMs ?? "default"}`
}

export type LimitBalance = Readonly<{
  id: string
  window: BudgetWindow
  enforce: BudgetLimit["enforce"]
  amount: Amount
  consumed: Amount
  held: Amount
  remaining: SignedAmount
  /** Start of the next window; null for "never". */
  resetsAt: number | null
}>

export type BudgetBalance = Readonly<{
  /** Minimum over hard limits; null when the budget has no hard limit. */
  remaining: SignedAmount | null
  held: Amount
  limits: readonly LimitBalance[]
  asOf: number
}>

export type BudgetSnapshot = Readonly<{
  key: string
  unit: BudgetUnit
  version: number
  config: BudgetConfig
  balance: BudgetBalance
}>

/** What would let the same request through. */
export type BlockedRemedy = "release_holds" | "wait_for_reset" | "raise_limit"

/** The blocking limit: among failing hard limits, the one that resets last. */
export type Blocked = Readonly<{
  limitId: string
  window: BudgetWindow
  remaining: SignedAmount
  held: Amount
  resetsAt: number | null
  remedy: BlockedRemedy
}>

export type BudgetOutcome =
  | Readonly<{ type: "upsert"; changes: readonly ConfigChange[]; budget: BudgetSnapshot }>
  | Readonly<{ type: "get"; budget: BudgetSnapshot }>
  | Readonly<{
      type: "authorize"
      holdId: string
      amount: Amount
      expiresAt: number
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "settle"
      holdId: string
      actual: Amount
      covered: Amount
      released: Amount
      overrun: Amount
      /** The hold had lapsed (or was purged) before this settle; nothing was covered. */
      late: boolean
      /** Settled at or after `expiresAt`. */
      expired: boolean
      crossed: readonly string[]
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "release"
      holdId: string
      released: Amount
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{
      type: "charge" | "record"
      amount: Amount
      crossed: readonly string[]
      replayed: boolean
      balance: BudgetBalance
    }>
  | Readonly<{ type: "sweep"; lapsed: number }>

export type BudgetRejection =
  | Readonly<{ code: "BUDGET_NOT_FOUND" }>
  | Readonly<{ code: "INVALID_CONFIG"; issues: readonly string[] }>
  | Readonly<{ code: "INVALID_AMOUNT"; amount: string }>
  | Readonly<{ code: "INVALID_TTL"; ttlMs: number; minTtlMs: number; maxTtlMs: number }>
  | Readonly<{ code: "LIMIT_EXCEEDED"; blocked: Blocked; balance: BudgetBalance }>
  | Readonly<{ code: "HOLD_NOT_FOUND"; holdId: string }>
  | Readonly<{ code: "HOLD_CLOSED"; holdId: string; status: "settled" | "released" }>
  | Readonly<{ code: "IDEMPOTENCY_CONFLICT"; idempotencyKey: string }>
  | Readonly<{ code: "UNIT_IMMUTABLE"; current: BudgetUnit; requested: BudgetUnit }>

export type BudgetErrorCode = BudgetRejection["code"]

/** An expected budget failure. `rejection` is plain data and is what crosses an RPC boundary. */
export class UnPriceBudgetError extends BaseError<{ code: BudgetErrorCode }> {
  public readonly retry = false
  public readonly name = "UnPriceBudgetError"
  public readonly code: BudgetErrorCode

  constructor(public readonly rejection: BudgetRejection) {
    super({ message: rejectionMessage(rejection), context: { code: rejection.code } })
    this.code = rejection.code
  }
}

function rejectionMessage(rejection: BudgetRejection): string {
  switch (rejection.code) {
    case "BUDGET_NOT_FOUND":
      return "Budget does not exist"
    case "INVALID_CONFIG":
      return `Invalid budget config: ${rejection.issues.join("; ")}`
    case "INVALID_AMOUNT":
      return `Amount ${rejection.amount} is outside [0, ${AMOUNT_MAX}] base units`
    case "INVALID_TTL":
      return `Hold TTL must be between ${rejection.minTtlMs} and ${rejection.maxTtlMs} ms, got ${rejection.ttlMs}`
    case "LIMIT_EXCEEDED":
      return `Limit ${rejection.blocked.limitId} has ${formatAmount(rejection.blocked.remaining)} remaining`
    case "HOLD_NOT_FOUND":
      return `Hold ${rejection.holdId} does not exist`
    case "HOLD_CLOSED":
      return `Hold ${rejection.holdId} is already ${rejection.status}`
    case "IDEMPOTENCY_CONFLICT":
      return `Idempotency key ${rejection.idempotencyKey} was used with a different request`
    case "UNIT_IMMUTABLE":
      return `Budget unit is ${rejection.current} and cannot change to ${rejection.requested}`
  }
}

function reject(rejection: BudgetRejection): Result<never, UnPriceBudgetError> {
  return Err(new UnPriceBudgetError(rejection))
}

// Reads

/** Pure read at `now` (clamped to `lastAt`). Windows roll virtually; nothing is written. */
function balanceOf(
  state: Readonly<{ budget: BudgetRecord; ledger: Ledger }>,
  now: number
): BudgetBalance {
  const { ledger } = state
  const at = Math.max(now, ledger.lastAt)
  let remaining: SignedAmount | null = null
  const limits = state.budget.config.limits.map((limit): LimitBalance => {
    const bounds = budgetWindowBounds(limit.window, at)
    const usage = ledger.usage[limit.window]
    const consumed = bounds.start > usage.start ? ZERO : usage.consumed
    const limitRemaining = limit.amount - consumed - ledger.held
    if (limit.enforce === "hard" && (remaining === null || limitRemaining < remaining)) {
      remaining = limitRemaining
    }
    return {
      id: limit.id,
      window: limit.window,
      enforce: limit.enforce,
      amount: limit.amount,
      consumed,
      held: ledger.held,
      remaining: limitRemaining,
      resetsAt: bounds.end,
    }
  })
  return { remaining, held: ledger.held, limits, asOf: at }
}

/**
 * Among hard limits that `amount` would push below zero, the one with the latest `resetsAt`
 * (never resets last); ties go to config order. That limit decides when the request can pass.
 */
function blockingLimit(balance: BudgetBalance, amount: Amount): Blocked | null {
  let blocking: LimitBalance | null = null
  for (const limit of balance.limits) {
    if (limit.enforce !== "hard" || limit.remaining - amount >= ZERO) continue
    if (blocking === null || resetsLater(limit.resetsAt, blocking.resetsAt)) blocking = limit
  }
  if (!blocking) return null

  let remedy: BlockedRemedy = "raise_limit"
  if (amount <= blocking.amount) {
    if (blocking.held > ZERO && blocking.remaining + blocking.held - amount >= ZERO) {
      remedy = "release_holds"
    } else if (blocking.window !== "never") {
      remedy = "wait_for_reset"
    }
  }
  return {
    limitId: blocking.id,
    window: blocking.window,
    remaining: blocking.remaining,
    held: blocking.held,
    resetsAt: blocking.resetsAt,
    remedy,
  }
}

function resetsLater(a: number | null, b: number | null): boolean {
  if (b === null) return false
  return a === null || a > b
}

/** Limits (hard and soft) whose remaining moves from >= 0 to < 0 when it changes by `delta`. */
function crossings(balance: BudgetBalance, delta: SignedAmount): string[] {
  return balance.limits
    .filter((limit) => limit.remaining >= ZERO && limit.remaining + delta < ZERO)
    .map((limit) => limit.id)
}

// Decide

/**
 * Policy for one command against a view that `transition` already swept at a clamped `now`.
 * Zero facts with Ok is a read or an idempotent replay. A rejection writes nothing.
 */
export function decide(
  command: BudgetCommand,
  view: Pick<BudgetView, "budget" | "ledger" | "target">,
  now: number
): Result<Fact[], UnPriceBudgetError> {
  if (command.type === "upsert") return decideUpsert(command, view.budget)
  if (command.type === "sweep") return Ok([])
  const budget = view.budget
  if (!budget) return reject({ code: "BUDGET_NOT_FOUND" })
  const state = { budget, ledger: view.ledger }

  switch (command.type) {
    case "get":
      return Ok([])
    case "authorize":
    case "charge":
    case "record":
      return decideKeyed(command, state, view.target, now)
    case "settle":
      return decideSettle(command, state, view.target, now)
    case "release":
      return decideRelease(command, state.ledger, view.target)
  }
}

function decideUpsert(
  command: Extract<BudgetCommand, { type: "upsert" }>,
  budget: BudgetRecord | null
): Result<Fact[], UnPriceBudgetError> {
  const { key, projectId, unit, config } = command
  if (!budget) {
    const changes = config.limits.map((limit) => ({
      change: "limit.added" as const,
      limitId: limit.id,
    }))
    return Ok([
      { type: "budget.configured", budget: { key, projectId, unit, version: 1, config }, changes },
    ])
  }
  if (budget.key !== key || budget.projectId !== projectId) {
    throw new Error(
      `budget ${budget.projectId}/${budget.key} received upsert for ${projectId}/${key}`
    )
  }
  if (budget.unit !== unit) {
    return reject({ code: "UNIT_IMMUTABLE", current: budget.unit, requested: unit })
  }
  const changes = diffConfig(budget.config, config)
  if (changes.length === 0) return Ok([])
  return Ok([
    {
      type: "budget.configured",
      budget: { ...budget, version: budget.version + 1, config },
      changes,
    },
  ])
}

function decideKeyed(
  command: Extract<BudgetCommand, { type: "authorize" | "charge" | "record" }>,
  state: Readonly<{ budget: BudgetRecord; ledger: Ledger }>,
  target: Operation | null,
  now: number
): Result<Fact[], UnPriceBudgetError> {
  const amount = command.cost.amount
  if (amount < ZERO || amount > AMOUNT_MAX) {
    return reject({ code: "INVALID_AMOUNT", amount: amount.toString() })
  }
  if (target) {
    if (target.kind === "late_settle" || target.idempotencyKey !== command.idempotencyKey) {
      throw new Error(`target ${target.id} is not the row for key ${command.idempotencyKey}`)
    }
    const kind = command.type === "authorize" ? "hold" : command.type
    if (target.kind === kind && target.requestHash === command.requestHash) return Ok([])
    return reject({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey: command.idempotencyKey })
  }

  let ttlMs = 0
  if (command.type === "authorize") {
    const { holds } = state.budget.config
    ttlMs = command.ttlMs ?? holds.defaultTtlMs
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_HOLD_TTL_MS || ttlMs > holds.maxTtlMs) {
      return reject({
        code: "INVALID_TTL",
        ttlMs,
        minTtlMs: MIN_HOLD_TTL_MS,
        maxTtlMs: holds.maxTtlMs,
      })
    }
  }

  const balance = balanceOf(state, now)
  if (command.type !== "record") {
    const blocked = blockingLimit(balance, amount)
    if (blocked) return reject({ code: "LIMIT_EXCEEDED", blocked, balance })
  }
  const { idempotencyKey, requestHash } = command
  const crossed = crossings(balance, -amount)

  switch (command.type) {
    case "authorize": {
      const expiresAt = now + ttlMs
      return Ok([
        {
          type: "hold.placed",
          holdId: `h_${state.ledger.holdSeq + 1}`,
          idempotencyKey,
          requestHash,
          amount,
          expiresAt,
          lapsesAt: expiresAt + HOLD_LAPSE_TTL_MULTIPLIER * ttlMs,
          crossed,
        },
      ])
    }
    case "charge":
      return Ok([{ type: "charged", idempotencyKey, requestHash, amount, crossed }])
    case "record":
      return Ok([{ type: "recorded", idempotencyKey, requestHash, amount, crossed }])
  }
}

function decideSettle(
  command: Extract<BudgetCommand, { type: "settle" }>,
  state: Readonly<{ budget: BudgetRecord; ledger: Ledger }>,
  target: Operation | null,
  now: number
): Result<Fact[], UnPriceBudgetError> {
  const { holdId } = command
  const actual = command.cost.amount
  if (actual < ZERO || actual > AMOUNT_MAX) {
    return reject({ code: "INVALID_AMOUNT", amount: actual.toString() })
  }
  assertTargetId(target, holdId)

  let covered = ZERO
  let released = ZERO
  let late = true
  if (!target) {
    if (!wasMinted(holdId, state.ledger)) return reject({ code: "HOLD_NOT_FOUND", holdId })
    // Purged after retention: the hold lapsed or closed long ago, and usage is never dropped.
  } else if (target.kind === "late_settle") {
    if (target.actual === actual) return Ok([])
    return reject({ code: "HOLD_CLOSED", holdId, status: "settled" })
  } else if (target.kind !== "hold") {
    throw new Error(`settle target ${target.id} is a ${target.kind}`)
  } else {
    switch (target.state.status) {
      case "settled":
        if (target.state.actual === actual) return Ok([])
        return reject({ code: "HOLD_CLOSED", holdId, status: "settled" })
      case "released":
        return reject({ code: "HOLD_CLOSED", holdId, status: "released" })
      case "lapsed":
        break
      case "open":
        late = false
        covered = actual < target.amount ? actual : target.amount
        released = target.amount - covered
        break
    }
  }

  const crossed = crossings(balanceOf(state, now), covered + released - actual)
  return Ok([
    {
      type: "hold.settled",
      holdId,
      actual,
      covered,
      released,
      overrun: actual - covered,
      late,
      crossed,
    },
  ])
}

function decideRelease(
  command: Extract<BudgetCommand, { type: "release" }>,
  ledger: Ledger,
  target: Operation | null
): Result<Fact[], UnPriceBudgetError> {
  const { holdId } = command
  assertTargetId(target, holdId)
  if (!target) {
    if (!wasMinted(holdId, ledger)) return reject({ code: "HOLD_NOT_FOUND", holdId })
    // Purged: the hold lapsed or closed long ago, so there is nothing left to release.
    return Ok([])
  }
  if (target.kind === "late_settle")
    return reject({ code: "HOLD_CLOSED", holdId, status: "settled" })
  if (target.kind !== "hold") throw new Error(`release target ${target.id} is a ${target.kind}`)

  switch (target.state.status) {
    case "released":
      return Ok([])
    case "settled":
      return reject({ code: "HOLD_CLOSED", holdId, status: "settled" })
    case "lapsed":
      return Ok([{ type: "hold.released", holdId, released: ZERO }])
    case "open":
      return Ok([{ type: "hold.released", holdId, released: target.amount }])
  }
}

function assertTargetId(target: Operation | null, holdId: string) {
  if (target && target.id !== holdId) {
    throw new Error(`target ${target.id} is not the row for hold ${holdId}`)
  }
}

function wasMinted(holdId: string, ledger: Ledger): boolean {
  const match = /^h_([1-9][0-9]{0,15})$/.exec(holdId)
  return match !== null && Number(match[1]) <= ledger.holdSeq
}

function diffConfig(prev: BudgetConfig, next: BudgetConfig): ConfigChange[] {
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
  const prevUnavailable = formatBudgetConfig(prev).onUnavailable
  const nextUnavailable = formatBudgetConfig(next).onUnavailable
  if (JSON.stringify(prevUnavailable) !== JSON.stringify(nextUnavailable)) {
    changes.push({ change: "onUnavailable" })
  }
  return changes
}

/** Open holds past `lapsesAt`, in lapse order. */
function lapseFacts(operations: Iterable<Operation>, now: number): Fact[] {
  const due: HoldOperation[] = []
  for (const operation of operations) {
    if (
      operation.kind === "hold" &&
      operation.state.status === "open" &&
      operation.lapsesAt <= now
    ) {
      due.push(operation)
    }
  }
  due.sort((a, b) => a.lapsesAt - b.lapsesAt || holdNumber(a.id) - holdNumber(b.id))
  return due.map((hold) => ({ type: "hold.lapsed", holdId: hold.id, released: hold.amount }))
}

function holdNumber(holdId: string): number {
  return Number(holdId.slice(2))
}

// Evolve (arithmetic only)

/** Folds one entry into the ledger. Rolls each window forward only, then applies `ledgerDelta`. */
export function evolveLedger(ledger: Ledger, entry: Entry): Ledger {
  const delta = ledgerDelta(entry)
  const usage = {} as Record<BudgetWindow, WindowUsage>
  for (const window of BUDGET_WINDOWS) {
    const current = ledger.usage[window]
    const start = budgetWindowBounds(window, entry.at).start
    const base = start > current.start ? { start, consumed: ZERO } : current
    usage[window] =
      delta.consumed === ZERO
        ? base
        : { start: base.start, consumed: base.consumed + delta.consumed }
  }
  return {
    seq: entry.seq,
    lastAt: Math.max(ledger.lastAt, entry.at),
    holdSeq: ledger.holdSeq + (entry.type === "hold.placed" ? 1 : 0),
    held: ledger.held + delta.held,
    usage,
  }
}

/** The operation row an entry touches, or null for `budget.configured`. */
function operationIdOf(entry: Entry): string | null {
  switch (entry.type) {
    case "budget.configured":
      return null
    case "charged":
    case "recorded":
      return `o_${entry.seq}`
    default:
      return entry.holdId
  }
}

/** Folds one entry into the operation row it names. */
function evolveOperation(operation: Operation | undefined, entry: Entry): Operation | undefined {
  switch (entry.type) {
    case "budget.configured":
      return operation
    case "hold.placed":
      return {
        kind: "hold",
        id: entry.holdId,
        idempotencyKey: entry.idempotencyKey,
        requestHash: entry.requestHash,
        amount: entry.amount,
        createdAt: entry.at,
        expiresAt: entry.expiresAt,
        lapsesAt: entry.lapsesAt,
        state: { status: "open" },
      }
    case "charged":
    case "recorded":
      return {
        kind: entry.type === "charged" ? "charge" : "record",
        id: `o_${entry.seq}`,
        idempotencyKey: entry.idempotencyKey,
        requestHash: entry.requestHash,
        amount: entry.amount,
        createdAt: entry.at,
        crossed: entry.crossed,
      }
    case "hold.settled":
      if (operation === undefined) {
        return {
          kind: "late_settle",
          id: entry.holdId,
          actual: entry.actual,
          createdAt: entry.at,
          crossed: entry.crossed,
        }
      }
      return withHoldState(operation, entry, {
        status: "settled",
        closedAt: entry.at,
        actual: entry.actual,
        covered: entry.covered,
        released: entry.released,
        overrun: entry.overrun,
        late: entry.late,
        crossed: entry.crossed,
      })
    case "hold.lapsed":
      return withHoldState(operation, entry, { status: "lapsed", lapsedAt: entry.at })
    case "hold.released":
      return withHoldState(operation, entry, {
        status: "released",
        closedAt: entry.at,
        released: entry.released,
      })
  }
}

function withHoldState(
  operation: Operation | undefined,
  entry: Entry,
  state: HoldState
): HoldOperation {
  if (operation?.kind !== "hold") {
    throw new Error(`entry ${entry.seq} (${entry.type}) has no hold row`)
  }
  return { ...operation, state }
}

/** Folds one entry into every projection. Changed rows are new objects; unchanged keep identity. */
export function evolve(state: BudgetState, entry: Entry): BudgetState {
  const id = operationIdOf(entry)
  let operations = state.operations
  if (id !== null) {
    const next = evolveOperation(state.operations.get(id), entry)
    const copy = new Map(state.operations)
    if (next) copy.set(id, next)
    operations = copy
  }
  return {
    budget: entry.type === "budget.configured" ? entry.budget : state.budget,
    ledger: evolveLedger(state.ledger, entry),
    operations,
  }
}

/** Off the hot path: compaction folds old entries into a base; base + tail must equal the ledger. */
export function foldJournal(base: Ledger, tail: Iterable<Entry>): Ledger {
  let ledger = base
  for (const entry of tail) ledger = evolveLedger(ledger, entry)
  return ledger
}

// Conservation (B7.5)

/** Counted against limits: `amount` while open, else 0. */
function heldBy(operation: Operation | undefined): Amount {
  return operation?.kind === "hold" && operation.state.status === "open" ? operation.amount : ZERO
}

function consumedBy(operation: Operation | undefined): Amount {
  if (!operation) return ZERO
  switch (operation.kind) {
    case "hold":
      return operation.state.status === "settled" ? operation.state.actual : ZERO
    case "late_settle":
      return operation.actual
    case "charge":
    case "record":
      return operation.amount
  }
}

/**
 * Violations of the transition invariants; empty when it may commit. O(entries + touched rows).
 * 1. Seqs are contiguous from `before.ledger.seq + 1`; `at` never goes below `lastAt` or back.
 * 2. Two independent folds agree: the ledger's held and lifetime consumed moved by exactly the
 *    sum of `ledgerDelta`, and by exactly the change in `heldBy` and consumption over the rows.
 * 3. Per fact: settle has actual = covered + overrun and, unless late, covered + released = the
 *    hold's amount; a lapse or a release from an open hold returns its whole amount.
 * 4. Held, every window's consumed, and every fact amount are non-negative.
 */
export function checkTransition(
  before: BudgetState,
  entries: readonly Entry[],
  after: BudgetState
): string[] {
  const violations: string[] = []
  let heldDelta = ZERO
  let consumedDelta = ZERO
  let lastAt = before.ledger.lastAt
  const rows = new Map(before.operations)

  entries.forEach((entry, index) => {
    const expectedSeq = before.ledger.seq + index + 1
    if (entry.seq !== expectedSeq) violations.push(`entry seq ${entry.seq} expected ${expectedSeq}`)
    if (entry.at < lastAt) violations.push(`entry ${entry.seq} at ${entry.at} before ${lastAt}`)
    lastAt = Math.max(lastAt, entry.at)

    const delta = ledgerDelta(entry)
    heldDelta += delta.held
    consumedDelta += delta.consumed
    violations.push(...factViolations(entry, rows))

    const id = operationIdOf(entry)
    if (id !== null) {
      const row = evolveOperation(rows.get(id), entry)
      if (row) rows.set(id, row)
    }
  })

  if (after.ledger.seq !== before.ledger.seq + entries.length) {
    violations.push(
      `ledger seq ${after.ledger.seq} after ${entries.length} entries from ${before.ledger.seq}`
    )
  }
  if (after.ledger.held - before.ledger.held !== heldDelta) {
    violations.push(
      `ledger held moved ${after.ledger.held - before.ledger.held}, facts say ${heldDelta}`
    )
  }
  const lifetime = after.ledger.usage.never.consumed - before.ledger.usage.never.consumed
  if (lifetime !== consumedDelta) {
    violations.push(`ledger consumed moved ${lifetime}, facts say ${consumedDelta}`)
  }

  let rowsHeld = ZERO
  let rowsConsumed = ZERO
  for (const id of new Set([...before.operations.keys(), ...after.operations.keys()])) {
    rowsHeld += heldBy(after.operations.get(id)) - heldBy(before.operations.get(id))
    rowsConsumed += consumedBy(after.operations.get(id)) - consumedBy(before.operations.get(id))
  }
  if (rowsHeld !== heldDelta) violations.push(`rows held moved ${rowsHeld}, facts say ${heldDelta}`)
  if (rowsConsumed !== consumedDelta) {
    violations.push(`rows consumed moved ${rowsConsumed}, facts say ${consumedDelta}`)
  }

  if (after.ledger.held < ZERO) violations.push(`ledger held ${after.ledger.held} is negative`)
  for (const window of BUDGET_WINDOWS) {
    if (after.ledger.usage[window].consumed < ZERO) {
      violations.push(`${window} consumed ${after.ledger.usage[window].consumed} is negative`)
    }
  }
  return violations
}

function factViolations(entry: Entry, rows: ReadonlyMap<string, Operation>): string[] {
  const violations: string[] = []
  const negative = (name: string, value: Amount) => {
    if (value < ZERO) violations.push(`entry ${entry.seq} ${name} ${value} is negative`)
  }
  switch (entry.type) {
    case "hold.placed":
    case "charged":
    case "recorded":
      negative("amount", entry.amount)
      break
    case "hold.lapsed":
    case "hold.released": {
      negative("released", entry.released)
      const hold = rows.get(entry.holdId)
      const status = hold?.kind === "hold" ? hold.state.status : "missing"
      const expected = hold?.kind === "hold" && status === "open" ? hold.amount : ZERO
      if (entry.type === "hold.lapsed" && status !== "open") {
        violations.push(`entry ${entry.seq} lapses a ${status} hold`)
      }
      if (entry.released !== expected) {
        violations.push(
          `entry ${entry.seq} released ${entry.released} from a ${status} hold of ${expected}`
        )
      }
      break
    }
    case "hold.settled": {
      negative("covered", entry.covered)
      negative("released", entry.released)
      negative("overrun", entry.overrun)
      if (entry.actual !== entry.covered + entry.overrun) {
        violations.push(`entry ${entry.seq} actual ${entry.actual} != covered + overrun`)
      }
      const hold = rows.get(entry.holdId)
      const open = hold?.kind === "hold" && hold.state.status === "open"
      if (entry.late === open)
        violations.push(`entry ${entry.seq} late=${entry.late} on an open=${open} hold`)
      const amount = open && hold?.kind === "hold" ? hold.amount : ZERO
      if (entry.covered + entry.released !== amount) {
        violations.push(`entry ${entry.seq} covered + released != ${amount}`)
      }
      break
    }
    case "budget.configured":
      break
  }
  return violations
}

// Transition

export type BudgetTransition = Readonly<{
  /** The clamped clock every entry is stamped with. */
  now: number
  entries: readonly Entry[]
  next: BudgetState
  /** Rows created or changed; the store upserts exactly these. */
  operations: readonly Operation[]
  outcome: BudgetOutcome
  /** Earliest `dueAt` among the written rows; the store only ever lowers its alarm to it. */
  wakeAt: number | null
}>

/**
 * The one call a store makes per command:
 * clamp the clock, lapse the due holds it loaded, decide, stamp seqs, fold, check, outcome.
 * A rejection returns Err and the store writes nothing, not even the lapses.
 * A replay is zero command facts; its outcome is read from the row plus the current balance.
 * Throws when an invariant breaks (a programmer error that must abort the transaction).
 */
export function transition(params: {
  view: BudgetView
  command: BudgetCommand
  clockMs: number
}): Result<BudgetTransition, UnPriceBudgetError> {
  const { view, command, clockMs } = params
  if (!Number.isSafeInteger(clockMs)) throw new Error(`clock ${clockMs} is not an integer`)
  const now = Math.max(clockMs, view.ledger.lastAt)

  const loaded = new Map<string, Operation>()
  for (const hold of view.due) loaded.set(hold.id, hold)
  if (view.target) loaded.set(view.target.id, view.target)
  const before: BudgetState = { budget: view.budget, ledger: view.ledger, operations: loaded }

  const lapseEntries = stamp(lapseFacts(loaded.values(), now), view.ledger.seq, now)
  const swept = lapseEntries.reduce(evolve, before)
  const target = view.target ? (swept.operations.get(view.target.id) ?? null) : null

  const decided = decide(command, { budget: swept.budget, ledger: swept.ledger, target }, now)
  if (decided.err) return Err(decided.err)

  const commandEntries = stamp(decided.val, swept.ledger.seq, now)
  const next = commandEntries.reduce(evolve, swept)
  const entries = [...lapseEntries, ...commandEntries]

  const violations = checkTransition(before, entries, next)
  if (violations.length > 0) {
    throw new Error(`budget transition breaks invariants: ${violations.join("; ")}`)
  }

  const operations = [...next.operations.values()].filter(
    (operation) => before.operations.get(operation.id) !== operation
  )
  let wakeAt: number | null = null
  for (const operation of operations) {
    const due = dueAt(operation)
    if (wakeAt === null || due < wakeAt) wakeAt = due
  }

  return Ok({
    now,
    entries,
    next,
    operations,
    outcome: outcomeOf(command, next, commandEntries, target, lapseEntries.length, now),
    wakeAt,
  })
}

function stamp(facts: readonly Fact[], seq: number, at: number): Entry[] {
  return facts.map((fact, index) => ({ ...fact, seq: seq + index + 1, at }))
}

function outcomeOf(
  command: BudgetCommand,
  next: BudgetState,
  entries: readonly Entry[],
  target: Operation | null,
  lapsed: number,
  now: number
): BudgetOutcome {
  if (command.type === "sweep") return { type: "sweep", lapsed }
  const budget = next.budget
  if (!budget) throw new Error(`${command.type} accepted without a budget`)
  const balance = balanceOf({ budget, ledger: next.ledger }, now)
  const replayed = entries.length === 0
  const written = entries[0] ? operationIdOf(entries[0]) : null
  const row = (written === null ? target : next.operations.get(written)) ?? null

  switch (command.type) {
    case "upsert": {
      const fact = entries[0]
      const changes = fact?.type === "budget.configured" ? fact.changes : []
      return { type: "upsert", changes, budget: snapshotOf(budget, balance) }
    }
    case "get":
      return { type: "get", budget: snapshotOf(budget, balance) }
    case "authorize": {
      if (row?.kind !== "hold") throw new Error("authorize produced no hold row")
      const { id: holdId, amount, expiresAt } = row
      return { type: "authorize", holdId, amount, expiresAt, replayed, balance }
    }
    case "charge":
    case "record": {
      if (row?.kind !== command.type) throw new Error(`${command.type} produced no row`)
      return { type: command.type, amount: row.amount, crossed: row.crossed, replayed, balance }
    }
    case "release": {
      const released =
        row?.kind === "hold" && row.state.status === "released" ? row.state.released : ZERO
      return { type: "release", holdId: command.holdId, released, replayed, balance }
    }
    case "settle": {
      const settled = { holdId: command.holdId, replayed, balance, type: "settle" as const }
      if (row?.kind === "late_settle") {
        const { actual, crossed } = row
        return {
          ...settled,
          actual,
          covered: ZERO,
          released: ZERO,
          overrun: actual,
          late: true,
          expired: true,
          crossed,
        }
      }
      if (row?.kind !== "hold" || row.state.status !== "settled") {
        throw new Error(`settle of ${command.holdId} produced no settled row`)
      }
      const { actual, covered, released, overrun, late, crossed, closedAt } = row.state
      const expired = late || closedAt >= row.expiresAt
      return { ...settled, actual, covered, released, overrun, late, expired, crossed }
    }
  }
}

function snapshotOf(budget: BudgetRecord, balance: BudgetBalance): BudgetSnapshot {
  const { key, unit, version, config } = budget
  return { key, unit, version, config, balance }
}

/**
 * When a row next needs attention: an open hold lapses at `lapsesAt`; every other row is purged
 * OPERATION_RETENTION_MS after it closed. A store mirrors this in an indexed `due_at` column.
 */
export function dueAt(operation: Operation): number {
  if (operation.kind !== "hold") return operation.createdAt + OPERATION_RETENTION_MS
  switch (operation.state.status) {
    case "open":
      return operation.lapsesAt
    case "lapsed":
      return operation.state.lapsedAt + OPERATION_RETENTION_MS
    case "settled":
    case "released":
      return operation.state.closedAt + OPERATION_RETENTION_MS
  }
}
