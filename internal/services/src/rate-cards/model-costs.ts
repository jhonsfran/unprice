import { type ModelCost, type ModelRate, modelCostSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import { parseQuantity } from "../pricing"
import { canonicalJson } from "./wire"

/** The cost component names cost-plus margin policies map, per catalog rate. */
const COMPONENTS = {
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
} as const satisfies Record<keyof ModelRate["rates"], string>

function decimal(rate: number, model: string): string {
  const parsed = parseQuantity(rate)
  if (!parsed.ok) {
    throw new Error(`catalog rate ${rate} of ${model} is not a decimal: ${parsed.reason}`)
  }
  return formatAmount(parsed.quantity)
}

/** The catalog's base rates as `modelsdev` costs; context tiers are not costs a card prices. */
export function catalogCosts(
  catalog: readonly ModelRate[],
  version: string,
  effectiveFrom: number
): ModelCost[] {
  return catalog.map((row) =>
    modelCostSchema.parse({
      provider: row.provider,
      model: row.model,
      components: Object.fromEntries(
        Object.entries(COMPONENTS).map(([rate, component]) => [
          component,
          decimal(row.rates[rate as keyof typeof COMPONENTS], row.id),
        ])
      ),
      effectiveFrom,
      source: "modelsdev",
      sourceRef: version,
    })
  )
}

/** The costs whose components differ from the latest imported row of the same model. */
export function changedCosts(latest: readonly ModelCost[], proposed: readonly ModelCost[]) {
  const current = new Map(
    latest.map((cost) => [`${cost.provider}/${cost.model}`, canonicalJson(cost.components)])
  )
  return proposed.filter(
    (cost) => current.get(`${cost.provider}/${cost.model}`) !== canonicalJson(cost.components)
  )
}
