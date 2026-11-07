import type {
  AssignPlanVersionCardInput,
  CostPlusFeaturePolicy,
  CreateRateCardInput,
  CustomModelCost,
  FeaturePricing,
  ModelCost,
  RateCard,
  RatePrice,
  RateRow,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { vi } from "vitest"
import {
  type CostPlusCard,
  costPlusRevision,
  isEffective,
  matchKey,
  ratePriceOf,
  writesRow,
} from "../pricing"
import type { DecimalFeaturePrice } from "../pricing"
import {
  customAsModelCost,
  draftHash,
  hasFeaturePolicy,
  retainFeaturePolicies,
  withFeaturePolicy,
} from "./catalog"
import { UnPriceRateCardError } from "./errors"
import type {
  CloseRowsInput,
  PlanVersionPricing,
  PublishRowsInput,
  PublishRowsResult,
  RateCardService,
} from "./service"
import { canonicalJson } from "./wire"

function samePrice(a: RatePrice, b: RatePrice): boolean {
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, inner) => (typeof inner === "bigint" ? inner.toString() : inner))
  return json(a) === json(b)
}

/**
 * An in-memory `RateCardService` for use-case tests: cards, their rows, plan version assignments
 * and the imported cost catalog. A publish replaces the open row of the same feature and match
 * and skips an identical one, like the real service; it checks no notice and no card rules. Rows
 * start at the given time, or at `now` when the caller left it to the card.
 */
export function createRateCardsFake() {
  const cards = new Map<string, RateCard>()
  const rows: RateRow[] = []
  const costs: ModelCost[] = []
  /** Each project's own model costs, newest last. */
  const customCosts: { projectId: string; cost: CustomModelCost }[] = []
  const assignments = new Map<string, string>()
  /** Versions a test published; a card assigned to one is live. */
  const published = new Set<string>()
  let sequence = 0
  const assignmentKey = (planVersionId: string, currency: string) => `${planVersionId}:${currency}`

  const rateCards = {
    withTransaction: vi.fn<RateCardService["withTransaction"]>(),
    publishCostPlus: vi.fn<RateCardService["publishCostPlus"]>(),
    lockPlanVersionCards: vi.fn(async () => [] as string[]),
    invalidatePlanVersionPrices: vi.fn(async (_ids: string[]) => {}),
    cardForPlanVersion: vi.fn(
      async (_projectId: string, planVersionId: string, currency: RateCard["unit"]) => {
        const cardId = assignments.get(assignmentKey(planVersionId, currency))
        const card = cardId ? cards.get(cardId) : undefined
        return card ? { planVersionId, currency, cardId: card.id, unit: card.unit } : null
      }
    ),
    createCard: vi.fn(async (projectId: string, input: CreateRateCardInput) => {
      if ([...cards.values()].some((card) => card.name === input.name)) {
        return Err(new UnPriceRateCardError({ code: "CARD_NAME_TAKEN", name: input.name }))
      }
      sequence += 1
      const card = { ...input, id: `rc_${sequence}`, projectId } as RateCard
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
      return Ok({ card, rows: rows.filter((row) => row.rateCardId === cardId) })
    }),
    publishRows: vi.fn(
      async (input: PublishRowsInput): Promise<Result<PublishRowsResult, UnPriceRateCardError>> => {
        const effectiveFrom = input.effectiveFrom ?? input.now
        const inserted: RateRow[] = []
        const closed: { rowId: string; effectiveTo: number }[] = []
        let unchanged = 0
        for (const draft of input.drafts) {
          const open = rows.find(
            (row) =>
              row.rateCardId === input.cardId &&
              row.featureSlug === draft.featureSlug &&
              matchKey(row.match) === matchKey(draft.match) &&
              row.effectiveTo === null
          )
          if (open && samePrice(open.price, draft.price)) {
            unchanged += 1
            continue
          }
          if (open) {
            open.effectiveTo = effectiveFrom
            closed.push({ rowId: open.id, effectiveTo: effectiveFrom })
          }
          sequence += 1
          const row: RateRow = {
            ...draft,
            id: `rr_${sequence}`,
            rateCardId: input.cardId,
            effectiveFrom,
            effectiveTo: null,
          }
          rows.push(row)
          inserted.push(row)
        }
        for (const rowId of input.closeRowIds ?? []) {
          const row = rows.find((candidate) => candidate.id === rowId)
          if (!row) return Err(new UnPriceRateCardError({ code: "ROW_NOT_FOUND", rowIds: [rowId] }))
          if (row.effectiveTo !== null || closed.some((close) => close.rowId === rowId)) {
            unchanged += 1
            continue
          }
          row.effectiveTo = effectiveFrom
          closed.push({ rowId, effectiveTo: effectiveFrom })
        }
        return Ok({ inserted, closed, unchanged })
      }
    ),
    closeRows: vi.fn(async (input: CloseRowsInput) => {
      const effectiveTo = input.effectiveTo ?? input.now
      const closed: { rowId: string; effectiveTo: number }[] = []
      let unchanged = 0
      for (const rowId of input.rowIds) {
        const row = rows.find((candidate) => candidate.id === rowId)
        if (!row) return Err(new UnPriceRateCardError({ code: "ROW_NOT_FOUND", rowIds: [rowId] }))
        if (row.effectiveTo !== null) {
          unchanged += 1
          continue
        }
        row.effectiveTo = effectiveTo
        closed.push({ rowId, effectiveTo })
      }
      return Ok({ closed, unchanged })
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
          const [planVersionId, currency] = key.split(":") as [string, string]
          return {
            planVersionId,
            currency: currency as PlanVersionPricing["currency"],
            publishedAt: published.has(planVersionId) ? 1 : null,
          }
        })
    ),
    /** Null: the fake keeps no plan features, so a card is checked against the project's. */
    featuresPricingWith: vi.fn(
      async (): Promise<{ features: FeaturePricing[]; unpriceable: [] } | null> => null
    ),
    pricingForPlanVersions: vi.fn(
      async (_projectId: string, planVersionIds: readonly string[], at: number) => {
        const byVersion = new Map<string, PlanVersionPricing[]>()
        for (const [key, cardId] of assignments) {
          const [planVersionId, currency] = key.split(":") as [string, string]
          const card = cards.get(cardId)
          if (!card || !planVersionIds.includes(planVersionId)) continue
          const pricing = byVersion.get(planVersionId) ?? []
          pricing.push({
            currency: currency as PlanVersionPricing["currency"],
            card,
            rows: rows.filter((row) => row.rateCardId === cardId && isEffective(row, at)),
          })
          byVersion.set(planVersionId, pricing)
        }
        return byVersion
      }
    ),
    removeFeaturePrices: vi.fn(
      async (input: { projectId: string; cardId: string; featureSlug: string; now: number }) => {
        const assigned = await rateCards.featuresPricingWith()
        if (
          assigned?.features.some((feature: { slug: string }) => feature.slug === input.featureSlug)
        )
          return Ok(undefined)
        const shared =
          [...assignments.values()].filter((cardId) => cardId === input.cardId).length > 1
        if (shared) return Ok(undefined)
        const card = cards.get(input.cardId)
        if (!card)
          return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId: input.cardId }))
        const closed = await rateCards.closeRows({
          ...input,
          rowIds: rows
            .filter((row) => row.featureSlug === input.featureSlug && row.effectiveTo === null)
            .map((row) => row.id),
        })
        if (closed.err) return Err(closed.err)
        cards.set(card.id, {
          ...card,
          marginPolicy: retainFeaturePolicies(
            card.marginPolicy,
            (policy) => policy.featureSlug !== input.featureSlug
          ),
        })
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
        if (card.marginPolicy.type !== "costPlus") {
          return Err(new UnPriceRateCardError({ code: "NOT_COST_PLUS", cardId }))
        }
        const costPlusCard: CostPlusCard = {
          ...card,
          marginPolicy: {
            ...card.marginPolicy,
            features: card.marginPolicy.features.filter(
              (policy) =>
                options?.featureSlug === undefined || policy.featureSlug === options.featureSlug
            ),
          },
        }
        const draft = costPlusRevision(
          costPlusCard,
          [
            ...costs,
            ...customCosts
              .filter((entry) => entry.projectId === card.projectId)
              .map((entry) => customAsModelCost(entry.cost)),
          ],
          rows.filter((row) => row.rateCardId === cardId),
          at
        )
        return Ok({ draft, draftHash: draftHash(draft) })
      }
    ),
    latestImportedCosts: vi.fn(async () => {
      const latest = new Map<string, ModelCost>()
      for (const cost of costs) {
        if (cost.source !== "modelsdev") continue
        const key = `${cost.provider}/${cost.model}`
        const seen = latest.get(key)
        if (!seen || cost.effectiveFrom > seen.effectiveFrom) latest.set(key, cost)
      }
      return [...latest.values()]
    }),
    insertCustomModelCost: vi.fn(
      async (projectId: string, cost: Omit<CustomModelCost, "id">): Promise<CustomModelCost> => {
        const stored = { ...cost, id: `cmc_${customCosts.length + 1}` }
        customCosts.push({ projectId, cost: stored })
        return stored
      }
    ),
    customModelCosts: vi.fn(async (projectId: string): Promise<CustomModelCost[]> => {
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
    insertModelCosts: vi.fn(async (proposed: readonly ModelCost[]) => {
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
        inserted += 1
      }
      return inserted
    }),
  }

  rateCards.withTransaction.mockReturnValue(rateCards as unknown as RateCardService)
  rateCards.publishCostPlus.mockImplementation(async (input) => {
    const preview = await rateCards.previewCostPlus(input.projectId, input.cardId, input.now, {
      policy: input.policy,
      featureSlug: input.featureSlug,
    })
    if (preview.err) return Err(preview.err)
    const saved = cards.get(input.cardId)
    if (
      (!input.policy || (saved && hasFeaturePolicy(saved.marginPolicy, input.policy))) &&
      !preview.val.draft.changes.some(writesRow)
    )
      return Ok({ inserted: [], closed: [], unchanged: preview.val.draft.changes.length })
    if (preview.val.draftHash !== input.draftHash)
      return Err(
        new UnPriceRateCardError({ code: "DRAFT_STALE", draftHash: preview.val.draftHash })
      )
    const changes = preview.val.draft.changes
    const drafts = changes.filter(writesRow).map((change) => change.proposed)
    const published = await rateCards.publishRows({ ...input, drafts })
    if (published.err) return Err(published.err)
    const card = cards.get(input.cardId)
    if (input.policy && card)
      cards.set(card.id, {
        ...card,
        marginPolicy: withFeaturePolicy(card.marginPolicy, input.policy),
      })
    return Ok({
      ...published.val,
      unchanged: published.val.unchanged + changes.length - drafts.length,
    })
  })

  /** Prices a seeded plan version directly: one default row per feature on its own card. */
  function seedPlanVersionCard(
    planVersionId: string,
    currency: string,
    prices: readonly (DecimalFeaturePrice & { featureSlug: string; property?: string | null })[]
  ) {
    sequence += 1
    const card = {
      id: `rc_${sequence}`,
      projectId: "seeded",
      name: `seeded ${planVersionId}`,
      unit: `money:${currency}`,
      marginPolicy: { type: "manual" },
    } as RateCard
    cards.set(card.id, card)
    assignments.set(assignmentKey(planVersionId, currency), card.id)
    for (const price of prices) {
      const ratePrice = ratePriceOf(price, price.property ?? null)
      if (!ratePrice) throw new Error(`fixture: ${price.featureSlug} has no price`)
      sequence += 1
      rows.push({
        id: `rr_${sequence}`,
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
    rows,
    cards,
    costs,
    customCosts,
    assignments,
    published,
    seedPlanVersionCard,
  }
}
