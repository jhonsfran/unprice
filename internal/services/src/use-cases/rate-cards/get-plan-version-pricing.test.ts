import { rateCardSchema } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { getPlanVersionPricing } from "./get-plan-version-pricing"

const card = rateCardSchema.parse({
  id: "rc_1",
  projectId: "proj_1",
  name: "pro pv_1 EUR",
  unit: "money:EUR",
  marginPolicy: { type: "manual" },
})
const input = { projectId: "proj_1", planVersionId: "pv_1", now: 100 }
function services(currency: string) {
  return {
    plans: {
      getPlanVersionByIdDetailed: vi.fn(async () =>
        Ok({
          id: "pv_1",
          plan: { slug: "pro" },
          currency,
          planFeatures: [{ feature: { slug: "calls" } }],
        })
      ),
    },
    rateCards: {
      pricingForPlanVersions: vi.fn(
        async () => new Map([["pv_1", [{ currency: "EUR", card, rows: [] }]]])
      ),
    },
  } as unknown as Pick<ServiceContext, "plans" | "rateCards">
}

describe("getPlanVersionPricing", () => {
  it("keeps the empty-card response for a missing version", async () => {
    const deps = { services: services("USD") }
    deps.services.plans.getPlanVersionByIdDetailed = vi.fn(async () => Ok(null))
    expect((await getPlanVersionPricing(deps, input)).val).toEqual({
      cards: [],
      hasCard: false,
      unpricedFeatureSlugs: [],
    })
  })
  it("does not substitute a card in another currency for publish readiness", async () => {
    const deps = { services: services("USD") }
    const result = await getPlanVersionPricing(deps, input)
    expect(result.val).toMatchObject({
      hasCard: false,
      unpricedFeatureSlugs: ["calls"],
      cards: [{ currency: "EUR", own: true }],
    })
    expect(deps.services.rateCards.pricingForPlanVersions).toHaveBeenCalledWith(
      "proj_1",
      ["pv_1"],
      100,
      { scheduled: true }
    )
  })
  it("returns server-owned card identity and readiness in the version's currency", async () => {
    const result = await getPlanVersionPricing({ services: services("EUR") }, input)
    expect(result.val).toMatchObject({
      hasCard: true,
      unpricedFeatureSlugs: ["calls"],
      cards: [{ own: true }],
    })
  })
})
