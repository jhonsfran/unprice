import { type ModelRate, rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { CARD_FROM, features, modelCosts, usdCard } from "../pricing/fixtures"
import { catalogCosts, changedCosts } from "./model-costs"
import { RATE_CHANGE_NOTICE_MS, featurePricingOf, planPublish } from "./publish"
import { canonicalJson, toWire } from "./wire"

const NOW = CARD_FROM + 60_000

describe("toWire", () => {
  it("formats amounts so every fixture row parses back to itself", () => {
    const emails = usdCard.rows.find((row) => row.id === "row_emails")

    expect(toWire(emails?.price)).toEqual({
      type: "package",
      property: "emails",
      size: 1000,
      rate: "1",
    })
    expect(usdCard.rows.map((row) => rateRowSchema.parse(toWire(row)))).toEqual(usdCard.rows)
  })

  it("sorts keys at every depth", () => {
    expect(canonicalJson({ b: [{ z: BigInt(150_000_000), a: null }], a: "x" })).toBe(
      '{"a":"x","b":[{"a":null,"z":"1.5"}]}'
    )
  })
})

describe("planPublish", () => {
  const card = usdCard.card
  const open = usdCard.rows.filter((row) => row.id === "row_gpt41")
  const draft = (output: string) => {
    const row = open[0]
    if (!row || row.price.type !== "unit") throw new Error("fixture changed")
    const components = row.price.components.map((component) =>
      component.property === "output_tokens"
        ? { ...component, rate: BigInt(Number(output) * 100_000_000) }
        : component
    )
    return {
      featureSlug: row.featureSlug,
      match: row.match,
      price: { type: "unit" as const, components },
      cost: row.cost,
      source: "manual" as const,
      sourceRef: null,
    }
  }
  const plan = (drafts: ReturnType<typeof draft>[], effectiveFrom: number) =>
    planPublish({
      card,
      rows: open,
      drafts,
      effectiveFrom,
      now: NOW,
      features: [features.llmTokens],
      newRowId: () => "row_new",
    })

  it("closes the open row where its successor starts", () => {
    const result = plan([draft("6")], NOW + RATE_CHANGE_NOTICE_MS)

    expect(result.val?.closes).toEqual([
      { rowId: "row_gpt41", effectiveTo: NOW + RATE_CHANGE_NOTICE_MS },
    ])
    expect(result.val?.inserts.map((row) => [row.id, row.effectiveFrom, row.effectiveTo])).toEqual([
      ["row_new", NOW + RATE_CHANGE_NOTICE_MS, null],
    ])
  })

  it("counts a draft equal to its open row as unchanged, at any start", () => {
    expect(plan([draft("8")], NOW).val).toEqual({ closes: [], inserts: [], unchanged: 1 })
  })

  it("refuses a change one millisecond inside the notice", () => {
    expect(plan([draft("6")], NOW + RATE_CHANGE_NOTICE_MS - 1).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + RATE_CHANGE_NOTICE_MS,
    })
  })
})

describe("featurePricingOf", () => {
  it("reads dimensions and the metered property from the meter", () => {
    const meterConfig = {
      eventId: "evt_1",
      eventSlug: "tokens",
      aggregationMethod: "sum" as const,
      aggregationField: "input_tokens",
      groupBy: ["model"],
    }

    expect(featurePricingOf({ slug: "llm_tokens", meterConfig })).toEqual({
      slug: "llm_tokens",
      dimensions: ["model"],
      meterProperty: "input_tokens",
      included: null,
    })
    expect(featurePricingOf({ slug: "Bad Slug", meterConfig: null })).toBeNull()
  })
})

describe("catalog costs", () => {
  const haiku: ModelRate = {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    unit: "money:USD",
    per: 1_000_000,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    tiers: [],
    limits: { context: 200_000, output: 64_000 },
  }

  it("maps catalog rates to cost components and keeps only changed models", () => {
    const [cost] = catalogCosts([haiku], "2026-10-20", NOW)
    const repriced = catalogCosts([{ ...haiku, rates: { ...haiku.rates, input: 0.8 } }], "v2", NOW)

    expect(cost && toWire(cost)).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      components: { input: "1", output: "5", cache_read: "0.1", cache_write: "1.25" },
      effectiveFrom: NOW,
      source: "modelsdev",
      sourceRef: "2026-10-20",
    })
    expect(changedCosts(cost ? [cost, modelCosts.gpt41] : [], repriced)).toEqual(repriced)
    expect(changedCosts(repriced, repriced)).toEqual([])
  })
})
