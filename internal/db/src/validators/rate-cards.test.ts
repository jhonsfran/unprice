import { describe, expect, it } from "vitest"
import {
  featurePricingSchema,
  rateCardSchema,
  rateDecimalSchema,
  rateRowSchema,
} from "./rate-cards"

const row = {
  id: "row_1",
  rateCardId: "rc_1",
  featureSlug: "llm_tokens",
  match: { model: "gpt-4.1" },
  price: { type: "unit", components: [{ property: "input_tokens", rate: "2.00", per: 1_000_000 }] },
  cost: null,
  effectiveFrom: 1_000,
  effectiveTo: null,
  source: "manual",
  sourceRef: null,
}

const costPlus = {
  type: "costPlus",
  featureSlug: "llm_tokens",
  markup: "0.3",
  roundTo: "0.01",
  dimension: "model",
  componentMap: { input: "input_tokens" },
}

function issues(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

describe("rate card validators", () => {
  it("parses decimals into base units at scale 8", () => {
    expect(rateDecimalSchema.parse("2.5")).toBe(BigInt(250_000_000))
    expect(rateDecimalSchema.parse("0.00000001")).toBe(BigInt(1))
    expect(rateDecimalSchema.safeParse("0.000000001").success).toBe(false)
    expect(rateDecimalSchema.safeParse("-1").success).toBe(false)
  })

  it("parses a row's rates and rejects an interval that ends before it starts", () => {
    const parsed = rateRowSchema.parse(row)
    expect(parsed.price).toEqual({
      type: "unit",
      components: [{ property: "input_tokens", rate: BigInt(200_000_000), per: 1_000_000 }],
    })
    expect(issues(rateRowSchema.safeParse({ ...row, effectiveTo: 1_000 }))).toEqual([
      "effectiveTo must be after effectiveFrom",
    ])
    expect(rateRowSchema.safeParse({ ...row, featureSlug: "llm|tokens" }).success).toBe(false)
  })

  it("requires a credit value for cost-plus credits and USD for cost-plus money", () => {
    const card = { id: "rc_1", projectId: "proj_1", name: "Card", marginPolicy: costPlus }
    expect(rateCardSchema.safeParse({ ...card, unit: "money:USD" }).success).toBe(true)
    expect(
      rateCardSchema.safeParse({ ...card, unit: "credits:ai", creditValueUsd: "0.01" }).success
    ).toBe(true)
    expect(issues(rateCardSchema.safeParse({ ...card, unit: "credits:ai" }))).toEqual([
      "a cost-plus credits card needs creditValueUsd",
    ])
    expect(issues(rateCardSchema.safeParse({ ...card, unit: "money:EUR" }))).toEqual([
      "costs are in USD, so a cost-plus money card must be money:USD",
    ])
    expect(
      issues(
        rateCardSchema.safeParse({
          ...card,
          unit: "money:USD",
          creditValueUsd: "0.01",
          marginPolicy: { type: "manual" },
        })
      )
    ).toEqual(["only a credits card has a credit value"])
  })

  it("parses a feature's included units into base units", () => {
    const feature = featurePricingSchema.parse({
      slug: "api_calls",
      dimensions: [],
      meterProperty: "calls",
      included: "1000",
    })
    expect(feature.included).toBe(BigInt(100_000_000_000))
  })
})
