import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { createRateCardsFake } from "../../rate-cards/memory.fixture"
import { removePlanVersionFeature } from "./remove-feature"

const NOW = Date.parse("2026-11-10T12:00:00.000Z")
const PROJECT = "proj_1"

function createHarness(state: "ok" | "not_found" = "ok") {
  const cards = createRateCardsFake()
  const stored = {
    id: "fpv_1",
    planVersionId: "pv_1",
    featureType: "usage",
    planVersion: { id: "pv_1", currency: "USD", status: "draft" },
    feature: { id: "ft_1", slug: "calls" },
  }
  const services = {
    plans: {
      getPlanVersionFeatureByIdDetailed: vi.fn(async () => Ok(stored)),
      removePlanVersionFeatureRecord: vi.fn(async () =>
        Ok(state === "ok" ? { state: "ok", planVersionFeature: stored } : { state: "not_found" })
      ),
    },
    rateCards: cards.rateCards,
  } as unknown as Pick<ServiceContext, "plans" | "rateCards">
  return { cards, services }
}

describe("removePlanVersionFeature", () => {
  it("ends the feature's rows on the version's own card", async () => {
    const { cards, services } = createHarness()
    cards.seedPlanVersionCard("pv_1", "USD", [
      { featureSlug: "calls", featureType: "usage", usageMode: "unit", price: "0.01" },
      { featureSlug: "seats", featureType: "flat", price: "10" },
    ])

    const result = await removePlanVersionFeature(
      { services },
      { projectId: PROJECT, id: "fpv_1", now: NOW }
    )

    expect(result.val).toMatchObject({ state: "ok" })
    expect(cards.rows.map((row) => [row.featureSlug, row.effectiveTo])).toEqual([
      ["calls", NOW],
      ["seats", null],
    ])
  })

  it("leaves the rows of a card another version also prices with", async () => {
    const { cards, services } = createHarness()
    const card = cards.seedPlanVersionCard("pv_1", "USD", [
      { featureSlug: "calls", featureType: "usage", usageMode: "unit", price: "0.01" },
    ])
    await cards.rateCards.assignToPlanVersion(PROJECT, {
      planVersionId: "pv_2",
      currency: "USD",
      cardId: card.id,
    })

    await removePlanVersionFeature({ services }, { projectId: PROJECT, id: "fpv_1", now: NOW })

    expect(cards.rows.map((row) => row.effectiveTo)).toEqual([null])
    expect(cards.rateCards.closeRows).not.toHaveBeenCalled()
  })

  it("answers the service's state when the feature is not found", async () => {
    const { cards, services } = createHarness("not_found")

    const result = await removePlanVersionFeature(
      { services },
      { projectId: PROJECT, id: "fpv_1", now: NOW }
    )

    expect(result.val).toEqual({ state: "not_found" })
    expect(cards.rateCards.closeRows).not.toHaveBeenCalled()
  })
})
