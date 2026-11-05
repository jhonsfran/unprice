import { type PlanVersionCatalogPricingInput, currencySchema } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import { MODEL_CATALOG } from "../../budgets/model-catalog"
import type { ServiceContext } from "../../context"
import type { CostPlusDraft } from "../../pricing"
import {
  UnPriceRateCardError,
  planFeaturePricing,
  pricePlanVersion,
  versionCardName,
} from "../../rate-cards"
import { catalogEffectiveFrom, importModelCosts } from "./import-model-costs"

export type SetPlanVersionCatalogPricingDeps = {
  services: Pick<ServiceContext, "plans" | "features" | "rateCards">
}

export type SetPlanVersionCatalogPricingInput = PlanVersionCatalogPricingInput & {
  projectId: string
  now: number
}

export type SetPlanVersionCatalogPricingOutput = {
  cardId: string
  /** The card's cost-plus revision now, for the caller to review and publish under its hash. */
  draft: CostPlusDraft
  draftHash: string
  /**
   * Catalog ids of the drafted models that models.dev prices by context tier. The draft prices
   * them at their base tier; a long-context call costs the provider more than the row says.
   */
  tieredModels: string[]
}

const USD = currencySchema.parse("USD")

/**
 * Prices one feature's models from the cost catalog on the version's own card (ADR-0008 D3): the
 * bundled catalog is imported, the card gets a cost-plus policy for the feature, and the resulting
 * revision comes back as a draft for `publishCostPlus`. The version must be a USD draft, the
 * feature a usage feature that varies by the dimension carrying the model id, and the card the
 * version's own. Reruns rewrite the policy and import nothing new.
 */
export async function setPlanVersionCatalogPricing(
  deps: SetPlanVersionCatalogPricingDeps,
  input: SetPlanVersionCatalogPricingInput
): Promise<Result<SetPlanVersionCatalogPricingOutput, UnPriceRateCardError | FetchError>> {
  const { plans, rateCards } = deps.services
  const { projectId, planVersionId, featureSlug, now } = input

  const found = await plans.getPlanVersionByIdDetailed({ planVersionId, projectId })
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
  const parsed = planFeaturePricing(planFeature)
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
  const card = assigned
    ? Ok({ cardId: assigned.cardId })
    : await pricePlanVersion(deps, {
        projectId,
        planVersionId,
        currency: USD,
        cardName: versionCardName(version.plan.slug, planVersionId, USD),
        prices: [],
        now,
      })
  if (card.err) return Err(card.err)
  const { cardId } = card.val

  await importModelCosts(deps, { effectiveFrom: catalogEffectiveFrom() })
  const policy = await rateCards.setMarginPolicy(projectId, cardId, {
    featureSlug,
    markup: input.markup,
    roundTo: input.roundTo,
    dimension,
    componentMap: input.componentMap,
  })
  if (policy.err) return Err(policy.err)

  const preview = await rateCards.previewCostPlus(projectId, cardId, now)
  if (preview.err) return Err(preview.err)
  const drafted = new Set(
    preview.val.draft.changes.flatMap((change) =>
      change.proposed.featureSlug === featureSlug ? [change.proposed.match[dimension]] : []
    )
  )
  const tieredModels = MODEL_CATALOG.filter(
    (row) => row.tiers.length > 0 && drafted.has(row.model)
  ).map((row) => row.id)
  return Ok({ cardId, ...preview.val, tieredModels })
}
