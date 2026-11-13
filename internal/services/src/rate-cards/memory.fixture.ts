import type {
  AssignPlanVersionCardInput,
  CostPlusFeaturePolicy,
  CreateRateCardInput,
  CustomModelCost,
  FeaturePricing,
  ModelCost,
  RateCard,
  RateRow,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { vi } from "vitest"
import { MODEL_CATALOG, MODEL_CATALOG_VERSION } from "../budgets/model-catalog"
import { BUNDLED_COSTS, type ModelCostService, customAsModelCost } from "../model-costs/service"
import { type DecimalFeaturePrice, ratePriceOf } from "../pricing"
import { costPlusPreview, withFeaturePolicy } from "./catalog"
import { UnPriceRateCardError } from "./errors"
import { catalogCosts, changedCosts } from "./model-costs"
import {
  type PlanFeaturePricingInput,
  type PublishPlan,
  RATE_CHANGE_NOTICE_MS,
  featurePricingOf,
  planClose,
  planCostPlusPublish,
  planPublish,
  planRemoveFeature,
  unionFeaturePricing,
} from "./publish"
import type {
  CloseRowsInput,
  PlanVersionPricing,
  PublishRowsInput,
  PublishRowsResult,
  RateCardService,
} from "./service"
import { canonicalJson } from "./wire"

/** In-memory storage using the production planners and the live-card notice. */
export function createRateCardsFake(
  planFeaturesForVersion?: (planVersionId: string) => readonly PlanFeaturePricingInput[]
) {
  const cards = new Map<string, RateCard>()
  const rows: RateRow[] = []
  const costs: ModelCost[] = []
  const projectFeatures = new Map<string, FeaturePricing>()
  const customCosts: { projectId: string; cost: CustomModelCost }[] = []
  const assignments = new Map<string, string>()
  const published = new Set<string>()
  let sequence = 0
  const assignmentKey = (planVersionId: string, currency: string) => `${planVersionId}:${currency}`

  const modelCosts = {
    importBundled: vi.fn(async (effectiveFrom: number) => {
      const proposed = catalogCosts(MODEL_CATALOG, MODEL_CATALOG_VERSION, effectiveFrom)
      const latest = new Map<string, ModelCost>()
      for (const cost of costs) {
        if (cost.source !== "modelsdev") continue
        const key = `${cost.provider}/${cost.model}`
        const seen = latest.get(key)
        if (!seen || cost.effectiveFrom > seen.effectiveFrom) latest.set(key, cost)
      }
      const inserted = await insertCosts(changedCosts([...latest.values()], proposed))
      return { inserted, unchanged: proposed.length - inserted }
    }),
    costsAt: vi.fn(async (projectId: string, at: number) => [
      ...BUNDLED_COSTS.filter((cost) => cost.effectiveFrom <= at),
      ...costs.filter((cost) => cost.effectiveFrom <= at),
      ...customCosts
        .filter((entry) => entry.projectId === projectId && entry.cost.effectiveFrom <= at)
        .map((entry) => customAsModelCost(entry.cost)),
    ]),
    addCustom: vi.fn(
      async (
        projectId: string,
        cost: Parameters<ModelCostService["addCustom"]>[1],
        now: number
      ): Promise<CustomModelCost> => {
        const stored = { ...cost, effectiveFrom: now, id: `cmc_${customCosts.length + 1}` }
        customCosts.push({ projectId, cost: stored })
        return stored
      }
    ),
    listCustom: vi.fn(async (projectId: string): Promise<CustomModelCost[]> => {
      const latest = new Map<string, CustomModelCost>()
      for (const { projectId: owner, cost } of customCosts) {
        if (owner !== projectId) continue
        const key = `${cost.provider}/${cost.model}`
        const seen = latest.get(key)
        if (!seen || cost.effectiveFrom >= seen.effectiveFrom) latest.set(key, cost)
      }
      return [...latest.values()].sort((a, b) =>
        a.provider === b.provider
          ? a.model.localeCompare(b.model)
          : a.provider.localeCompare(b.provider)
      )
    }),
  }

  async function insertCosts(proposed: readonly ModelCost[]) {
    const stored = new Set(
      costs.map((cost) =>
        canonicalJson([cost.provider, cost.model, cost.source, cost.effectiveFrom])
      )
    )
    let inserted = 0
    for (const cost of proposed) {
      const key = canonicalJson([cost.provider, cost.model, cost.source, cost.effectiveFrom])
      if (stored.has(key)) continue
      stored.add(key)
      costs.push({ ...cost, sourceRef: `mc_${costs.length + 1}` })
      inserted++
    }
    return inserted
  }

  const rateCards = {
    withTransaction: vi.fn<RateCardService["withTransaction"]>(),
    publishCostPlus: vi.fn<RateCardService["publishCostPlus"]>(),
    lockPlanVersionCards: vi.fn(async () => [] as string[]),
    cardForPlanVersion: vi.fn(
      async (_projectId: string, planVersionId: string, currency: RateCard["unit"]) => {
        const cardId = assignments.get(assignmentKey(planVersionId, currency))
        const card = cardId ? cards.get(cardId) : undefined
        return card ? { planVersionId, currency, cardId: card.id, unit: card.unit } : null
      }
    ),
    createCard: vi.fn(async (projectId: string, input: CreateRateCardInput) => {
      if ([...cards.values()].some((card) => card.name === input.name))
        return Err(new UnPriceRateCardError({ code: "CARD_NAME_TAKEN", name: input.name }))
      const card: RateCard = { ...input, id: `rc_${++sequence}`, projectId }
      cards.set(card.id, card)
      return Ok(card)
    }),
    cardByName: vi.fn(
      async (_projectId: string, name: string) =>
        [...cards.values()].find((card) => card.name === name) ?? null
    ),
    getCard: vi.fn(async (_projectId: string, cardId: string) => {
      const card = cards.get(cardId)
      if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
      return Ok({
        card,
        rows: cardRows(cardId),
        live: [...assignments].some(
          ([key, id]) => id === cardId && published.has(key.split(":")[0] ?? "")
        ),
      })
    }),
    featuresPricingWith: vi.fn<RateCardService["featuresPricingWith"]>(
      async (projectId, cardId) => {
        if (!planFeaturesForVersion) return null
        const versions = [...assignments]
          .filter(
            ([, assigned]) => assigned === cardId && cards.get(cardId)?.projectId === projectId
          )
          .map(([key]) => key.split(":")[0] ?? "")
        if (versions.length === 0) return null
        return unionFeaturePricing(
          versions.flatMap((id) =>
            planFeaturesForVersion(id).map((feature) =>
              featurePricingOf({ ...feature, slug: feature.feature.slug })
            )
          )
        )
      }
    ),
    publishRows: vi.fn(
      async (input: PublishRowsInput): Promise<Result<PublishRowsResult, UnPriceRateCardError>> => {
        const card = cards.get(input.cardId)
        if (!card)
          return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId: input.cardId }))
        const features = await featurePricing(input.projectId, input.cardId)
        const plan = planPublish({
          ...input,
          card,
          rows: cardRows(input.cardId),
          ...features,
          drafts: input.drafts.map((draft) => ({
            ...draft,
            source: draft.source ?? "manual",
            sourceRef: draft.sourceRef ?? null,
          })),
          noticeMs: await noticeFor(input.projectId, input.cardId),
          newRowId: () => `rr_${++sequence}`,
        })
        if (plan.err) return Err(plan.err)
        applyRows(plan.val)
        return Ok(publishResult(plan.val))
      }
    ),
    closeRows: vi.fn(async (input: CloseRowsInput) => {
      if (!cards.has(input.cardId))
        return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId: input.cardId }))
      const plan = planClose({
        ...input,
        rows: cardRows(input.cardId),
        noticeMs: await noticeFor(input.projectId, input.cardId),
      })
      if (plan.err) return Err(plan.err)
      applyCloses(plan.val.closes)
      return Ok({ closed: [...plan.val.closes], unchanged: plan.val.unchanged })
    }),
    assignToPlanVersion: vi.fn(async (_projectId: string, input: AssignPlanVersionCardInput) => {
      assignments.set(assignmentKey(input.planVersionId, input.currency), input.cardId)
      const card = cards.get(input.cardId)
      return Ok({ ...input, unit: card?.unit ?? `money:${input.currency}` })
    }),
    versionsPricingWith: vi.fn(async (_projectId: string, cardId: string) =>
      [...assignments]
        .filter(([, assigned]) => assigned === cardId)
        .map(([key]) => {
          const [planVersionId, currency] = key.split(":") as [
            string,
            PlanVersionPricing["currency"],
          ]
          return { planVersionId, currency, publishedAt: published.has(planVersionId) ? 1 : null }
        })
    ),
    pricingForPlanVersions: vi.fn(
      async (
        _projectId: string,
        planVersionIds: readonly string[],
        at: number,
        until: number | { scheduled: true } = at + 1
      ) => {
        const byVersion = new Map<string, PlanVersionPricing[]>()
        for (const [key, cardId] of assignments) {
          const [planVersionId, currency] = key.split(":") as [
            string,
            PlanVersionPricing["currency"],
          ]
          const card = cards.get(cardId)
          if (!card || !planVersionIds.includes(planVersionId)) continue
          const pricing = byVersion.get(planVersionId) ?? []
          pricing.push({
            currency,
            card,
            rows: cardRows(cardId).filter(
              (row) =>
                (typeof until !== "number" || row.effectiveFrom < until) &&
                (row.effectiveTo === null || row.effectiveTo > at)
            ),
          })
          byVersion.set(planVersionId, pricing)
        }
        return byVersion
      }
    ),
    removeFeaturePrices: vi.fn(
      async (input: { projectId: string; cardId: string; featureSlug: string; now: number }) => {
        const card = cards.get(input.cardId)
        if (!card)
          return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId: input.cardId }))
        const plan = planRemoveFeature({
          ...input,
          card,
          rows: cardRows(input.cardId),
          assigned: await rateCards.featuresPricingWith(input.projectId, input.cardId),
          noticeMs: await noticeFor(input.projectId, input.cardId),
        })
        if (plan.err) return Err(plan.err)
        if (!plan.val) return Ok(undefined)
        applyCloses(plan.val.closes)
        cards.set(card.id, { ...card, marginPolicy: plan.val.marginPolicy })
        return Ok(undefined)
      }
    ),
    previewCostPlus: vi.fn(
      async (
        _projectId: string,
        cardId: string,
        at: number,
        options?: { policy?: CostPlusFeaturePolicy; featureSlug?: string }
      ) => {
        const saved = cards.get(cardId)
        if (!saved) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
        const card = options?.policy
          ? { ...saved, marginPolicy: withFeaturePolicy(saved.marginPolicy, options.policy) }
          : saved
        return costPlusPreview(
          card,
          cardRows(cardId),
          await modelCosts.costsAt(card.projectId, at),
          at,
          options?.featureSlug
        )
      }
    ),
  }

  rateCards.withTransaction.mockReturnValue(rateCards as unknown as RateCardService)
  rateCards.publishCostPlus.mockImplementation(async (input) => {
    const card = cards.get(input.cardId)
    if (!card)
      return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId: input.cardId }))
    const features = await featurePricing(input.projectId, input.cardId)
    const plan = planCostPlusPublish({
      ...input,
      card,
      rows: cardRows(input.cardId),
      ...features,
      costs: await modelCosts.costsAt(input.projectId, input.now),
      noticeMs: await noticeFor(input.projectId, input.cardId),
      newRowId: () => `rr_${++sequence}`,
    })
    if (plan.err) return Err(plan.err)
    applyRows(plan.val)
    if (input.policy) cards.set(card.id, { ...card, marginPolicy: plan.val.marginPolicy })
    return Ok(publishResult(plan.val))
  })

  function cardRows(cardId: string) {
    return rows.filter((row) => row.rateCardId === cardId)
  }
  async function featurePricing(projectId: string, cardId: string) {
    return (
      (await rateCards.featuresPricingWith(projectId, cardId)) ?? {
        features: [...projectFeatures.values()],
        unpriceable: [],
      }
    )
  }
  async function noticeFor(projectId: string, cardId: string) {
    return (await rateCards.versionsPricingWith(projectId, cardId)).some(
      (version) => version.publishedAt !== null
    )
      ? RATE_CHANGE_NOTICE_MS
      : 0
  }
  function applyCloses(closes: readonly { rowId: string; effectiveTo: number }[]) {
    for (const close of closes) {
      const row = rows.find((candidate) => candidate.id === close.rowId)
      if (!row) throw new Error("fixture: planner closed an unknown row")
      row.effectiveTo = close.effectiveTo
    }
  }
  function applyRows(plan: PublishPlan) {
    applyCloses(plan.closes)
    rows.push(...plan.inserts)
  }
  function publishResult(plan: PublishPlan): PublishRowsResult {
    return { inserted: [...plan.inserts], closed: [...plan.closes], unchanged: plan.unchanged }
  }

  /** Seeds one default row per feature without publishing. */
  function seedPlanVersionCard(
    planVersionId: string,
    currency: string,
    prices: readonly (DecimalFeaturePrice & { featureSlug: string; property?: string | null })[]
  ) {
    const card: RateCard = {
      id: `rc_${++sequence}`,
      projectId: "seeded",
      name: `seeded ${planVersionId}`,
      unit: `money:${currency}`,
      marginPolicy: { type: "manual" },
    }
    cards.set(card.id, card)
    assignments.set(assignmentKey(planVersionId, currency), card.id)
    for (const price of prices) {
      projectFeatures.set(price.featureSlug, {
        slug: price.featureSlug,
        dimensions: [],
        meterProperty: price.property ?? null,
        included: null,
      })
      const ratePrice = ratePriceOf(price, price.property ?? null)
      if (!ratePrice) throw new Error(`fixture: ${price.featureSlug} has no price`)
      rows.push({
        id: `rr_${++sequence}`,
        rateCardId: card.id,
        featureSlug: price.featureSlug,
        match: {},
        price: ratePrice,
        cost: null,
        effectiveFrom: 0,
        effectiveTo: null,
        source: "manual",
        sourceRef: null,
      })
    }
    return card
  }

  return {
    rateCards,
    modelCosts,
    projectFeatures,
    insertCosts,
    rows,
    cards,
    costs,
    customCosts,
    assignments,
    published,
    seedPlanVersionCard,
  }
}
