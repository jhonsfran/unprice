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
import { ownProperty } from "./resolve"

export type CostPlusPolicy = Extract<MarginPolicy, { type: "costPlus" }>
export type CostPlusCard = RateCard & { marginPolicy: CostPlusPolicy }
type FeaturePolicy = CostPlusPolicy["features"][number]

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
  /**
   * The key's row ends at `current.effectiveTo` with no successor, so the operator is retiring it.
   * The revision leaves it to end: publishing writes nothing for it.
   */
  | Readonly<{ type: "retiring"; current: RateRow; proposed: ProposedRow }>

/** A draft revision; publishing it is a separate, explicit step. */
export type CostPlusDraft = Readonly<{ cardId: string; at: number; changes: readonly RowChange[] }>

/** Whether publishing the change writes a row. */
export function writesRow(
  change: RowChange
): change is Extract<RowChange, { type: "added" | "changed" }> {
  return change.type === "added" || change.type === "changed"
}

/**
 * Proposes one unit row per model and policy feature at the costs effective at `at`: cost times
 * (1 + markup), rounded up to `roundTo`. Each proposal is diffed against its key's latest row that
 * has not ended by `at`: the open row a publish would replace, even one that starts after `at`, or
 * a row scheduled to end, which the revision leaves to retire. A manual cost row beats an imported
 * one. Changes are ordered by feature and match, so the draft and its hash never depend on the
 * order costs arrive in.
 */
export function costPlusRevision(
  card: CostPlusCard,
  costs: readonly ModelCost[],
  currentRows: readonly RateRow[],
  at: number
): CostPlusDraft {
  const effective = effectiveCosts(costs, at)
  const changes: [string, RowChange][] = []
  for (const policy of card.marginPolicy.features) {
    const latest = new Map<string, RateRow>()
    for (const row of currentRows) {
      if (row.featureSlug !== policy.featureSlug) continue
      if (row.effectiveTo !== null && row.effectiveTo <= at) continue
      const key = matchKey(row.match)
      const found = latest.get(key)
      if (!found || row.effectiveFrom > found.effectiveFrom) latest.set(key, row)
    }
    for (const cost of effective) {
      const proposed = proposeRow(card, policy, cost)
      if (!proposed) continue
      const key = matchKey(proposed.match)
      changes.push([`${policy.featureSlug}|${key}`, diffRow(latest.get(key), proposed)])
    }
  }
  changes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return { cardId: card.id, at, changes: changes.map(([, change]) => change) }
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

function proposeRow(
  card: CostPlusCard,
  policy: FeaturePolicy,
  cost: ModelCost
): ProposedRow | null {
  const components: RateComponent[] = []
  const costComponents: RateComponent[] = []
  for (const [costComponent, property] of Object.entries(policy.componentMap)) {
    const usd = ownProperty(cost.components, costComponent)
    if (usd === undefined) continue
    components.push({ property, rate: priceOf(card, policy, usd), per: PER_MILLION })
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
function priceOf(card: CostPlusCard, policy: FeaturePolicy, usd: Amount): Amount {
  const { markup, roundTo } = policy
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
  if (current.effectiveTo !== null) return { type: "retiring", current, proposed }
  const currentComponents = current.price.type === "unit" ? current.price.components : []
  const components = componentChanges(currentComponents, proposed.price.components)
  const costChanged =
    componentChanges(current.cost?.components ?? [], proposed.cost.components).length > 0
  if (components.length === 0 && !costChanged) return { type: "unchanged", current, proposed }
  return { type: "changed", current, proposed, components }
}
