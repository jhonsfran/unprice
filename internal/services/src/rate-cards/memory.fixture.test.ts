import { rateRowDraftSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { createRateCardsFake } from "./memory.fixture"
import { RATE_CHANGE_NOTICE_MS } from "./publish"

const PROJECT = "project"
const NOW = 1_000
const draft = (rate = "1", cost: string | null = null) =>
  rateRowDraftSchema.parse({
    featureSlug: "calls",
    match: {},
    price: { type: "unit", components: [{ property: null, rate, per: 1 }] },
    cost: cost === null ? null : { components: [{ property: null, rate: cost, per: 1 }] },
  })
function setup() {
  const fake = createRateCardsFake()
  const card = fake.seedPlanVersionCard("pv", "USD", [
    { featureSlug: "calls", featureType: "usage", usageMode: "unit", price: "1" },
  ])
  const publish = (now: number, rate = "1", cost: string | null = null) =>
    fake.rateCards.publishRows({
      projectId: PROJECT,
      cardId: card.id,
      drafts: [draft(rate, cost)],
      now,
    })
  return { ...fake, card, publish }
}

describe("rate-card fake production rules", () => {
  it("replaces a row when only its cost changes", async () => {
    const fake = setup()
    const result = await fake.publish(NOW, "1", "0.5")
    expect(result.val?.inserted).toHaveLength(1)
    expect(result.val?.closed).toEqual([{ rowId: fake.rows[0]?.id, effectiveTo: NOW }])
    expect(result.val?.inserted[0]?.cost?.components[0]?.rate).toBe(BigInt(50_000_000))
  })
  it("rejects a different explicit end on a closed row", async () => {
    const fake = setup()
    const input = {
      projectId: PROJECT,
      cardId: fake.card.id,
      rowIds: [fake.rows[0]?.id ?? ""],
      now: NOW,
    }
    await fake.rateCards.closeRows({ ...input, effectiveTo: NOW })
    const result = await fake.rateCards.closeRows({ ...input, effectiveTo: NOW + 1 })
    expect(result.err?.code).toBe("ROW_CLOSED")
    expect(fake.rows[0]?.effectiveTo).toBe(NOW)
  })
  it("reads scheduled rows that overlap the requested interval", async () => {
    const fake = setup()
    await fake.publish(NOW + 100, "2")
    const result = await fake.rateCards.pricingForPlanVersions(PROJECT, ["pv"], NOW, NOW + 101)
    expect(result.get("pv")?.[0]?.rows.map((row) => row.effectiveFrom)).toEqual([0, NOW + 100])
  })
  it("ends detached rows on a shared card and keeps other cards unchanged", async () => {
    const fake = setup()
    const other = fake.seedPlanVersionCard("other", "USD", [
      { featureSlug: "calls", featureType: "usage", usageMode: "unit", price: "2" },
    ])
    await fake.rateCards.assignToPlanVersion(PROJECT, {
      planVersionId: "shared",
      currency: "USD",
      cardId: fake.card.id,
    })
    await fake.rateCards.removeFeaturePrices({
      projectId: PROJECT,
      cardId: fake.card.id,
      featureSlug: "calls",
      now: NOW,
    })
    expect(
      fake.rows.filter((row) => row.rateCardId === fake.card.id).map((row) => row.effectiveTo)
    ).toEqual([NOW])
    expect(
      fake.rows.filter((row) => row.rateCardId === other.id).map((row) => row.effectiveTo)
    ).toEqual([null])
  })
  it("applies the notice to a live card's changed rows", async () => {
    const fake = setup()
    fake.published.add("pv")
    const result = await fake.publish(NOW, "2")
    expect(result.val?.inserted[0]?.effectiveFrom).toBe(NOW + RATE_CHANGE_NOTICE_MS)
  })
})
