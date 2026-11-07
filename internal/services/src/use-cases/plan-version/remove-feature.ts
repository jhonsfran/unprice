import type { Database } from "@unprice/db"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { ServiceContext } from "../../context"
import type { UnPriceRateCardError } from "../../rate-cards"
import { transactionResult } from "../../utils/transaction-result"

export type RemovePlanVersionFeatureDeps = {
  db: Database
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
  const result = await transactionResult<RecordRemoval, FetchError | UnPriceRateCardError>(
    deps.db,
    async (tx) => {
      const { projectId, id, now } = input
      const initial = await plans.getPlanVersionFeatureByIdDetailed({ id, projectId }, tx)
      if (initial.err) return Err(initial.err)
      if (!initial.val) return Ok({ state: "not_found" as const })
      await rateCards.lockPlanVersionCards(projectId, initial.val.planVersionId, tx)
      const stored = await plans.getPlanVersionFeatureByIdDetailed({ id, projectId }, tx)
      if (stored.err) return Err(stored.err)
      if (!stored.val) return Ok({ state: "not_found" as const })
      const removed = await plans.removePlanVersionFeatureRecord({ projectId, id }, tx)
      if (removed.err) return Err(removed.err)
      if (removed.val.state !== "ok") return Ok(removed.val)
      const scoped = rateCards.withTransaction(tx)
      const card = await scoped.cardForPlanVersion(
        projectId,
        stored.val.planVersionId,
        stored.val.planVersion.currency
      )
      if (card) {
        const ended = await scoped.removeFeaturePrices({
          projectId,
          cardId: card.cardId,
          featureSlug: stored.val.feature.slug,
          now,
        })
        if (ended.err) return Err(ended.err)
      }
      return Ok(removed.val)
    }
  )
  if (!result.err && result.val.state === "ok") {
    await rateCards.invalidatePlanVersionPrices([result.val.planVersionFeature.planVersionId])
  }
  return result
}
