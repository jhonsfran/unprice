import type { Database } from "@unprice/db"
import type { PlanVersionFeatureUpdate, RateRow } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import type { Transaction } from "../../deps"
import { decimalPriceOf, pricedProperties, ratePriceOf } from "../../pricing"
import {
  UnPriceRateCardError,
  planFeaturePricing,
  pricePlanVersion,
  versionCardName,
} from "../../rate-cards"
import { canonicalJson } from "../../rate-cards/wire"
import { transactionResult } from "../../utils/transaction-result"

export type UpdatePlanVersionFeatureDeps = {
  db: Database
  services: Pick<ServiceContext, "plans" | "features" | "rateCards">
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
  if (!result.err) await deps.services.rateCards.invalidatePlanVersionPrices([input.planVersionId])
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

  // A reshaped feature changes what its default row prices (a flat amount, a package of a size);
  // a regrouped one changes which dimension rows fit. Either repackages what the card prices.
  const reshaped =
    (input.featureType !== undefined && input.featureType !== stored.val.featureType) ||
    (input.config?.usageMode !== undefined &&
      input.config.usageMode !== stored.val.config.usageMode) ||
    (input.config?.units !== undefined && input.config.units !== stored.val.config.units)
  const regrouped =
    hasMeterConfigOverride &&
    canonicalJson(input.meterConfig?.groupBy ?? []) !==
      canonicalJson(stored.val.meterConfig?.groupBy ?? [])
  const oldPricing = planFeaturePricing(stored.val)
  const nextPricing = planFeaturePricing({
    ...stored.val,
    ...(hasMeterConfigOverride ? { meterConfig: input.meterConfig } : {}),
  })
  const remetered =
    oldPricing.ok &&
    nextPricing.ok &&
    oldPricing.pricing.meterProperty !== nextPricing.pricing.meterProperty
  const repackaged = reshaped || regrouped || remetered
  const card = await rateCards.cardForPlanVersion(projectId, version.id, version.currency)
  if (card && (repackaged || pricing)) {
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

  const updated = await plans.updatePlanVersionFeatureRecord(
    {
      projectId,
      ...update,
      hasMeterConfigOverride,
    },
    tx
  )
  if (updated.err) return Err(updated.err)
  if (updated.val.state !== "ok") return Ok(updated.val)
  const { planVersionFeature } = updated.val
  const featureSlug = planVersionFeature.feature.slug
  const parsed = planFeaturePricing(planVersionFeature)
  const dimensions = parsed.ok ? parsed.pricing.dimensions : []

  const openRows = card
    ? await featureOpenRows(deps, projectId, card.cardId, featureSlug)
    : Ok<RateRow[]>([])
  if (openRows.err) return Err(openRows.err)
  const stale = openRows.val.filter((row) => {
    const keys = Object.keys(row.match)
    if (keys.length === 0) return reshaped
    return !keys.every((key) => dimensions.includes(key))
  })
  const kept = openRows.val.filter((row) => !stale.includes(row))

  const current = defaultRow(kept)
  const meterProperty = parsed.ok ? parsed.pricing.meterProperty : null
  const remetering =
    price === undefined &&
    current !== null &&
    !reshaped &&
    (pricedProperties(current)[0] ?? null) !== meterProperty
  const decimal = price ?? (remetering && current ? decimalPriceOf(current.price) : null)
  const ratePrice = decimal
    ? ratePriceOf(
        {
          featureType: planVersionFeature.featureType,
          usageMode: planVersionFeature.config.usageMode,
          units: planVersionFeature.config.units,
          price: decimal.price,
          tiers: decimal.tiers,
        },
        meterProperty
      )
    : null
  if (price && !ratePrice) {
    return Err(
      new UnPriceRateCardError({
        code: "PRICE_SHAPE_MISMATCH",
        featureSlug,
        expected: price.tiers === undefined ? "tiers" : "price",
      })
    )
  }

  const closing = price === null ? openRows.val : [...stale]
  if (remetering && !ratePrice && current) closing.push(current)
  const closeRowIds = [...new Set(closing.map((row) => row.id))]

  if (ratePrice) {
    const plan = await plans.getPlanByIdRecord({ planId: version.planId, projectId })
    if (plan.err) return Err(plan.err)
    const priced = await pricePlanVersion(deps, {
      projectId,
      planVersionId: version.id,
      currency: version.currency,
      cardName: versionCardName(plan.val?.slug ?? version.planId, version.id, version.currency),
      prices: [{ featureSlug, price: ratePrice }],
      closeRowIds,
      now,
    })
    if (priced.err) return Err(priced.err)
    const rows = await featureOpenRows(deps, projectId, priced.val.cardId, featureSlug)
    if (rows.err) return Err(rows.err)
    return Ok({ state: "ok", planVersionFeature, row: defaultRow(rows.val) })
  }
  if (card && closeRowIds.length > 0) {
    const closed = await rateCards.closeRows({
      projectId,
      cardId: card.cardId,
      rowIds: closeRowIds,
      now,
    })
    if (closed.err) return Err(closed.err)
  }
  return Ok({ state: "ok", planVersionFeature, row: price === null || remetering ? null : current })
}

/** The feature's rows on the card that have not ended. */
async function featureOpenRows(
  { services: { rateCards } }: UpdatePlanVersionFeatureDeps,
  projectId: string,
  cardId: string,
  featureSlug: string
): Promise<Result<RateRow[], UnPriceRateCardError>> {
  const found = await rateCards.getCard(projectId, cardId)
  if (found.err) return Err(found.err)
  return Ok(
    found.val.rows.filter((row) => row.featureSlug === featureSlug && row.effectiveTo === null)
  )
}

function defaultRow(rows: readonly RateRow[]): RateRow | null {
  return rows.find((row) => Object.keys(row.match).length === 0) ?? null
}
