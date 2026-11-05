import { currencySchema, featureSlugSchema, ratePriceSchema } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import type { ServiceContext } from "../context"
import { UnPriceRateCardError } from "./errors"
import { projectFeaturePricing } from "./project-features"

export type PricePlanVersionDeps = {
  services: Pick<ServiceContext, "features" | "rateCards">
}

export const pricePlanVersionInputSchema = z.object({
  projectId: z.string().min(1),
  planVersionId: z.string().min(1),
  currency: currencySchema,
  /** The card's name when the version has none yet; unique in the project. */
  cardName: z.string().min(1),
  /** Each feature's default row. */
  prices: z.array(z.object({ featureSlug: featureSlugSchema, price: ratePriceSchema })),
  now: z.number().int().nonnegative(),
})

export type PricePlanVersionInput = z.infer<typeof pricePlanVersionInputSchema>

/**
 * Prices a draft plan version with its own money card (ADR-0008 D2): creates the card when the
 * version has none in `currency`, publishes each feature's default row, and assigns it. A rerun
 * with the same prices writes nothing; a changed price takes the card's notice like any other.
 * Shared by the plan templates, the monetization document, and onboarding.
 *
 * The three writes are separate transactions, so a run can stop after creating the card. The
 * card's name is fixed by the caller, so the next run finds it by that name and finishes the job.
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
    const card = await versionCard(deps, input)
    if (card.err) return Err(card.err)
    cardId = card.val
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

/**
 * Creates the version's card, or adopts the card an interrupted run created under the same name.
 * A card with that name in another unit is not the version's, so it is refused.
 */
async function versionCard(
  { services: { rateCards } }: PricePlanVersionDeps,
  input: PricePlanVersionInput
): Promise<Result<string, UnPriceRateCardError>> {
  const unit = `money:${input.currency}`
  const created = await rateCards.createCard(input.projectId, {
    name: input.cardName,
    unit,
    marginPolicy: { type: "manual" },
  })
  if (!created.err) return Ok(created.val.id)
  if (created.err.code !== "CARD_NAME_TAKEN") return Err(created.err)

  const existing = await rateCards.cardByName(input.projectId, input.cardName)
  if (!existing) return Err(created.err)
  if (existing.unit !== unit) {
    return Err(
      new UnPriceRateCardError({
        code: "CARD_UNIT_MISMATCH",
        cardId: existing.id,
        unit: existing.unit,
        currency: input.currency,
      })
    )
  }
  return Ok(existing.id)
}
