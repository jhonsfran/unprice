import { Err, type FetchError, type Result } from "@unprice/error"
import type { ServiceContext } from "../../context"
import { type PublishRowsResult, type RowDraft, UnPriceRateCardError } from "../../rate-cards"
import { projectFeaturePricing } from "./project-features"

export type PublishCostPlusDeps = {
  services: Pick<ServiceContext, "features" | "rateCards">
}

export type PublishCostPlusInput = {
  projectId: string
  cardId: string
  effectiveFrom: number
  /** The hash of the preview the caller reviewed. */
  draftHash: string
  now: number
}

/**
 * Publishes the added and changed rows of a card's cost-plus revision, recomputed now. A draft
 * that differs from the one the caller previewed is DRAFT_STALE and writes nothing.
 */
export async function publishCostPlus(
  deps: PublishCostPlusDeps,
  input: PublishCostPlusInput
): Promise<Result<PublishRowsResult, UnPriceRateCardError | FetchError>> {
  const { rateCards } = deps.services
  const preview = await rateCards.previewCostPlus(input.projectId, input.cardId, input.now)
  if (preview.err) return Err(preview.err)
  if (preview.val.draftHash !== input.draftHash) {
    return Err(new UnPriceRateCardError({ code: "DRAFT_STALE", draftHash: preview.val.draftHash }))
  }

  const drafts: RowDraft[] = preview.val.draft.changes.flatMap((change) => {
    if (change.type === "unchanged") return []
    const { featureSlug, match, price, cost, source, sourceRef } = change.proposed
    return [{ featureSlug, match: { ...match }, price, cost, source, sourceRef }]
  })

  const features = await projectFeaturePricing(deps.services.features, input.projectId)
  if (features.err) return Err(features.err)
  return rateCards.publishRows({
    projectId: input.projectId,
    cardId: input.cardId,
    drafts,
    effectiveFrom: input.effectiveFrom,
    now: input.now,
    features: features.val,
  })
}
