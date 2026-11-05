import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { ServiceContext } from "../../context"
import type { UnPriceRateCardError } from "../../rate-cards"

export type RemovePlanVersionFeatureDeps = {
  services: Pick<ServiceContext, "plans" | "rateCards">
}

type RecordRemoval = NonNullable<
  Awaited<ReturnType<ServiceContext["plans"]["removePlanVersionFeatureRecord"]>>["val"]
>

/**
 * Detaches a feature from a draft version and ends its rows on the version's own card, so the
 * card never prices a feature the version no longer carries. Rows on a card another version also
 * prices with are left alone: they are that version's prices.
 */
export async function removePlanVersionFeature(
  deps: RemovePlanVersionFeatureDeps,
  input: { projectId: string; id: string; now: number }
): Promise<Result<RecordRemoval, FetchError | UnPriceRateCardError>> {
  const { plans, rateCards } = deps.services
  const { projectId, id, now } = input

  const stored = await plans.getPlanVersionFeatureByIdDetailed({ id, projectId })
  if (stored.err) return Err(stored.err)
  const removed = await plans.removePlanVersionFeatureRecord({ projectId, id })
  if (removed.err) return Err(removed.err)
  if (removed.val.state !== "ok" || !stored.val) return Ok(removed.val)

  const { planVersion, feature } = stored.val
  const card = await rateCards.cardForPlanVersion(projectId, planVersion.id, planVersion.currency)
  if (!card) return Ok(removed.val)
  const shared = (await rateCards.versionsPricingWith(projectId, card.cardId)).some(
    (assigned) => assigned.planVersionId !== planVersion.id
  )
  if (shared) return Ok(removed.val)

  const found = await rateCards.getCard(projectId, card.cardId)
  if (found.err) return Err(found.err)
  const rowIds = found.val.rows
    .filter((row) => row.featureSlug === feature.slug && row.effectiveTo === null)
    .map((row) => row.id)
  if (rowIds.length > 0) {
    const closed = await rateCards.closeRows({ projectId, cardId: card.cardId, rowIds, now })
    if (closed.err) return Err(closed.err)
  }
  return Ok(removed.val)
}
