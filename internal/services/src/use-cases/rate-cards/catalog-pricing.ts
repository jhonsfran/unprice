import type { Database } from "@unprice/db"
import {
  type PlanVersionCatalogPricingInput,
  type RateCard,
  type applyPlanVersionCatalogPricingInputSchema,
  currencySchema,
} from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { z } from "zod"
import { MODEL_CATALOG } from "../../budgets/model-catalog"
import type { ServiceContext } from "../../context"
import type { Transaction } from "../../deps"
import { UnPriceRateCardError, featurePricingOf, versionCardName } from "../../rate-cards"
import type { PublishRowsResult } from "../../rate-cards"
import { costPlusPreview, withFeaturePolicy } from "../../rate-cards/catalog"
import { transactionResult } from "../../utils/transaction-result"

type CatalogPricingDeps = { services: Pick<ServiceContext, "plans" | "rateCards" | "modelCosts"> }
type CatalogPricingInput = PlanVersionCatalogPricingInput & { projectId: string; now: number }
const USD = currencySchema.parse("USD")

async function prepareCatalogPricing(
  deps: CatalogPricingDeps,
  input: CatalogPricingInput,
  tx?: Transaction
) {
  const { plans, rateCards } = deps.services
  const { projectId, planVersionId, featureSlug } = input

  const found = await plans.getPlanVersionByIdDetailed({ planVersionId, projectId }, tx)
  if (found.err) return Err(found.err)
  const version = found.val
  if (!version)
    return Err(new UnPriceRateCardError({ code: "PLAN_VERSION_NOT_FOUND", planVersionId }))
  if (version.status === "published") {
    return Err(new UnPriceRateCardError({ code: "PLAN_VERSION_PUBLISHED", planVersionId }))
  }
  if (version.currency !== USD) {
    return Err(
      new UnPriceRateCardError({ code: "CATALOG_USD_ONLY", unit: `money:${version.currency}` })
    )
  }

  const planFeature = version.planFeatures.find(
    (candidate) => candidate.feature.slug === featureSlug
  )
  if (!planFeature) {
    return Err(new UnPriceRateCardError({ code: "UNKNOWN_FEATURE", features: [featureSlug] }))
  }
  const parsed = featurePricingOf({ ...planFeature, slug: planFeature.feature.slug })
  const dimensions =
    planFeature.featureType === "usage" && parsed.ok ? parsed.pricing.dimensions : []
  const dimension = input.dimension ?? (dimensions.length === 1 ? dimensions[0] : undefined)
  if (dimension === undefined || !dimensions.includes(dimension)) {
    return Err(new UnPriceRateCardError({ code: "DIMENSION_REQUIRED", featureSlug, dimensions }))
  }

  const assigned = await rateCards.cardForPlanVersion(projectId, planVersionId, USD)
  if (assigned) {
    const other = (await rateCards.versionsPricingWith(projectId, assigned.cardId)).find(
      (candidate) => candidate.planVersionId !== planVersionId
    )
    if (other) {
      return Err(
        new UnPriceRateCardError({
          code: "CARD_SHARED",
          cardId: assigned.cardId,
          planVersionId: other.planVersionId,
        })
      )
    }
  }
  const foundCard = assigned ? await rateCards.getCard(projectId, assigned.cardId) : null
  if (foundCard?.err) return Err(foundCard.err)
  const card: RateCard = foundCard?.val?.card ?? {
    id: "unsaved",
    projectId,
    name: versionCardName(version.plan.slug, planVersionId, USD),
    unit: "money:USD",
    marginPolicy: { type: "manual" },
  }
  const rows = foundCard?.val?.rows ?? []
  const featurePolicy = {
    featureSlug,
    markup: input.markup,
    roundTo: input.roundTo,
    dimension,
    componentMap: input.componentMap,
  }
  return Ok({ cardId: assigned?.cardId ?? null, card, rows, featurePolicy, dimension })
}

/** Previews one feature's policy without saving it. */
export async function previewPlanVersionCatalogPricing(
  deps: CatalogPricingDeps,
  input: CatalogPricingInput
) {
  const prepared = await prepareCatalogPricing(deps, input)
  if (prepared.err) return Err(prepared.err)
  const { cardId, card, rows, featurePolicy, dimension } = prepared.val
  const preview = costPlusPreview(
    { ...card, marginPolicy: withFeaturePolicy(card.marginPolicy, featurePolicy) },
    rows,
    await deps.services.modelCosts.costsAt(input.projectId, input.now),
    input.now,
    input.featureSlug
  )
  if (preview.err) return Err(preview.err)
  const drafted = new Set(
    preview.val.draft.changes.map((change) => change.proposed.match[dimension])
  )
  const tieredModels = MODEL_CATALOG.filter(
    (row) => row.tiers.length > 0 && drafted.has(row.model)
  ).map((row) => row.id)
  return Ok({ cardId, ...preview.val, tieredModels })
}

/** Applies exactly the reviewed feature revision, or rolls back policy, assignment and rows. */
export async function applyPlanVersionCatalogPricing(
  deps: CatalogPricingDeps & { db: Database },
  input: z.infer<typeof applyPlanVersionCatalogPricingInputSchema> & {
    projectId: string
    now: number
  }
): Promise<Result<PublishRowsResult, FetchError | UnPriceRateCardError>> {
  const result = await transactionResult<PublishRowsResult, FetchError | UnPriceRateCardError>(
    deps.db,
    async (tx) => {
      await deps.services.rateCards.lockPlanVersionCards(input.projectId, input.planVersionId, tx)
      const rateCards = deps.services.rateCards.withTransaction(tx)
      const services = { ...deps.services, rateCards }
      const prepared = await prepareCatalogPricing({ services }, input, tx)
      if (prepared.err) return Err(prepared.err)
      let cardId = prepared.val.cardId
      if (cardId === null) {
        const created = await rateCards.createCard(input.projectId, {
          name: prepared.val.card.name,
          unit: prepared.val.card.unit,
          marginPolicy: { type: "manual" },
        })
        if (created.err) return Err(created.err)
        cardId = created.val.id
        const assigned = await rateCards.assignToPlanVersion(input.projectId, {
          planVersionId: input.planVersionId,
          currency: USD,
          cardId,
        })
        if (assigned.err) return Err(assigned.err)
      }
      return rateCards.publishCostPlus({
        projectId: input.projectId,
        cardId,
        now: input.now,
        draftHash: input.draftHash,
        featureSlug: input.featureSlug,
        policy: prepared.val.featurePolicy,
      })
    }
  )
  return result
}
