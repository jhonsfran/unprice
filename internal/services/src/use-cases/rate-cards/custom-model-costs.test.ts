import {
  type Feature,
  type MeterConfig,
  type Plan,
  type PlanVersion,
  type PlanVersionFeature,
  customModelCostInputSchema,
  planVersionCatalogPricingInputSchema,
} from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { createRateCardsFake } from "../../rate-cards/memory.fixture"
import { previewPlanVersionCatalogPricing } from "./catalog-pricing"
import { addCustomModelCost, listCustomModelCosts } from "./custom-model-costs"

const NOW = Date.parse("2026-11-10T12:00:00.000Z")
const PROJECT = "proj_1"

const tokensMeter: MeterConfig = {
  eventId: "evt_tokens",
  eventSlug: "tokens",
  aggregationMethod: "sum",
  aggregationField: "input_tokens",
  groupBy: ["model"],
}

function createHarness() {
  const cards = createRateCardsFake()
  const version = {
    id: "pv_1",
    projectId: PROJECT,
    planId: "plan_1",
    currency: "USD",
    status: "draft",
    plan: { id: "plan_1", slug: "starter" } as Plan,
    planFeatures: [
      {
        id: "fpv_llm_tokens",
        featureType: "usage",
        config: { usageMode: "unit" },
        meterConfig: tokensMeter,
        included: null,
        feature: { id: "ft_llm_tokens", slug: "llm_tokens" } as Feature,
      } as unknown as PlanVersionFeature & { feature: Feature },
    ],
  } as unknown as PlanVersion
  const services = {
    plans: { getPlanVersionByIdDetailed: vi.fn(async () => Ok(version)) },
    features: { listFeaturesByProject: vi.fn(async () => Ok([])) },
    rateCards: cards.rateCards,
  } as unknown as Pick<ServiceContext, "plans" | "features" | "rateCards">
  return { cards, services }
}

function add(
  services: Pick<ServiceContext, "rateCards">,
  cost: Record<string, unknown>,
  at = NOW - 60_000,
  projectId = PROJECT
) {
  return addCustomModelCost(
    { services },
    { ...customModelCostInputSchema.parse({ provider: "acme", ...cost }), projectId, now: at }
  )
}

async function draftAtThirtyPercent(
  services: Pick<ServiceContext, "plans" | "features" | "rateCards">
) {
  const result = await previewPlanVersionCatalogPricing(
    { services },
    {
      ...planVersionCatalogPricingInputSchema.parse({
        planVersionId: "pv_1",
        featureSlug: "llm_tokens",
        markup: "0.3",
        roundTo: "0.01",
        componentMap: { input: "input_tokens", output: "output_tokens" },
      }),
      projectId: PROJECT,
      now: NOW,
    }
  )
  if (result.err) throw result.err
  return result.val.draft
}

/** The proposed rates of one model as "property=rate" strings, or null when it is not drafted. */
function ratesOf(draft: Awaited<ReturnType<typeof draftAtThirtyPercent>>, model: string) {
  const change = draft.changes.find((candidate) => candidate.proposed.match.model === model)
  return change
    ? change.proposed.price.components.map((c) => `${c.property}=${formatAmount(c.rate)}`)
    : null
}

describe("custom model costs", () => {
  it("prices a model models.dev does not list like any catalog model: cost plus the markup", async () => {
    const { services } = createHarness()
    await add(services, { model: "acme-llama-70b", components: { input: "1", output: "2" } })

    const draft = await draftAtThirtyPercent(services)

    expect(ratesOf(draft, "acme-llama-70b")).toEqual(["input_tokens=1.3", "output_tokens=2.6"])
  })

  it("outranks the models.dev cost of the same model, so a negotiated cost reprices it", async () => {
    const { services } = createHarness()
    const before = await draftAtThirtyPercent(services)
    await add(services, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      components: { input: "10", output: "20" },
    })

    const after = await draftAtThirtyPercent(services)

    expect(ratesOf(before, "claude-haiku-4-5")).toEqual(["input_tokens=1.3", "output_tokens=6.5"])
    expect(ratesOf(after, "claude-haiku-4-5")).toEqual(["input_tokens=13", "output_tokens=26"])
  })

  it("stays inside its project: another project's custom model is not drafted here", async () => {
    const { services } = createHarness()
    await add(services, { model: "theirs", components: { input: "1" } }, NOW - 60_000, "proj_2")

    const draft = await draftAtThirtyPercent(services)

    expect(ratesOf(draft, "theirs")).toBeNull()
  })

  it("keeps edits as newer costs: the latest one prices, and the list shows only it", async () => {
    const { services } = createHarness()
    await add(services, { model: "acme-llama-70b", components: { input: "1" } }, NOW - 120_000)
    await add(services, { model: "acme-llama-70b", components: { input: "2" } }, NOW - 60_000)
    await add(services, { model: "acme-mini", components: { output: "0.5" } }, NOW - 60_000)

    const draft = await draftAtThirtyPercent(services)
    const listed = await listCustomModelCosts({ services }, { projectId: PROJECT })

    expect(ratesOf(draft, "acme-llama-70b")).toEqual(["input_tokens=2.6"])
    expect(
      listed.map((cost) => [cost.model, Object.keys(cost.components), cost.effectiveFrom])
    ).toEqual([
      ["acme-llama-70b", ["input"], NOW - 60_000],
      ["acme-mini", ["output"], NOW - 60_000],
    ])
  })

  it("refuses a cost with no component or a component the catalog does not carry", () => {
    const parse = (components: Record<string, string>) =>
      customModelCostInputSchema.safeParse({ provider: "acme", model: "m", components }).success

    expect(parse({})).toBe(false)
    expect(parse({ reasoning: "1" })).toBe(false)
    expect(parse({ input: "-1" })).toBe(false)
    expect(parse({ cache_read: "0.1" })).toBe(true)
  })
})
