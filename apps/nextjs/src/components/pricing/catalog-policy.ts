import { COST_COMPONENT_NAMES } from "@unprice/db/validators"
import { AMOUNT_PATTERN, formatAmount } from "@unprice/money"
import type { RouterInputs, RouterOutputs } from "@unprice/trpc/routes"
import { type CostPlusFeaturePolicy, markupPercent } from "./rate-card-format"

/** The cost components the catalog carries, each priced from one event property. */
export type CostComponent = (typeof COST_COMPONENT_NAMES)[number]

export const COMPONENT_LABEL: Record<CostComponent, string> = {
  input: "Input",
  output: "Output",
  cache_read: "Cache read",
  cache_write: "Cache write",
}

/** What the operator types; `catalogPricingInputOf` turns it into the procedure's input. */
export type CatalogPolicyDraft = Readonly<{
  markupPercent: string
  roundTo: string
  components: Readonly<Record<CostComponent, string>>
}>

export const DEFAULT_CATALOG_POLICY: CatalogPolicyDraft = {
  markupPercent: "30",
  roundTo: "0.000001",
  components: {
    input: "input_tokens",
    output: "output_tokens",
    cache_read: "cache_read_tokens",
    cache_write: "cache_write_tokens",
  },
}

/**
 * The typed policy a saved one reads as, so the editor opens on the markup the card prices with,
 * not on the default: "where did 30% come from" has an answer on screen.
 */
export function policyDraftOf(policy: CostPlusFeaturePolicy): CatalogPolicyDraft {
  return {
    markupPercent: markupPercent(policy.markup),
    roundTo: formatAmount(policy.roundTo),
    components: {
      input: policy.componentMap.input ?? "",
      output: policy.componentMap.output ?? "",
      cache_read: policy.componentMap.cache_read ?? "",
      cache_write: policy.componentMap.cache_write ?? "",
    },
  }
}

export type CatalogPreview = RouterOutputs["rateCards"]["previewCatalogPricing"]
export type CatalogPricingInput = RouterInputs["rateCards"]["previewCatalogPricing"]
export type CatalogPolicyInput = Omit<CatalogPricingInput, "planVersionId" | "featureSlug">

/** "30" as the policy's markup "0.3"; null when it is not a non-negative number. */
export function markupRateOf(percent: string): string | null {
  const text = percent.trim()
  const value = Number(text)
  if (text === "" || !Number.isFinite(value) || value < 0) return null
  return (value / 100).toFixed(8).replace(/\.?0+$/, "")
}

/** The procedure's input from the typed policy, or what stops it. */
export function catalogPricingInputOf(
  draft: CatalogPolicyDraft,
  dimension: string | undefined
):
  | { ok: true; input: Omit<CatalogPricingInput, "planVersionId" | "featureSlug"> }
  | { ok: false; message: string } {
  const markup = markupRateOf(draft.markupPercent)
  if (markup === null) return { ok: false, message: "Markup is a percentage, like 30." }
  const roundTo = draft.roundTo.trim()
  if (!AMOUNT_PATTERN.test(roundTo) || Number(roundTo) <= 0) {
    return { ok: false, message: "Round to is a positive decimal, like 0.000001." }
  }
  const componentMap: Record<string, string> = {}
  for (const component of COST_COMPONENT_NAMES) {
    const property = draft.components[component].trim()
    if (property) componentMap[component] = property
  }
  if (Object.keys(componentMap).length === 0) {
    return { ok: false, message: "Map at least one cost component to an event property." }
  }
  return {
    ok: true,
    input: { markup, roundTo, componentMap, ...(dimension ? { dimension } : {}) },
  }
}

/** "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens · rounded to 0.000001". */
export function describePolicyDraft(draft: CatalogPolicyDraft): string {
  const properties = COST_COMPONENT_NAMES.map((component) =>
    draft.components[component].trim()
  ).filter(Boolean)
  return `${properties.join(", ") || "no property"} · rounded to ${draft.roundTo.trim() || "?"}`
}
