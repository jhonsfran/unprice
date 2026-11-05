import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { ServiceContext } from "../context"
import { type FeaturePricingSet, featurePricingOf, unionFeaturePricing } from "./publish"

/**
 * What the pricing core knows about each of a project's features, and the features it cannot
 * read with the reason, so a publish for one names the cause instead of an unknown feature. Only
 * a card no version prices with yet is checked against these; see `cardFeaturePricing`.
 */
export async function projectFeaturePricing(
  features: ServiceContext["features"],
  projectId: string
): Promise<Result<FeaturePricingSet, FetchError>> {
  const listed = await features.listFeaturesByProject({ projectId })
  if (listed.err) return Err(listed.err)
  return Ok(unionFeaturePricing(listed.val.map((feature) => featurePricingOf(feature))))
}

/**
 * The one answer to which features a card prices for: the plan features of every version
 * assigned to it, through each version's own meter snapshot, and the project's features only
 * while no version prices with the card.
 */
export async function cardFeaturePricing(
  services: Pick<ServiceContext, "features" | "rateCards">,
  projectId: string,
  cardId: string
): Promise<Result<FeaturePricingSet, FetchError>> {
  const assigned = await services.rateCards.featuresPricingWith(projectId, cardId)
  if (assigned) return Ok(assigned)
  return projectFeaturePricing(services.features, projectId)
}
