import type { Currency, RatePrice } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { ServiceContext } from "../../context"
import type { UnPriceRateCardError } from "../../rate-cards"
import { projectFeaturePricing } from "./project-features"

export type PricePlanVersionDeps = {
  services: Pick<ServiceContext, "features" | "rateCards">
}

export type PricePlanVersionInput = {
  projectId: string
  planVersionId: string
  currency: Currency
  /** The card's name when the version has none yet; unique in the project. */
  cardName: string
  /** Each feature's default row. */
  prices: readonly { featureSlug: string; price: RatePrice }[]
  now: number
}

/**
 * Prices a draft plan version with its own money card (ADR-0008 D2): creates the card when the
 * version has none in `currency`, publishes each feature's default row, and assigns it. A rerun
 * with the same prices writes nothing; a changed price takes the card's notice like any other.
 * Shared by the plan templates, the monetization document, and onboarding.
 */
export async function pricePlanVersion(
  deps: PricePlanVersionDeps,
  input: PricePlanVersionInput
): Promise<Result<{ cardId: string }, UnPriceRateCardError | FetchError>> {
  const { rateCards } = deps.services
  const assigned = await rateCards.cardForPlanVersion(
    input.projectId,
    input.planVersionId,
    input.currency
  )
  let cardId = assigned?.cardId
  if (!cardId) {
    const created = await rateCards.createCard(input.projectId, {
      name: input.cardName,
      unit: `money:${input.currency}`,
      marginPolicy: { type: "manual" },
    })
    if (created.err) return Err(created.err)
    cardId = created.val.id
  }

  if (input.prices.length > 0) {
    const features = await projectFeaturePricing(deps.services.features, input.projectId)
    if (features.err) return Err(features.err)
    const published = await rateCards.publishRows({
      projectId: input.projectId,
      cardId,
      drafts: input.prices.map(({ featureSlug, price }) => ({
        featureSlug,
        match: {},
        price,
        cost: null,
        source: "manual",
        sourceRef: null,
      })),
      effectiveFrom: input.now,
      now: input.now,
      ...features.val,
    })
    if (published.err) return Err(published.err)
  }

  if (!assigned) {
    const assignment = await rateCards.assignToPlanVersion(input.projectId, {
      planVersionId: input.planVersionId,
      currency: input.currency,
      cardId,
    })
    if (assignment.err) return Err(assignment.err)
  }
  return Ok({ cardId })
}
