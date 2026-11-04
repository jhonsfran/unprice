import type {
  MarginPolicy,
  ModelCost,
  RateCard,
  RateComponent,
  RateCost,
  RatePrice,
  RateRow,
} from "@unprice/db/validators"
import type { Amount } from "@unprice/money"
import { ONE, ceilDiv } from "./decimal"
import { matchKey } from "./model"
import { isEffective } from "./resolve"

export type CostPlusPolicy = Extract<MarginPolicy, { type: "costPlus" }>
export type CostPlusCard = RateCard & { marginPolicy: CostPlusPolicy }

/** Catalog costs are USD per million. */
const PER_MILLION = 1_000_000

export type ProposedRow = Readonly<{
  featureSlug: string
  match: Readonly<Record<string, string>>
  price: Extract<RatePrice, { type: "unit" }>
  cost: RateCost
  source: "catalog"
  sourceRef: string | null
}>

export type ComponentChange = Readonly<{
  property: string | null
  before: RateComponent | null
  after: RateComponent | null
}>

export type RowChange =
  | Readonly<{ type: "added"; proposed: ProposedRow }>
  | Readonly<{
      type: "changed"
      current: RateRow
      proposed: ProposedRow
      /** Price components whose rate changed, appeared, or disappeared. */
      components: readonly ComponentChange[]
    }>
  | Readonly<{ type: "unchanged"; current: RateRow; proposed: ProposedRow }>

/** A draft revision; publishing it is a separate, explicit step. */
export type CostPlusDraft = Readonly<{ cardId: string; at: number; changes: readonly RowChange[] }>

/**
 * Proposes one unit row per model at cost times (1 + markup), rounded up to `roundTo`, and
 * diffs it against the rows effective at `at`. A manual cost row beats an imported one.
 */
export function costPlusRevision(
  card: CostPlusCard,
  costs: readonly ModelCost[],
  currentRows: readonly RateRow[],
  at: number
): CostPlusDraft {
  const policy = card.marginPolicy
  const changes: RowChange[] = []
  for (const cost of effectiveCosts(costs, at)) {
    const proposed = proposeRow(card, cost)
    if (!proposed) continue
    const current = currentRows.find(
      (row) =>
        row.featureSlug === policy.featureSlug &&
        row.price.type !== "flat" &&
        isEffective(row, at) &&
        matchKey(row.match) === matchKey(proposed.match)
    )
    changes.push(diffRow(current, proposed))
  }
  return { cardId: card.id, at, changes }
}

function effectiveCosts(costs: readonly ModelCost[], at: number): ModelCost[] {
  const byModel = new Map<string, ModelCost>()
  for (const cost of costs) {
    if (cost.effectiveFrom > at) continue
    const chosen = byModel.get(cost.model)
    if (!chosen || ranksAbove(cost, chosen)) byModel.set(cost.model, cost)
  }
  return [...byModel.values()]
}

function ranksAbove(a: ModelCost, b: ModelCost): boolean {
  if (a.source !== b.source) return a.source === "manual"
  return a.effectiveFrom > b.effectiveFrom
}

function proposeRow(card: CostPlusCard, cost: ModelCost): ProposedRow | null {
  const policy = card.marginPolicy
  const components: RateComponent[] = []
  const costComponents: RateComponent[] = []
  for (const [costComponent, property] of Object.entries(policy.componentMap)) {
    const usd = cost.components[costComponent]
    if (usd === undefined) continue
    components.push({ property, rate: priceOf(card, usd), per: PER_MILLION })
    costComponents.push({ property, rate: usd, per: PER_MILLION })
  }
  if (components.length === 0) return null
  return {
    featureSlug: policy.featureSlug,
    match: { [policy.dimension]: cost.model },
    price: { type: "unit", components },
    cost: { components: costComponents },
    source: "catalog",
    sourceRef: cost.sourceRef,
  }
}

/** cost * (1 + markup), in credits when the card counts credits, rounded up to `roundTo`. */
function priceOf(card: CostPlusCard, usd: Amount): Amount {
  const { markup, roundTo } = card.marginPolicy
  const n = usd * (ONE + markup)
  const d = card.creditValueUsd ?? ONE
  return ceilDiv(n, d * roundTo) * roundTo
}

function sameRate(a: RateComponent, b: RateComponent): boolean {
  return a.rate * BigInt(b.per) === b.rate * BigInt(a.per)
}

function componentChanges(
  current: readonly RateComponent[],
  proposed: readonly RateComponent[]
): ComponentChange[] {
  const properties = [...new Set([...current, ...proposed].map((c) => c.property))]
  return properties.flatMap((property) => {
    const before = current.find((c) => c.property === property) ?? null
    const after = proposed.find((c) => c.property === property) ?? null
    return before && after && sameRate(before, after) ? [] : [{ property, before, after }]
  })
}

function diffRow(current: RateRow | undefined, proposed: ProposedRow): RowChange {
  if (!current) return { type: "added", proposed }
  const currentComponents = current.price.type === "unit" ? current.price.components : []
  const components = componentChanges(currentComponents, proposed.price.components)
  const costChanged =
    componentChanges(current.cost?.components ?? [], proposed.cost.components).length > 0
  if (components.length === 0 && !costChanged) return { type: "unchanged", current, proposed }
  return { type: "changed", current, proposed, components }
}
