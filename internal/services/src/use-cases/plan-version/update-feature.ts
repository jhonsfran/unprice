import type { Database } from "@unprice/db"
import type { PlanVersionFeatureUpdate, RateRow } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import type { Transaction } from "../../deps"
import { decimalPriceOf, featureRow, pricingShape, ratePriceOf, rowFits } from "../../pricing"
import {
  UnPriceRateCardError,
  featurePricingOf,
  pricePlanVersion,
  versionCardName,
} from "../../rate-cards"
import { transactionResult } from "../../utils/transaction-result"

export type UpdatePlanVersionFeatureDeps = {
  db: Database
  services: Pick<ServiceContext, "plans" | "rateCards">
  logger?: Logger
}

/** The parsed `planVersionFeatureUpdateBaseSchema`, the project, and the request's clock. */
export type UpdatePlanVersionFeatureInput = PlanVersionFeatureUpdate & {
  projectId: string
  now: number
}

type RecordUpdate = NonNullable<
  Awaited<ReturnType<ServiceContext["plans"]["updatePlanVersionFeatureRecord"]>>["val"]
>

export type UpdatePlanVersionFeatureOutput =
  | Exclude<RecordUpdate, { state: "ok" }>
  | {
      state: "ok"
      planVersionFeature: Extract<RecordUpdate, { state: "ok" }>["planVersionFeature"]
      /** The feature's open default row on the version's card; null while it is unpriced. */
      row: RateRow | null
    }

/**
 * Edits a draft version's feature and prices it in the same step (ADR-0008 D2): a price given in
 * decimal form becomes the feature's default row on the version's own card, created on the first
 * price; `price: null` ends the feature's rows; an absent price leaves them. Rows that match a
 * dimension the feature no longer varies by end where the new price starts, or at once when no
 * price is given, so the card always fits the feature. A version whose card also prices another
 * version is refused before anything is written: repackaging or repricing it would change that
 * version's prices too.
 */
export async function updatePlanVersionFeature(
  deps: UpdatePlanVersionFeatureDeps,
  input: UpdatePlanVersionFeatureInput
): Promise<Result<UpdatePlanVersionFeatureOutput, FetchError | UnPriceRateCardError>> {
  const result = await transactionResult(deps.db, async (tx) => {
    await deps.services.rateCards.lockPlanVersionCards(input.projectId, input.planVersionId, tx)
    return updateFeature(
      {
        ...deps,
        services: { ...deps.services, rateCards: deps.services.rateCards.withTransaction(tx) },
      },
      input,
      tx
    )
  })
  return result
}

async function updateFeature(
  deps: UpdatePlanVersionFeatureDeps,
  input: UpdatePlanVersionFeatureInput,
  tx: Transaction
): Promise<Result<UpdatePlanVersionFeatureOutput, FetchError | UnPriceRateCardError>> {
  const { plans, rateCards } = deps.services
  const { projectId, now, price, ...update } = input
  const hasMeterConfigOverride = Object.hasOwn(input, "meterConfig")
  const pricing = Object.hasOwn(input, "price")

  const stored = await plans.getPlanVersionFeatureByIdDetailed({ id: input.id, projectId }, tx)
  if (stored.err) return Err(stored.err)
  if (!stored.val) return Ok({ state: "plan_version_feature_not_found" })
  const version = stored.val.planVersion
  if (version.id !== input.planVersionId) return Ok({ state: "plan_version_not_found" })
  if (version.status === "published") return Ok({ state: "plan_version_published" })

  const featureSlug = stored.val.feature.slug
  const merged = {
    ...stored.val,
    featureType: input.featureType ?? stored.val.featureType,
    config: input.config ?? stored.val.config,
    meterConfig: hasMeterConfigOverride ? input.meterConfig : stored.val.meterConfig,
    included: input.included === undefined ? stored.val.included : input.included,
  }
  const next = featurePricingOf({ ...merged, slug: featureSlug })
  if (!next.ok) {
    return Err(
      new UnPriceRateCardError({ code: "FEATURE_NOT_PRICEABLE", features: [next.unpriceable] })
    )
  }
  const shape = pricingShape({
    featureType: merged.featureType,
    usageMode: merged.config.usageMode,
  })
  const card = await rateCards.cardForPlanVersion(projectId, version.id, version.currency)
  const found = card ? await rateCards.getCard(projectId, card.cardId) : null
  if (found?.err) return Err(found.err)
  const openRows =
    found?.val?.rows.filter((row) => row.featureSlug === featureSlug && row.effectiveTo === null) ??
    []
  const stale = openRows.filter((row) => !rowFits(row, next.pricing, shape, merged.config.units))
  const current = featureRow(openRows, featureSlug)

  if (card && (pricing || stale.length > 0)) {
    const other = (await rateCards.versionsPricingWith(projectId, card.cardId)).find(
      (assigned) => assigned.planVersionId !== version.id
    )
    if (other) {
      return Err(
        new UnPriceRateCardError({
          code: "CARD_SHARED",
          cardId: card.cardId,
          planVersionId: other.planVersionId,
        })
      )
    }
  }

  // Preserve a price on a changed meter only when its shape and package size still fit.
  const decimal =
    price === undefined &&
    current &&
    stale.includes(current) &&
    current.price.type === shape &&
    (current.price.type !== "package" || current.price.size === merged.config.units)
      ? decimalPriceOf(current.price)
      : price
  const desired = decimal
    ? ratePriceOf(
        {
          ...decimal,
          featureType: merged.featureType,
          usageMode: merged.config.usageMode,
          units: merged.config.units,
        },
        next.pricing.meterProperty
      )
    : null
  if (price && !desired) {
    return Err(
      new UnPriceRateCardError({
        code: "PRICE_SHAPE_MISMATCH",
        featureSlug,
        expected: price.tiers === undefined ? "tiers" : "price",
      })
    )
  }

  const updated = await plans.updatePlanVersionFeatureRecord(
    { projectId, ...update, hasMeterConfigOverride },
    tx
  )
  if (updated.err) return Err(updated.err)
  if (updated.val.state !== "ok") return Ok(updated.val)
  const { planVersionFeature } = updated.val
  const closeRowIds = (price === null ? openRows : stale).map((row) => row.id)
  let cardId = card?.cardId
  if (!cardId && desired) {
    const plan = await plans.getPlanByIdRecord({ planId: version.planId, projectId })
    if (plan.err) return Err(plan.err)
    const assigned = await pricePlanVersion(deps, {
      projectId,
      planVersionId: version.id,
      currency: version.currency,
      cardName: versionCardName(plan.val?.slug ?? version.planId, version.id, version.currency),
      prices: [],
      now,
    })
    if (assigned.err) return Err(assigned.err)
    cardId = assigned.val.cardId
  }
  let row = current && !closeRowIds.includes(current.id) ? current : null
  if (cardId && (desired || closeRowIds.length > 0)) {
    const published = await rateCards.publishRows({
      projectId,
      cardId,
      now,
      closeRowIds,
      drafts: desired ? [{ featureSlug, match: {}, price: desired, cost: null }] : [],
    })
    if (published.err) return Err(published.err)
    row = featureRow(published.val.inserted, featureSlug) ?? row
  }
  return Ok({ state: "ok", planVersionFeature, row })
}
