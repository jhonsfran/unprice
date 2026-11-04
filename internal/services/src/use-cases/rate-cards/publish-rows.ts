import type { RateRowDraft } from "@unprice/db/validators"
import { Err, type FetchError, type Result } from "@unprice/error"
import type { ServiceContext } from "../../context"
import type { PublishRowsResult, UnPriceRateCardError } from "../../rate-cards"
import { projectFeaturePricing } from "./project-features"

export type PublishRateRowsDeps = {
  services: Pick<ServiceContext, "features" | "rateCards">
}

export type PublishRateRowsInput = {
  projectId: string
  cardId: string
  rows: readonly RateRowDraft[]
  effectiveFrom: number
  now: number
}

/** Publishes hand-written price rows on a card; see `planPublish` for the rules. */
export async function publishRateRows(
  deps: PublishRateRowsDeps,
  input: PublishRateRowsInput
): Promise<Result<PublishRowsResult, UnPriceRateCardError | FetchError>> {
  const features = await projectFeaturePricing(deps.services.features, input.projectId)
  if (features.err) return Err(features.err)
  return deps.services.rateCards.publishRows({
    projectId: input.projectId,
    cardId: input.cardId,
    drafts: input.rows.map(({ featureSlug, match, price, cost }) => ({
      featureSlug,
      match,
      price,
      cost,
      source: "manual",
      sourceRef: null,
    })),
    effectiveFrom: input.effectiveFrom,
    now: input.now,
    features: features.val,
  })
}
