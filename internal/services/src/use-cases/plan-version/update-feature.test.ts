import {
  type Feature,
  type MeterConfig,
  type PlanVersion,
  type PlanVersionFeature,
  planVersionFeatureUpdateBaseSchema,
  ratePriceSchema,
} from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { UnPriceRateCardError } from "../../rate-cards"
import { createRateCardsFake } from "../../rate-cards/memory.fixture"
import { updatePlanVersionFeature } from "./update-feature"

function rejectionOf(err: Error | undefined) {
  return err instanceof UnPriceRateCardError ? err.rejection : err
}

const NOW = Date.parse("2026-11-10T12:00:00.000Z")
const PROJECT = "proj_1"

type Stored = PlanVersionFeature & { planVersion: PlanVersion; feature: Feature }
type RecordUpdate = Parameters<ServiceContext["plans"]["updatePlanVersionFeatureRecord"]>[0]

const version = {
  id: "pv_1",
  projectId: PROJECT,
  planId: "plan_1",
  currency: "USD",
  status: "draft",
} as unknown as PlanVersion

const tokensMeter: MeterConfig = {
  eventId: "evt_tokens",
  eventSlug: "tokens",
  aggregationMethod: "sum",
  aggregationField: "tokens",
}

function stored(overrides: Partial<Stored>): Stored {
  return {
    id: "fpv_1",
    projectId: PROJECT,
    planVersionId: "pv_1",
    featureId: "ft_1",
    featureType: "flat",
    config: {},
    meterConfig: null,
    included: null,
    planVersion: version,
    feature: { id: "ft_1", slug: "base" } as Feature,
    ...overrides,
  } as Stored
}

/** The plan service as the use case sees it: one stored feature, updated in place like the real writer. */
function createHarness(initial: Stored) {
  const cards = createRateCardsFake()
  let current = initial
  const updatePlanVersionFeatureRecord = vi.fn(async (input: RecordUpdate) => {
    current = {
      ...current,
      ...(input.featureType && { featureType: input.featureType }),
      ...(input.config && { config: input.config }),
      ...(input.hasMeterConfigOverride && { meterConfig: input.meterConfig ?? null }),
      ...(input.included !== undefined && { included: input.included }),
    }
    return Ok({ state: "ok" as const, planVersionFeature: current })
  })
  const services = {
    plans: {
      getPlanVersionFeatureByIdDetailed: vi.fn(async () => Ok(current)),
      updatePlanVersionFeatureRecord,
      getPlanByIdRecord: vi.fn(async () => Ok({ id: "plan_1", slug: "starter" })),
    },
    features: { listFeaturesByProject: vi.fn(async () => Ok([])) },
    rateCards: cards.rateCards,
  } as unknown as Pick<ServiceContext, "plans" | "features" | "rateCards">
  return { cards, services, updatePlanVersionFeatureRecord }
}

function input(fields: Record<string, unknown>) {
  return {
    ...planVersionFeatureUpdateBaseSchema.parse({ id: "fpv_1", planVersionId: "pv_1", ...fields }),
    projectId: PROJECT,
    now: NOW,
  }
}

function priced(
  services: Pick<ServiceContext, "plans" | "features" | "rateCards">,
  fields: Record<string, unknown>
) {
  return updatePlanVersionFeature({ services }, input(fields))
}

describe("updatePlanVersionFeature", () => {
  it("prices a flat feature on the version's own card, then unprices it", async () => {
    const { cards, services } = createHarness(stored({}))

    const result = await priced(services, { price: { price: "49" } })
    if (result.val?.state !== "ok") throw result.err ?? new Error(result.val?.state)
    const row = { ...result.val.row }
    const card = [...cards.cards.values()][0]
    const unpriced = await priced(services, { price: null })

    expect(row).toMatchObject({
      featureSlug: "base",
      match: {},
      price: ratePriceSchema.parse({ type: "flat", amount: "49" }),
      effectiveFrom: NOW,
      effectiveTo: null,
    })
    expect(card).toMatchObject({ name: "starter pv_1 USD", unit: "money:USD" })
    expect(cards.assignments.get("pv_1:USD")).toBe(card?.id)
    expect(unpriced.val).toMatchObject({ state: "ok", row: null })
    expect(cards.rows.map((row) => row.effectiveTo)).toEqual([NOW])
  })

  it("prices unit usage on the meter's property and a package by the package size", async () => {
    const unit = createHarness(
      stored({ featureType: "usage", config: { usageMode: "unit" }, meterConfig: tokensMeter })
    )
    const pack = createHarness(
      stored({ featureType: "usage", config: { usageMode: "unit" }, meterConfig: tokensMeter })
    )

    const perToken = await priced(unit.services, { price: { price: "0.002" } })
    const perPack = await priced(pack.services, {
      featureType: "usage",
      config: { usageMode: "package", units: 100 },
      price: { price: "5" },
    })
    const wrongShape = await priced(pack.services, {
      price: { tiers: [{ firstUnit: 1, lastUnit: null, unitPrice: "1" }] },
    })

    expect(perToken.val).toMatchObject({
      row: {
        price: ratePriceSchema.parse({
          type: "unit",
          components: [{ property: "tokens", rate: "0.002", per: 1 }],
        }),
      },
    })
    expect(perPack.val).toMatchObject({
      row: {
        price: ratePriceSchema.parse({ type: "package", property: "tokens", size: 100, rate: "5" }),
      },
    })
    expect(rejectionOf(wrongShape.err)).toEqual({
      code: "PRICE_SHAPE_MISMATCH",
      featureSlug: "base",
      expected: "price",
    })
  })

  it("refuses to repackage or reprice a feature whose card also prices another version", async () => {
    const { cards, services, updatePlanVersionFeatureRecord } = createHarness(stored({}))
    const card = cards.seedPlanVersionCard("pv_1", "USD", [
      { featureSlug: "base", featureType: "flat", price: "10" },
    ])
    cards.assignments.set("pv_2:USD", card.id)

    const repriced = await priced(services, { price: { price: "49" } })
    const repackaged = await priced(services, { featureType: "tier" })
    const relimited = await priced(services, { limit: 10 })

    expect(rejectionOf(repriced.err)).toEqual({
      code: "CARD_SHARED",
      cardId: card.id,
      planVersionId: "pv_2",
    })
    expect(rejectionOf(repackaged.err)).toMatchObject({ code: "CARD_SHARED" })
    expect(relimited.val).toMatchObject({
      state: "ok",
      row: { featureSlug: "base", match: {}, effectiveTo: null },
    })
    expect(updatePlanVersionFeatureRecord).toHaveBeenCalledTimes(1)
  })

  it("ends the rows that no longer fit the feature's dimensions where the new price starts", async () => {
    const perModel: MeterConfig = {
      ...tokensMeter,
      aggregationMethod: "count",
      groupBy: ["model"],
    }
    const { cards, services } = createHarness(
      stored({ featureType: "usage", config: { usageMode: "unit" }, meterConfig: perModel })
    )
    const card = cards.seedPlanVersionCard("pv_1", "USD", [
      { featureSlug: "base", featureType: "usage", usageMode: "unit", price: "0.01" },
    ])
    const [fallback] = cards.rows
    if (!fallback) throw new Error("fixture")
    cards.rows.push({ ...fallback, id: "rr_gpt", match: { model: "gpt-4.1" } })

    const regrouped = await priced(services, {
      featureType: "usage",
      config: { usageMode: "unit" },
      meterConfig: { ...tokensMeter, aggregationMethod: "count" },
      price: { price: "0.02" },
    })
    const unchanged = await priced(services, { limit: 5 })

    expect(regrouped.val).toMatchObject({
      state: "ok",
      row: { match: {}, effectiveFrom: NOW, effectiveTo: null },
    })
    expect(
      cards.rows
        .filter((row) => row.rateCardId === card.id)
        .map((row) => [row.id, row.match, row.effectiveTo])
    ).toEqual([
      [fallback.id, {}, NOW],
      ["rr_gpt", { model: "gpt-4.1" }, NOW],
      [regrouped.val?.state === "ok" ? regrouped.val.row?.id : null, {}, null],
    ])
    expect(unchanged.val).toMatchObject({ row: { effectiveTo: null } })
    expect(cards.rateCards.closeRows).not.toHaveBeenCalled()
  })

  it("ends stale dimension rows at once when the meter changes without a price", async () => {
    const perModel: MeterConfig = {
      ...tokensMeter,
      aggregationMethod: "count",
      groupBy: ["model"],
    }
    const { cards, services } = createHarness(
      stored({ featureType: "usage", config: { usageMode: "unit" }, meterConfig: perModel })
    )
    cards.seedPlanVersionCard("pv_1", "USD", [
      { featureSlug: "base", featureType: "usage", usageMode: "unit", price: "0.01" },
    ])
    const [fallback] = cards.rows
    if (!fallback) throw new Error("fixture")
    cards.rows.push({ ...fallback, id: "rr_gpt", match: { model: "gpt-4.1" } })

    const result = await priced(services, {
      featureType: "usage",
      config: { usageMode: "unit" },
      meterConfig: { ...tokensMeter, aggregationMethod: "count" },
    })

    expect(result.val).toMatchObject({ state: "ok", row: { id: fallback.id, effectiveTo: null } })
    expect(cards.rows.map((row) => [row.id, row.effectiveTo])).toEqual([
      [fallback.id, null],
      ["rr_gpt", NOW],
    ])
  })

  it("ends the old default row at once when the feature is repackaged without a price", async () => {
    const { cards, services } = createHarness(stored({ featureType: "flat", config: {} }))
    cards.seedPlanVersionCard("pv_1", "USD", [
      { featureSlug: "base", featureType: "flat", price: "1" },
    ])
    const [flatRow] = cards.rows
    if (!flatRow) throw new Error("fixture")

    const metered = await priced(services, {
      featureType: "usage",
      config: { usageMode: "unit" },
      meterConfig: { ...tokensMeter, aggregationMethod: "count", groupBy: ["model"] },
    })

    expect(metered.val).toMatchObject({ state: "ok", row: null })
    expect(cards.rows.map((row) => [row.id, row.effectiveTo])).toEqual([[flatRow.id, NOW]])
  })

  it("answers the service's own states for a missing or published feature", async () => {
    const missing = createHarness(stored({}))
    missing.services.plans.getPlanVersionFeatureByIdDetailed = vi.fn(async () => Ok(null))
    const published = createHarness(
      stored({ planVersion: { ...version, status: "published" } as PlanVersion })
    )

    expect((await priced(missing.services, { price: { price: "1" } })).val).toEqual({
      state: "plan_version_feature_not_found",
    })
    expect((await priced(published.services, { price: { price: "1" } })).val).toEqual({
      state: "plan_version_published",
    })
    expect(published.updatePlanVersionFeatureRecord).not.toHaveBeenCalled()
  })
})
