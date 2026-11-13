import type {
  CostPlusFeaturePolicy,
  MarginPolicy,
  ModelCost,
  RateCard,
  RateRow,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { type CostPlusCard, type CostPlusDraft, costPlusRevision, writesRow } from "../pricing"
import { UnPriceRateCardError } from "./errors"
import { canonicalJson, stableHash } from "./wire"

export type CostPlusPreview = { draft: CostPlusDraft; draftHash: string }
export function costPlusPreview(
  card: RateCard,
  rows: readonly RateRow[],
  costs: readonly ModelCost[],
  at: number,
  featureSlug?: string
): Result<CostPlusPreview, UnPriceRateCardError> {
  if (card.marginPolicy.type !== "costPlus") {
    return Err(new UnPriceRateCardError({ code: "NOT_COST_PLUS", cardId: card.id }))
  }
  const costPlusCard: CostPlusCard = {
    ...card,
    marginPolicy: {
      ...card.marginPolicy,
      features: card.marginPolicy.features.filter(
        (policy) => featureSlug === undefined || policy.featureSlug === featureSlug
      ),
    },
  }
  const draft = costPlusRevision(costPlusCard, costs, rows, at)
  return Ok({ draft, draftHash: draftHash(draft, costPlusCard.marginPolicy) })
}

/** Hashes what publishing the draft would write, so a stale preview cannot be published. */
export function draftHash(draft: CostPlusDraft, policy: CostPlusCard["marginPolicy"]): string {
  return stableHash({
    policies: [...policy.features].sort((a, b) => a.featureSlug.localeCompare(b.featureSlug)),
    changes: draft.changes.filter(writesRow).map((change) => ({
      type: change.type,
      current: change.type === "changed" ? change.current.id : null,
      proposed: change.proposed,
    })),
  })
}

/** A card's margin policy with one feature's cost-plus policy set: one policy per feature. */
export function withFeaturePolicy(
  marginPolicy: RateCard["marginPolicy"],
  policy: CostPlusFeaturePolicy
): RateCard["marginPolicy"] {
  const kept =
    marginPolicy.type === "costPlus"
      ? marginPolicy.features.filter((other) => other.featureSlug !== policy.featureSlug)
      : []
  return { type: "costPlus", features: [...kept, policy] }
}

export function retainFeaturePolicies(
  policy: MarginPolicy,
  keep: (feature: CostPlusFeaturePolicy) => boolean
): MarginPolicy {
  if (policy.type === "manual") return policy
  const features = policy.features.filter(keep)
  return features.length > 0 ? { type: "costPlus", features } : { type: "manual" }
}

export function hasFeaturePolicy(
  marginPolicy: MarginPolicy,
  policy: CostPlusFeaturePolicy
): boolean {
  return (
    marginPolicy.type === "costPlus" &&
    marginPolicy.features.some((saved) => canonicalJson(saved) === canonicalJson(policy))
  )
}
