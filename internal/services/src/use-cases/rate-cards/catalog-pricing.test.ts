import type { Database } from "@unprice/db"
import {
  type Feature,
  type MeterConfig,
  type Plan,
  type PlanVersion,
  type PlanVersionFeature,
  planVersionCatalogPricingInputSchema,
} from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import { describe, expect, it, vi } from "vitest"
import { MODEL_CATALOG } from "../../budgets/model-catalog"
import type { ServiceContext } from "../../context"
import { UnPriceRateCardError } from "../../rate-cards"
import { createRateCardsFake } from "../../rate-cards/memory.fixture"

function rejectionOf(err: Error | undefined) {
  return err instanceof UnPriceRateCardError ? err.rejection : err
}
import { applyPlanVersionCatalogPricing, previewPlanVersionCatalogPricing } from "./catalog-pricing"
import { catalogEffectiveFrom } from "./import-model-costs"

const NOW = Date.parse("2026-11-10T12:00:00.000Z")
const PROJECT = "proj_1"

type Detailed = PlanVersion & {
  plan: Plan
  planFeatures: Array<PlanVersionFeature & { feature: Feature }>
}

const tokensMeter: MeterConfig = {
  eventId: "evt_tokens",
  eventSlug: "tokens",
  aggregationMethod: "sum",
  aggregationField: "input_tokens",
  groupBy: ["model"],
}

function planFeature(slug: string, meterConfig: MeterConfig | null, featureType = "usage") {
  return {
    id: `fpv_${slug}`,
    featureType,
    config: { usageMode: "unit" },
    meterConfig,
    included: null,
    feature: { id: `ft_${slug}`, slug },
  } as unknown as PlanVersionFeature & { feature: Feature }
}

function createHarness(overrides: Partial<Detailed> = {}) {
  const cards = createRateCardsFake()
  const version = {
    id: "pv_1",
    projectId: PROJECT,
    planId: "plan_1",
    currency: "USD",
    status: "draft",
    plan: { id: "plan_1", slug: "starter" },
    planFeatures: [planFeature("llm_tokens", tokensMeter)],
    ...overrides,
  } as unknown as Detailed
  const services = {
    plans: { getPlanVersionByIdDetailed: vi.fn(async () => Ok(version)) },
    features: { listFeaturesByProject: vi.fn(async () => Ok([])) },
    rateCards: cards.rateCards,
  } as unknown as Pick<ServiceContext, "plans" | "features" | "rateCards">
  return { cards, services }
}

function price(
  services: Pick<ServiceContext, "plans" | "features" | "rateCards">,
  fields: Record<string, unknown> = {}
) {
  return previewPlanVersionCatalogPricing(
    { services },
    {
      ...planVersionCatalogPricingInputSchema.parse({
        planVersionId: "pv_1",
        featureSlug: "llm_tokens",
        markup: "0.3",
        roundTo: "0.01",
        componentMap: { input: "input_tokens", output: "output_tokens" },
        ...fields,
      }),
      projectId: PROJECT,
      now: NOW,
    }
  )
}

async function apply(
  services: Pick<ServiceContext, "plans" | "features" | "rateCards">,
  draftHash: string,
  fields: Record<string, unknown> = {}
) {
  const db = {
    transaction: async (write: (tx: unknown) => Promise<unknown>) => write({}),
  } as unknown as Database
  return applyPlanVersionCatalogPricing(
    { db, services },
    {
      ...planVersionCatalogPricingInputSchema.parse({
        planVersionId: "pv_1",
        featureSlug: "llm_tokens",
        markup: "0.3",
        roundTo: "0.01",
        componentMap: { input: "input_tokens", output: "output_tokens" },
        ...fields,
      }),
      projectId: PROJECT,
      now: NOW,
      draftHash,
    }
  )
}

describe("previewPlanVersionCatalogPricing", () => {
  it("imports the catalog at its version date and previews every model without saving a policy", async () => {
    const { cards, services } = createHarness()

    const result = await price(services)
    if (result.err) throw result.err
    const { cardId, draft, draftHash, tieredModels } = result.val
    const haiku = draft.changes.find((change) => change.proposed.match.model === "claude-haiku-4-5")
    const rerun = await price(services, { markup: "0.5" })
    if (rerun.err) throw rerun.err

    expect(cards.cards.get(cardId)).toMatchObject({
      name: "starter pv_1 USD",
      unit: "money:USD",
      marginPolicy: { type: "manual" },
    })
    expect(cards.assignments.get("pv_1:USD")).toBe(cardId)
    expect(cards.costs).toHaveLength(MODEL_CATALOG.length)
    expect(new Set(cards.costs.map((cost) => cost.effectiveFrom))).toEqual(
      new Set([Date.parse("2026-10-20T00:00:00.000Z")])
    )
    expect(catalogEffectiveFrom("2026-10-20")).toBe(Date.parse("2026-10-20T00:00:00.000Z"))
    expect(draft.changes).toHaveLength(new Set(MODEL_CATALOG.map((row) => row.model)).size)
    expect(
      haiku && [
        haiku.type,
        haiku.proposed.price.components.map((c) => `${c.property}=${formatAmount(c.rate)}`),
      ]
    ).toEqual(["added", ["input_tokens=1.3", "output_tokens=6.5"]])
    expect(draftHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tieredModels).toEqual(
      MODEL_CATALOG.filter((row) => row.tiers.length > 0).map((row) => row.id)
    )
    expect(rerun.val.cardId).toBe(cardId)
    expect(rerun.val.draftHash).not.toBe(draftHash)
    expect(cards.cards.get(cardId)?.marginPolicy).toEqual({ type: "manual" })
  })

  it("applies the reviewed markup and leaves a later preview unsaved", async () => {
    const { cards, services } = createHarness()
    const saved = await price(services)
    if (saved.err) throw saved.err

    const applied = await apply(services, saved.val.draftHash)
    expect(applied.err).toBeUndefined()
    const dry = await price(services, { markup: "0.5" })
    if (dry.err) throw dry.err
    const haiku = dry.val.draft.changes.find(
      (change) => change.proposed.match.model === "claude-haiku-4-5"
    )

    expect(cards.cards.get(saved.val.cardId)?.marginPolicy).toMatchObject({
      features: [{ featureSlug: "llm_tokens", markup: BigInt(30_000_000) }],
    })
    expect(haiku?.proposed.price.components.map((c) => formatAmount(c.rate))).toEqual([
      "1.5",
      "7.5",
    ])
  })

  it("keeps one policy per feature, so a card prices several features from the catalog", async () => {
    const { cards, services } = createHarness({
      planFeatures: [planFeature("llm_tokens", tokensMeter), planFeature("images", tokensMeter)],
    })

    const first = await price(services)
    if (first.err) throw first.err
    expect((await apply(services, first.val.draftHash)).err).toBeUndefined()
    const second = await price(services, {
      featureSlug: "images",
      componentMap: { input: "pixels" },
    })
    if (second.err) throw second.err
    expect(
      (
        await apply(services, second.val.draftHash, {
          featureSlug: "images",
          componentMap: { input: "pixels" },
        })
      ).err
    ).toBeUndefined()
    if (first.err || second.err) throw first.err ?? second.err

    expect(cards.cards.get(second.val.cardId)?.marginPolicy).toMatchObject({
      type: "costPlus",
      features: [{ featureSlug: "llm_tokens" }, { featureSlug: "images" }],
    })
    expect(new Set(second.val.draft.changes.map((change) => change.proposed.featureSlug))).toEqual(
      new Set(["images"])
    )
    expect(second.val.draft.changes).toHaveLength(first.val.draft.changes.length)
  })

  it("refuses a non-USD version, a feature without a model dimension, a shared card, and a published version", async () => {
    const euros = createHarness({ currency: "EUR" } as Partial<Detailed>)
    const flat = createHarness({
      planFeatures: [planFeature("llm_tokens", { ...tokensMeter, groupBy: ["model", "region"] })],
    })
    const shared = createHarness()
    const card = shared.cards.seedPlanVersionCard("pv_1", "USD", [])
    shared.cards.assignments.set("pv_2:USD", card.id)
    const published = createHarness({ status: "published" } as Partial<Detailed>)

    expect(rejectionOf((await price(euros.services)).err)).toEqual({
      code: "CATALOG_USD_ONLY",
      unit: "money:EUR",
    })
    expect(rejectionOf((await price(flat.services)).err)).toEqual({
      code: "DIMENSION_REQUIRED",
      featureSlug: "llm_tokens",
      dimensions: ["model", "region"],
    })
    expect(
      (await price(flat.services, { dimension: "region" })).val?.draft.changes[0]
    ).toMatchObject({ proposed: { match: { region: expect.any(String) } } })
    expect(rejectionOf((await price(shared.services)).err)).toEqual({
      code: "CARD_SHARED",
      cardId: card.id,
      planVersionId: "pv_2",
    })
    expect(rejectionOf((await price(published.services)).err)).toEqual({
      code: "PLAN_VERSION_PUBLISHED",
      planVersionId: "pv_1",
    })
    expect(euros.cards.cards.size).toBe(0)
  })
})

it("rejects an apply after provider costs change without saving the policy", async () => {
  const { cards, services } = createHarness()
  const preview = await price(services)
  if (preview.err) throw preview.err
  const imported = cards.costs[0]
  if (!imported) throw new Error("fixture")
  cards.costs.push({ ...imported, source: "manual", sourceRef: "negotiated", effectiveFrom: NOW })
  const result = await apply(services, preview.val.draftHash)
  expect(rejectionOf(result.err)).toMatchObject({ code: "DRAFT_STALE" })
  expect(cards.cards.get(preview.val.cardId)?.marginPolicy).toEqual({ type: "manual" })
  expect(cards.rows).toEqual([])
})

it("leaves the policy unchanged when the row planner rejects publication", async () => {
  const { cards, services } = createHarness()
  const preview = await price(services)
  if (preview.err) throw preview.err
  cards.rateCards.publishRows.mockResolvedValueOnce(
    Err(new UnPriceRateCardError({ code: "INVALID_CARD", violations: [] }))
  )
  const result = await apply(services, preview.val.draftHash)
  expect(rejectionOf(result.err)).toMatchObject({ code: "INVALID_CARD" })
  expect(cards.cards.get(preview.val.cardId)?.marginPolicy).toEqual({ type: "manual" })
  expect(cards.rows).toEqual([])
})

it("accepts an exact apply retry without writing more rows", async () => {
  const { cards, services } = createHarness()
  const preview = await price(services)
  if (preview.err) throw preview.err
  expect((await apply(services, preview.val.draftHash)).err).toBeUndefined()
  const count = cards.rows.length
  const retry = await apply(services, preview.val.draftHash)
  expect(retry.err).toBeUndefined()
  expect(retry.val?.inserted).toEqual([])
  expect(cards.rows).toHaveLength(count)
})
