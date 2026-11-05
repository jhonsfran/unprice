import type {
  AssignPlanVersionCardInput,
  CostPlusFeaturePolicy,
  CreateRateCardInput,
  ModelCost,
  RateCard,
  RatePrice,
  RateRow,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { vi } from "vitest"
import { type CostPlusCard, costPlusRevision, isEffective, matchKey, ratePriceOf } from "../pricing"
import type { DecimalFeaturePrice } from "../pricing"
import { UnPriceRateCardError } from "./errors"
import type {
  CloseRowsInput,
  PlanVersionPricing,
  PublishRowsInput,
  PublishRowsResult,
} from "./service"
import { draftHash } from "./service"
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
  const assignments = new Map<string, string>()
  /** Versions a test published; a card assigned to one is live. */
  const published = new Set<string>()
  let sequence = 0
  const assignmentKey = (planVersionId: string, currency: string) => `${planVersionId}:${currency}`

  const rateCards = {
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
    featuresPricingWith: vi.fn(async () => null),
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
    setMarginPolicy: vi.fn(
      async (_projectId: string, cardId: string, policy: CostPlusFeaturePolicy) => {
        const card = cards.get(cardId)
        if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
        if (card.unit.startsWith("money:") && card.unit !== "money:USD") {
          return Err(new UnPriceRateCardError({ code: "CATALOG_USD_ONLY", unit: card.unit }))
        }
        const kept =
          card.marginPolicy.type === "costPlus"
            ? card.marginPolicy.features.filter((other) => other.featureSlug !== policy.featureSlug)
            : []
        const updated: RateCard = {
          ...card,
          marginPolicy: { type: "costPlus", features: [...kept, policy] },
        }
        cards.set(cardId, updated)
        return Ok(updated)
      }
    ),
    previewCostPlus: vi.fn(async (_projectId: string, cardId: string, at: number) => {
      const card = cards.get(cardId)
      if (!card) return Err(new UnPriceRateCardError({ code: "CARD_NOT_FOUND", cardId }))
      if (card.marginPolicy.type !== "costPlus") {
        return Err(new UnPriceRateCardError({ code: "NOT_COST_PLUS", cardId }))
      }
      const costPlusCard: CostPlusCard = { ...card, marginPolicy: card.marginPolicy }
      const draft = costPlusRevision(
        costPlusCard,
        costs,
        rows.filter((row) => row.rateCardId === cardId),
        at
      )
      return Ok({ draft, draftHash: draftHash(draft) })
    }),
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

  return { rateCards, rows, cards, costs, assignments, published, seedPlanVersionCard }
}
