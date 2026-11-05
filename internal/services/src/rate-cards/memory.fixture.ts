import type {
  AssignPlanVersionCardInput,
  CreateRateCardInput,
  RateCard,
  RatePrice,
  RateRow,
} from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { vi } from "vitest"
import { isEffective, matchKey, ratePriceOf } from "../pricing"
import type { DecimalFeaturePrice } from "../pricing"
import type { PlanVersionPricing, PublishRowsInput } from "./service"

function samePrice(a: RatePrice, b: RatePrice): boolean {
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, inner) => (typeof inner === "bigint" ? inner.toString() : inner))
  return json(a) === json(b)
}

/**
 * An in-memory `RateCardService` for use-case tests: cards, their rows, and plan version
 * assignments. A publish replaces the open row of the same feature and match and skips an
 * identical one, like the real service; it checks no notice and no card rules.
 */
export function createRateCardsFake() {
  const cards = new Map<string, RateCard>()
  const rows: RateRow[] = []
  const assignments = new Map<string, string>()
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
      sequence += 1
      const card = { ...input, id: `rc_${sequence}`, projectId } as RateCard
      cards.set(card.id, card)
      return Ok(card)
    }),
    publishRows: vi.fn(async (input: PublishRowsInput) => {
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
          open.effectiveTo = input.effectiveFrom
          closed.push({ rowId: open.id, effectiveTo: input.effectiveFrom })
        }
        sequence += 1
        const row: RateRow = {
          ...draft,
          id: `rr_${sequence}`,
          rateCardId: input.cardId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
        }
        rows.push(row)
        inserted.push(row)
      }
      return Ok({ inserted, closed, unchanged })
    }),
    assignToPlanVersion: vi.fn(async (_projectId: string, input: AssignPlanVersionCardInput) => {
      assignments.set(assignmentKey(input.planVersionId, input.currency), input.cardId)
      const card = cards.get(input.cardId)
      return Ok({ ...input, unit: card?.unit ?? `money:${input.currency}` })
    }),
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

  return { rateCards, rows, cards, seedPlanVersionCard }
}
