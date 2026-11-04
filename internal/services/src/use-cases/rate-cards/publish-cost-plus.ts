import { publishCostPlusInputSchema } from "@unprice/db/validators"
import { Err, type FetchError, type Result } from "@unprice/error"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import type { PublishRowsResult, UnPriceRateCardError } from "../../rate-cards"
import { projectFeaturePricing } from "./project-features"

export type PublishCostPlusDeps = {
  services: Pick<ServiceContext, "features" | "rateCards">
}

const publishCostPlusUseCaseInputSchema = publishCostPlusInputSchema.extend({
  projectId: z.string().min(1),
  now: z.number(),
})

export type PublishCostPlusInput = z.infer<typeof publishCostPlusUseCaseInputSchema>

/**
 * Publishes the added and changed rows of a card's cost-plus revision, recomputed now. A draft
 * that differs from the one the caller previewed is DRAFT_STALE and writes nothing.
 */
export async function publishCostPlus(
  deps: PublishCostPlusDeps,
  input: PublishCostPlusInput
): Promise<Result<PublishRowsResult, UnPriceRateCardError | FetchError>> {
  const features = await projectFeaturePricing(deps.services.features, input.projectId)
  if (features.err) return Err(features.err)
  return deps.services.rateCards.publishCostPlus({ ...input, ...features.val })
}
