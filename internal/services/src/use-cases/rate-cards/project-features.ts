import type { FeaturePricing } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { ServiceContext } from "../../context"
import { type UnpriceableFeature, featurePricingOf } from "../../rate-cards"

/**
 * What the pricing core knows about each of a project's features, and the features it cannot
 * read with the reason, so a publish for one names the cause instead of an unknown feature.
 */
export async function projectFeaturePricing(
  features: ServiceContext["features"],
  projectId: string
): Promise<Result<{ features: FeaturePricing[]; unpriceable: UnpriceableFeature[] }, FetchError>> {
  const listed = await features.listFeaturesByProject({ projectId })
  if (listed.err) return Err(listed.err)
  const priced: FeaturePricing[] = []
  const unpriceable: UnpriceableFeature[] = []
  for (const feature of listed.val) {
    const parsed = featurePricingOf(feature)
    if (parsed.ok) priced.push(parsed.pricing)
    else unpriceable.push(parsed.unpriceable)
  }
  return Ok({ features: priced, unpriceable })
}
