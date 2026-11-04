import type { FeaturePricing } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { ServiceContext } from "../../context"
import { featurePricingOf } from "../../rate-cards"

/** What the pricing core knows about each of a project's features. */
export async function projectFeaturePricing(
  features: ServiceContext["features"],
  projectId: string
): Promise<Result<FeaturePricing[], FetchError>> {
  const listed = await features.listFeaturesByProject({ projectId })
  if (listed.err) return Err(listed.err)
  return Ok(listed.val.flatMap((feature) => featurePricingOf(feature) ?? []))
}
