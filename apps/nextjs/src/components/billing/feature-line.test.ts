import { rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { type FeatureLineRows, describeFeatureLine } from "./feature-line"

const NOW = Date.parse("2026-11-05T12:00:00.000Z")

function row(featureSlug: string, price: Record<string, unknown>, match = {}) {
  return rateRowSchema.parse({
    id: `rr_${featureSlug}`,
    rateCardId: "rc_1",
    featureSlug,
    match,
    price,
    cost: null,
    effectiveFrom: NOW - 1000,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
}

function rows(current: ReturnType<typeof row> | null, byDimension: ReturnType<typeof row>[] = []) {
  return { current, scheduled: null, byDimension } satisfies FeatureLineRows
}

const daily = {
  name: "daily",
  resetInterval: "day",
  resetIntervalCount: 1,
  resetAnchor: "dayOfCreation",
  planType: "recurring",
} as const

function feature(
  overrides: Partial<Parameters<typeof describeFeatureLine>[0]> & { title: string }
): Parameters<typeof describeFeatureLine>[0] {
  const { title, ...rest } = overrides
  return {
    feature: { title },
    featureType: "usage",
    unitOfMeasure: "unit",
    included: null,
    limit: null,
    defaultQuantity: 1,
    resetConfig: null,
    ...rest,
  }
}

describe("describeFeatureLine", () => {
  it("reads included seats and the price past them from a graduated row", () => {
    const seats = row("seats", {
      type: "graduated",
      property: null,
      per: 1,
      tiers: [
        { upTo: 3, rate: "0", flat: "0" },
        { upTo: null, rate: "10", flat: "0" },
      ],
    })

    expect(
      describeFeatureLine(
        feature({ title: "Seats", featureType: "tier", unitOfMeasure: "seat", defaultQuantity: 3 }),
        rows(seats),
        "USD"
      )
    ).toBe("3 seats included, then $10 per seat")
  })

  it("reads included units from the feature and the unit price from its row", () => {
    const calls = row("api-calls", {
      type: "unit",
      components: [{ property: null, rate: "0.002", per: 1 }],
    })

    expect(
      describeFeatureLine(
        feature({ title: "API calls", unitOfMeasure: "call", included: "1000" }),
        rows(calls),
        "USD"
      )
    ).toBe("1,000 calls included, then $0.002 per call")
  })

  it("says a feature with dimension rows is priced per that dimension", () => {
    const gpt = row(
      "tokens",
      { type: "unit", components: [{ property: "input_tokens", rate: "0.00001", per: 1 }] },
      { model: "gpt-4o" }
    )

    expect(
      describeFeatureLine(
        feature({ title: "LLM tokens", unitOfMeasure: "token" }),
        rows(null, [gpt]),
        "USD"
      )
    ).toBe("LLM tokens, priced per model")
  })

  it("states a daily limit from the reset config, with no price when the row is free", () => {
    const images = row("images", {
      type: "unit",
      components: [{ property: null, rate: "0", per: 1 }],
    })

    expect(
      describeFeatureLine(
        feature({ title: "Images", unitOfMeasure: "image", limit: 50, resetConfig: daily }),
        rows(images),
        "USD"
      )
    ).toBe("Up to 50 images a day")
  })

  it("says Unlimited only when nothing is included, limited, or charged", () => {
    const free = row("support", {
      type: "unit",
      components: [{ property: null, rate: "0", per: 1 }],
    })

    expect(
      describeFeatureLine(feature({ title: "Support", unitOfMeasure: "ticket" }), rows(free), "USD")
    ).toBe("Unlimited Support")
    expect(
      describeFeatureLine(feature({ title: "Support", unitOfMeasure: "ticket" }), undefined, "USD")
    ).toBe("Unlimited Support")
  })

  it("names a flat feature by its title and keeps the title for a generic unit", () => {
    expect(
      describeFeatureLine(feature({ title: "Base fee", featureType: "flat" }), undefined, "USD")
    ).toBe("Base fee")
    expect(
      describeFeatureLine(
        feature({ title: "Workflow runs", included: "100", limit: 500 }),
        undefined,
        "USD"
      )
    ).toBe("Workflow runs: 100 units included, up to 500")
  })

  it("prices a package by its size", () => {
    const emails = row("emails", { type: "package", property: null, size: 1000, rate: "5" })

    expect(
      describeFeatureLine(feature({ title: "Emails", unitOfMeasure: "email" }), rows(emails), "USD")
    ).toBe("$5 per 1,000 emails")
  })
})
