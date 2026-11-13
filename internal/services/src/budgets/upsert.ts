/** Budget upsert rules. */

import type { BudgetPricing } from "@unprice/db/validators"
import { Ok, type Result } from "@unprice/error"
import { type RateCards, validateCard } from "../pricing"
import { balanceOf } from "./balance"
import {
  type BudgetConfig,
  type BudgetRecord,
  type ConfigChange,
  MAX_RETAINED_ANCHORED_WINDOWS,
  closeNoEarlierThanNow,
  diffConfig,
  loosening,
  samePricing,
} from "./config"
import { type Change, unchanged } from "./decide"
import { restartAmounts, trackLimits } from "./ledger"
import { cardsOf } from "./meter"
import type { BudgetCommand, BudgetView } from "./model"
import { type UnPriceBudgetError, reject } from "./rejections"
import { sameMeasure } from "./usage"
import { windowIdOf } from "./windows"

const ZERO = BigInt(0)

type UpsertCommand = Extract<BudgetCommand, { type: "upsert" }>

/**
 * The pricing an upsert leaves the budget with: an existing budget keeps its own unless the caller
 * sets it.
 */
function upsertPricing(
  command: UpsertCommand,
  budget: BudgetRecord | null
): BudgetPricing | undefined {
  return budget && !command.setsPricing ? budget.config.pricing : command.config.pricing
}

/** The pricing and unit facts shared by view loading and the upsert decision. */
export function upsertFacts(command: UpsertCommand, budget: BudgetRecord | null) {
  const pricing = upsertPricing(command, budget)
  const unitChanged =
    budget !== null && command.setsPricing === true && budget.unit !== command.unit
  const pricingChanged = !samePricing(budget?.config.pricing, pricing)
  return { pricing, unitChanged, pricingChanged, reprices: unitChanged || pricingChanged }
}

export function decideUpsert(
  command: UpsertCommand,
  view: Pick<BudgetView, "budget" | "ledger" | "cards" | "reservationsOpen">,
  now: number,
  facts = upsertFacts(command, view.budget)
): Result<Change, UnPriceBudgetError> {
  const { budget, ledger } = view
  const { key, projectId, unit } = command
  const { pricing, reprices, unitChanged, pricingChanged } = facts
  const config = withPricing(command.config, pricing)
  // Only new pricing reaches the cards: each must be cached, price in the budget's unit, and suit
  // its features. Unchanged pricing was checked when it was set.
  const unpriceable =
    config.pricing?.cards && reprices
      ? compatibleCards(config.pricing, unit, view.cards, now)
      : null
  if (!budget) {
    if (unpriceable?.err) return unpriceable
    const changes = config.limits.map((limit) => ({
      change: "limit.added" as const,
      limitId: limit.id,
    }))
    const created = { key, projectId, unit, version: 1, config }
    const usage = trackLimits(ledger.usage, config.limits, now)
    return Ok({ ...unchanged(null), configured: { budget: created, changes, usage, unitChanged } })
  }
  if (budget.key !== key || budget.projectId !== projectId) {
    throw new Error(
      `budget ${budget.projectId}/${budget.key} received upsert for ${projectId}/${key}`
    )
  }
  if (budget.unit !== unit && !unitChanged) {
    return reject({ code: "UNIT_IMMUTABLE", current: budget.unit, requested: unit })
  }
  if (unpriceable?.err) return unpriceable
  // An open hold settles under the pricing, and in the unit, that estimated it; a lease never
  // reaches a statement.
  if (view.reservationsOpen && reprices) {
    return reject({ code: "RESERVATIONS_OPEN" })
  }
  const previous = new Map(budget.config.limits.map((limit) => [limit.id, limit]))
  for (const limit of config.limits) {
    const before = previous.get(limit.id)
    if (!before) continue
    const current = windowIdOf(before)
    const requested = windowIdOf(limit)
    if (current !== requested) {
      return reject({ code: "LIMIT_WINDOW_IMMUTABLE", limitId: limit.id, current, requested })
    }
    if (!sameMeasure(before.measure, limit.measure)) {
      return reject({
        code: "LIMIT_MEASURE_IMMUTABLE",
        limitId: limit.id,
        current: before.measure,
        requested: limit.measure,
      })
    }
  }
  // A removed limit's anchored counter stays until its period ends, so it counts against the bound
  // that keeps the counters every command rewrites small.
  const retained = new Set(Object.keys(ledger.usage).filter((id) => id.includes("@")))
  const requested = new Set(
    config.limits.filter((limit) => limit.anchor !== undefined).map(windowIdOf)
  )
  const added = [...requested].filter((id) => !retained.has(id))
  if (added.length > 0 && retained.size + added.length > MAX_RETAINED_ANCHORED_WINDOWS) {
    return reject({
      code: "WINDOW_CAPACITY_EXCEEDED",
      maximum: MAX_RETAINED_ANCHORED_WINDOWS,
      retained: retained.size,
    })
  }
  const next = command.mayLoosen ? config : closeNoEarlierThanNow(budget.config, config, now)
  const changes: ConfigChange[] = [
    ...(unitChanged ? [{ change: "unit" as const, from: budget.unit, to: unit }] : []),
    ...diffConfig(budget.config, next, pricingChanged),
  ]
  if (changes.length === 0) return Ok(unchanged(null))
  const loosened = command.mayLoosen ? null : loosening(budget.config, next, pricingChanged)
  if (loosened) return reject({ code: "LOOSENING_FORBIDDEN", change: loosened })
  const updated = { ...budget, unit, version: budget.version + 1, config: next }
  const counters = unitChanged ? restartAmounts(ledger.usage) : ledger.usage
  const usage = trackLimits(counters, next.limits, now)
  const counted = { ...ledger, usage }
  const balance = balanceOf({ budget: updated, ledger: counted }, now)
  for (const limit of balance.limits) {
    // A record may already have passed a hard limit; an upsert may keep or raise it, never tighten.
    const before = previous.get(limit.id)
    const tightened = before?.enforce !== "hard" || limit.amount < before.amount
    if (limit.enforce === "hard" && limit.remaining < ZERO && tightened) {
      return reject({
        code: "LIMIT_BELOW_USAGE",
        limitId: limit.id,
        minimum: limit.consumed + limit.held,
        requested: limit.amount,
      })
    }
  }
  return Ok({ ...unchanged(null), configured: { budget: updated, changes, usage, unitChanged } })
}

function withPricing(config: BudgetConfig, pricing: BudgetPricing | undefined): BudgetConfig {
  const { pricing: _requested, ...rest } = config
  return pricing === undefined ? rest : { ...rest, pricing }
}

/**
 * The cards the pricing names, each cached, in the budget's unit, and valid for the features it
 * prices: an `included` allowance only on a feature without dimensions whose rows price its meter.
 * A row that has ended stays cached to price late usage, so only rows in force or ahead are held to
 * the per-row rules; the card's own rules span every row.
 */
function compatibleCards(
  pricing: BudgetPricing,
  unit: string,
  cached: BudgetView["cards"],
  now: number
): Result<RateCards, UnPriceBudgetError> {
  const resolved = cardsOf(pricing, unit, cached)
  if (resolved.err) return resolved
  const priced = pricing.features.filter((feature) => feature.priced)
  const slugs = new Set(priced.map((feature) => feature.slug))
  const { base, overlay } = resolved.val
  for (const { card, rows } of overlay ? [base, overlay] : [base]) {
    const featureRows = rows.filter((row) => slugs.has(row.featureSlug))
    const current = featureRows.filter((row) => row.effectiveTo === null || row.effectiveTo > now)
    const violations = validateCard(card, featureRows, priced, current)
    if (violations.length > 0) {
      return reject({ code: "CARD_INCOMPATIBLE", cardId: card.id, violations })
    }
  }
  return resolved
}
