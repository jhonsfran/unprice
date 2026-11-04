/**
 * Compiles a customer's subscription into its payer budget (ADR-0008 D1): the budget config billing
 * upserts at `unprice:customer:<customerId>`, and the statements it registers. Pure: the sync use
 * case loads the source and sends the result to the budget.
 */

import {
  type BudgetStatementRegistration,
  RECORD_ACCEPT_WINDOW_MS,
  billingConfigSchema,
  budgetStatementRegistrationSchema,
  calculateCycleWindow,
  creditLinePolicySchema,
  currencySchema,
  featureSlugSchema,
  includedUnitsSchema,
  meterConfigSchema,
  overageStrategySchema,
  rateCardUnitSchema,
  resetConfigSchema,
  typeFeatureSchema,
  upsertBudgetInternalInputSchema,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import { windowIdOf, windowSpecOf } from "../../budgets"
import { DomainError, type DomainErrorKind } from "../../domain-error-kind"

/** The budget key billing writes for a customer; a public call may never define one. */
export function payerBudgetKey(customerId: string): string {
  return `unprice:customer:${customerId}`
}

/**
 * Hold timing of every payer budget. A pricing change waits for open holds to close, so the max
 * TTL bounds how long the compile retries one (ADR-0008 D1).
 */
export const PAYER_HOLDS = { defaultTtlMs: 5 * 60 * 1000, maxTtlMs: 15 * 60 * 1000 } as const

const instantSchema = z.number().int().nonnegative()

const payerFeatureSchema = z.object({
  slug: featureSlugSchema,
  featureType: typeFeatureSchema,
  meterConfig: meterConfigSchema.nullable(),
  included: includedUnitsSchema,
  billingConfig: billingConfigSchema,
  resetConfig: resetConfigSchema.nullable(),
  overageStrategy: overageStrategySchema,
})

/** A billing period of one item: its statement in the payer budget. */
const payerBillingPeriodSchema = z.object({
  id: z.string().min(1),
  statementKey: z.string().min(1),
  start: instantSchema,
  end: instantSchema,
})

const payerPhaseSchema = z.object({
  id: z.string().min(1),
  startAt: instantSchema,
  endAt: instantSchema.nullable(),
  /** The numeric billing anchor the phase resolved at creation. */
  billingAnchor: z.number().int(),
  creditLinePolicy: creditLinePolicySchema,
  currency: currencySchema,
  /** The plan version's card in the phase's currency; null when the plan prices nothing. */
  card: z.object({ id: z.string().min(1), unit: rateCardUnitSchema }).nullable(),
  items: z.array(
    z.object({
      feature: payerFeatureSchema,
      billingPeriods: z.array(payerBillingPeriodSchema),
    })
  ),
})

/** A grant of a feature's quantity; a null allowance is unlimited. */
const payerGrantSchema = z.object({
  featureSlug: featureSlugSchema,
  allowanceUnits: z.number().int().nonnegative().nullable(),
  effectiveAt: instantSchema,
  expiresAt: instantSchema.nullable(),
})

/** What a payer budget compiles from: the customer's phases, their items, and their grants. */
export const payerBudgetSourceSchema = z.object({
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  now: instantSchema,
  phases: z.array(payerPhaseSchema),
  grants: z.array(payerGrantSchema),
})

export type PayerBudgetSource = z.input<typeof payerBudgetSourceSchema>
type Source = z.output<typeof payerBudgetSourceSchema>
type Phase = Source["phases"][number]
type PayerFeature = z.output<typeof payerFeatureSchema>

/** The internal upsert of the payer budget and the statements to register after it. */
export type CompiledPayerBudget = Readonly<{
  budget: z.output<typeof upsertBudgetInternalInputSchema>
  statements: BudgetStatementRegistration[]
  /** The phase the budget's limits and pricing come from. */
  phaseId: string
}>

export type PayerBudgetIssue =
  | Readonly<{ code: "NO_PHASE"; customerId: string }>
  | Readonly<{ code: "UNSUPPORTED_AGGREGATION"; featureSlug: string; aggregationMethod: string }>
  | Readonly<{ code: "UNSUPPORTED_RESET"; featureSlug: string; interval: string; count: number }>
  | Readonly<{ code: "PREPAID_NEEDS_MONEY"; unit: string }>
  | Readonly<{ code: "INVALID_BUDGET"; message: string }>

const KIND: Record<PayerBudgetIssue["code"], DomainErrorKind> = {
  NO_PHASE: "not_found",
  UNSUPPORTED_AGGREGATION: "precondition",
  UNSUPPORTED_RESET: "precondition",
  PREPAID_NEEDS_MONEY: "precondition",
  INVALID_BUDGET: "internal",
}

function describe(issue: PayerBudgetIssue): string {
  switch (issue.code) {
    case "NO_PHASE":
      return `Customer ${issue.customerId} has no subscription phase to compile`
    case "UNSUPPORTED_AGGREGATION":
      return `${issue.featureSlug} aggregates with ${issue.aggregationMethod}; a budget meters sum and count only`
    case "UNSUPPORTED_RESET":
      return `${issue.featureSlug} resets every ${issue.count} ${issue.interval}; a budget limit resets every day, week, or month`
    case "PREPAID_NEEDS_MONEY":
      return `A capped subscription funds from the wallet, which holds money, not ${issue.unit}`
    case "INVALID_BUDGET":
      return `The compiled payer budget is invalid: ${issue.message}`
  }
}

/** A subscription that cannot compile into its payer budget; the next billing job retries it. */
export class UnPricePayerBudgetError extends DomainError<{ code: PayerBudgetIssue["code"] }> {
  public readonly retry = false
  public readonly name = "UnPricePayerBudgetError"
  public readonly code: PayerBudgetIssue["code"]
  public readonly kind: DomainErrorKind

  constructor(public readonly issue: PayerBudgetIssue) {
    super({ message: describe(issue), context: { code: issue.code } })
    this.code = issue.code
    this.kind = KIND[issue.code]
  }
}

function fail(issue: PayerBudgetIssue) {
  return Err(new UnPricePayerBudgetError(issue))
}

/**
 * The payer budget of the phase in force at `now`, or else the next one, or else the last one:
 * - unit: the plan version's card unit for the phase currency, else `money:<currency>`;
 * - one quantity limit per metered feature with a finite grant allowance, on its reset window;
 * - pricing: the card as base, every metered feature (priced when the plan has a card), required
 *   statements, and prepaid funding for a capped phase;
 * - closesAt: the phase's end when no phase follows it;
 * - statements: the billing period of every metered item of every phase, unless it ended before a
 *   late record could still land in it, keyed `<featureSlug>:<billingPeriodId>`.
 */
export function compilePayerBudget(
  input: PayerBudgetSource
): Result<CompiledPayerBudget, UnPricePayerBudgetError> {
  const source = payerBudgetSourceSchema.parse(input)
  const { customerId, now } = source
  const phase = phaseAt(source.phases, now)
  if (!phase) return fail({ code: "NO_PHASE", customerId })

  const unit = phase.card?.unit ?? `money:${phase.currency}`
  const prepaid = phase.creditLinePolicy === "capped"
  if (prepaid && !unit.startsWith("money:")) return fail({ code: "PREPAID_NEEDS_MONEY", unit })

  const features = []
  const limits = []
  for (const { feature } of phase.items) {
    const meter = meterOf(feature)
    if (meter === null) continue
    if (meter.err) return meter
    features.push({
      slug: feature.slug,
      eventSlug: meter.val.eventSlug,
      meterProperty: meter.val.meterProperty,
      dimensions: meter.val.dimensions,
      included: feature.included,
      priced: phase.card !== null,
    })
    const allowance = allowanceOf(source.grants, feature.slug, now)
    if (allowance === null) continue
    const window = windowOf(feature, phase, now)
    if (window.err) return window
    const { anchor } = window.val
    limits.push({
      id: `${feature.slug}:${window.val.window}${anchor === undefined ? "" : `:${anchor}`}`,
      feature: feature.slug,
      amount: String(allowance),
      window: window.val.window,
      ...(anchor !== undefined && { anchor }),
      enforce: feature.overageStrategy === "always" ? ("soft" as const) : ("hard" as const),
    })
  }

  const followed = source.phases.some(
    (other) => phase.endAt !== null && other.id !== phase.id && other.startAt >= phase.endAt
  )
  const parsed = upsertBudgetInternalInputSchema.safeParse({
    key: payerBudgetKey(customerId),
    unit,
    limits,
    holds: PAYER_HOLDS,
    closesAt: followed ? null : phase.endAt,
    pricing: {
      ...(phase.card && { cards: { base: phase.card.id } }),
      features,
      statements: "required",
      funding: prepaid ? { mode: "prepaid", customerId } : { mode: "postpaid" },
    },
  })
  if (!parsed.success) return fail({ code: "INVALID_BUDGET", message: parsed.error.message })

  const statements = statementsOf(source.phases, now)
  if (statements.err) return statements
  return Ok({ budget: parsed.data, statements: statements.val, phaseId: phase.id })
}

function phaseAt(phases: readonly Phase[], now: number): Phase | undefined {
  const byStart = [...phases].sort((a, b) => a.startAt - b.startAt)
  return (
    byStart.find((phase) => phase.startAt <= now && (phase.endAt === null || now < phase.endAt)) ??
    byStart.find((phase) => phase.startAt > now) ??
    byStart[byStart.length - 1]
  )
}

/** How a usage feature's meter reads an event; null for a feature without one. */
function meterOf(feature: PayerFeature) {
  const meter = feature.meterConfig
  if (feature.featureType !== "usage" || meter === null) return null
  const { aggregationMethod } = meter
  if (aggregationMethod !== "sum" && aggregationMethod !== "count") {
    return fail({ code: "UNSUPPORTED_AGGREGATION", featureSlug: feature.slug, aggregationMethod })
  }
  return Ok({
    eventSlug: meter.eventSlug,
    meterProperty: aggregationMethod === "count" ? null : (meter.aggregationField ?? null),
    dimensions: meter.groupBy ?? [],
  })
}

/** The sum of the feature's grants in force at `now`; null when any is unlimited or none is. */
function allowanceOf(grants: Source["grants"], featureSlug: string, now: number): number | null {
  const active = grants.filter(
    (grant) =>
      grant.featureSlug === featureSlug &&
      grant.effectiveAt <= now &&
      (grant.expiresAt === null || now < grant.expiresAt)
  )
  if (active.length === 0) return null
  let total = 0
  for (const grant of active) {
    if (grant.allowanceUnits === null) return null
    total += grant.allowanceUnits
  }
  return total
}

type LimitWindow = Readonly<{ window: "day" | "week" | "month" | "never"; anchor?: number }>

/**
 * A feature's limit resets on its reset cadence, else its billing cadence, anchored where its
 * current cycle ends (always an anchor boundary), as the earliest equivalent instant. A one-time
 * plan never resets.
 */
function windowOf(feature: PayerFeature, phase: Phase, now: number) {
  const reset = feature.resetConfig
  // A phase resolves `dayOfCreation` into its billing anchor once; a reset on the billing interval
  // keeps it, so a plan change mid-cycle keeps the schedule and its count.
  const resetAnchor =
    reset?.resetAnchor === "dayOfCreation" &&
    reset.resetInterval === feature.billingConfig.billingInterval
      ? phase.billingAnchor
      : reset?.resetAnchor
  const cadence = reset
    ? {
        name: reset.name,
        interval: reset.resetInterval,
        intervalCount: reset.resetIntervalCount,
        anchor: resetAnchor ?? reset.resetAnchor,
        planType: reset.planType,
      }
    : {
        name: feature.billingConfig.name,
        interval: feature.billingConfig.billingInterval,
        intervalCount: feature.billingConfig.billingIntervalCount,
        anchor: phase.billingAnchor,
        planType: feature.billingConfig.planType,
      }
  if (cadence.planType === "onetime" || cadence.interval === "onetime") {
    return Ok<LimitWindow>({ window: "never" })
  }
  const { interval } = cadence
  if (
    cadence.intervalCount !== 1 ||
    (interval !== "day" && interval !== "week" && interval !== "month")
  ) {
    return fail({
      code: "UNSUPPORTED_RESET",
      featureSlug: feature.slug,
      interval,
      count: cadence.intervalCount,
    })
  }
  const cycle = calculateCycleWindow({
    effectiveStartDate: phase.startAt,
    effectiveEndDate: null,
    trialEndsAt: null,
    now: Math.max(now, phase.startAt),
    config: cadence,
  })
  if (!cycle || !Number.isFinite(cycle.end)) {
    return fail({ code: "UNSUPPORTED_RESET", featureSlug: feature.slug, interval, count: 1 })
  }
  // The earliest equivalent anchor: the same schedule compiles to the same limit every cycle.
  const { anchor } = windowSpecOf(windowIdOf({ window: interval, anchor: cycle.end }))
  return Ok<LimitWindow>({ window: interval, anchor })
}

function statementsOf(phases: readonly Phase[], now: number) {
  const statements: BudgetStatementRegistration[] = []
  for (const phase of phases) {
    for (const { feature, billingPeriods } of phase.items) {
      if (meterOf(feature) === null) continue
      for (const period of billingPeriods) {
        if (period.end <= now - RECORD_ACCEPT_WINDOW_MS) continue
        const parsed = budgetStatementRegistrationSchema.safeParse({
          periodId: `${feature.slug}:${period.id}`,
          statementKey: period.statementKey,
          featureSlug: feature.slug,
          start: period.start,
          end: period.end,
        })
        if (!parsed.success) return fail({ code: "INVALID_BUDGET", message: parsed.error.message })
        statements.push(parsed.data)
      }
    }
  }
  statements.sort((a, b) => a.start - b.start || (a.periodId < b.periodId ? -1 : 1))
  return Ok(statements)
}
