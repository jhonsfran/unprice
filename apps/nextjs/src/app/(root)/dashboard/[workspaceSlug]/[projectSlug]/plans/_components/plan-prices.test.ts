import { rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { describeFeaturePrice, rowsByFeature, unpricedFeatureTitles } from "./plan-prices"

const NOW = Date.parse("2026-11-04T12:00:00.000Z")
const HOUR = 3_600_000

function row(
  id: string,
  featureSlug: string,
  from: number,
  to: number | null,
  match: Record<string, string> = {},
  rate = "0.02"
) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug,
    match,
    price: { type: "unit", components: [{ property: null, rate, per: 1 }] },
    cost: null,
    effectiveFrom: from,
    effectiveTo: to,
    source: "manual",
    sourceRef: null,
  })
}

const rows = [
  row("rr_ended", "calls", NOW - 2 * HOUR, NOW - HOUR, {}, "0.05"),
  row("rr_live", "calls", NOW - HOUR, NOW + HOUR),
  row("rr_later", "calls", NOW + 2 * HOUR, null, {}, "0.03"),
  row("rr_next", "calls", NOW + HOUR, NOW + 2 * HOUR, {}, "0.025"),
  row("rr_gpt", "tokens", NOW - HOUR, null, { model: "gpt-4o" }, "0.00001"),
  row("rr_claude", "tokens", NOW - HOUR, null, { model: "claude-3" }, "0.00002"),
  row("rr_seat_later", "seats", NOW + HOUR, null, {}, "9"),
]

describe("rowsByFeature", () => {
  it("splits a feature's default rows into the current one and the earliest scheduled one", () => {
    const calls = rowsByFeature(rows, NOW).get("calls")

    expect(calls?.current?.id).toBe("rr_live")
    expect(calls?.scheduled?.id).toBe("rr_next")
    expect(calls?.byDimension).toEqual([])
  })

  it("keeps dimension rows apart from the default row and drops ended rows", () => {
    const byFeature = rowsByFeature(rows, NOW)

    expect(byFeature.get("tokens")?.current).toBeNull()
    expect(byFeature.get("tokens")?.byDimension.map(({ id }) => id)).toEqual([
      "rr_gpt",
      "rr_claude",
    ])
    expect([...byFeature.keys()]).toEqual(["calls", "tokens", "seats"])
  })
})

describe("describeFeaturePrice", () => {
  it("states the current price, the scheduled price with its start, or the dimension count", () => {
    const byFeature = rowsByFeature(rows, NOW)

    expect(describeFeaturePrice(byFeature.get("calls"), "USD", "call")).toBe("$0.02 / call")
    expect(describeFeaturePrice(byFeature.get("seats"), "USD", "seat")).toMatch(
      /^\$9 \/ seat from /
    )
    expect(describeFeaturePrice(byFeature.get("tokens"), "USD", "token")).toBe("2 prices by model")
    expect(describeFeaturePrice(undefined, "USD", "unit")).toBe("Not priced")
  })
})

describe("unpricedFeatureTitles", () => {
  it("names only the features the card has no current, scheduled, or dimension row for", () => {
    const features = [
      { feature: { slug: "calls", title: "API calls" } },
      { feature: { slug: "tokens", title: "Tokens" } },
      { feature: { slug: "seats", title: "Seats" } },
      { feature: { slug: "support", title: "Support" } },
      { feature: { slug: "storage", title: "Storage" } },
    ]

    expect(unpricedFeatureTitles(features, rows, NOW)).toEqual(["Support", "Storage"])
  })
})
