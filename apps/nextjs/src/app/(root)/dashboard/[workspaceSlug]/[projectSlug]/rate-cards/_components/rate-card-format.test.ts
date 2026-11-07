import { rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import {
  buildRatePrice,
  earliestStart,
  groupRowsByFeature,
  parseMatch,
  parseTiers,
} from "./rate-card-format"

const NOW = Date.parse("2026-11-04T12:00:00.000Z")

function row(id: string, featureSlug: string, from: number, to: number | null) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug,
    match: {},
    price: { type: "unit", components: [{ property: null, rate: "0.02", per: 1 }] },
    cost: null,
    effectiveFrom: from,
    effectiveTo: to,
    source: "manual",
    sourceRef: null,
  })
}

describe("groupRowsByFeature", () => {
  it("keeps rows that apply now or later current and lists ended rows newest first", () => {
    const groups = groupRowsByFeature(
      [
        row("rr_old", "tokens", NOW - 3_000, NOW - 2_000),
        row("rr_older", "tokens", NOW - 5_000, NOW - 3_000),
        row("rr_live", "tokens", NOW - 2_000, NOW + 600_000),
        row("rr_next", "tokens", NOW + 600_000, null),
        row("rr_seat", "seats", NOW - 1_000, null),
      ],
      NOW
    )

    expect(groups.map((group) => group.featureSlug)).toEqual(["seats", "tokens"])
    expect(groups[1]?.current.map(({ id }) => id)).toEqual(["rr_live", "rr_next"])
    expect(groups[1]?.ended.map(({ id }) => id)).toEqual(["rr_old", "rr_older"])
  })
})

describe("buildRatePrice", () => {
  it("builds each price in the wire form publishRows takes", () => {
    const base = { amount: "0.02", per: "1000", property: "tokens", tiers: "" }
    expect(buildRatePrice({ ...base, kind: "unit" })).toEqual({
      ok: true,
      price: { type: "unit", components: [{ property: "tokens", rate: "0.02", per: 1000 }] },
    })
    expect(buildRatePrice({ ...base, kind: "package", property: "" })).toEqual({
      ok: true,
      price: { type: "package", property: null, size: 1000, rate: "0.02" },
    })
    expect(buildRatePrice({ ...base, kind: "flat", amount: "49" })).toEqual({
      ok: true,
      price: { type: "flat", amount: "49" },
    })
    expect(buildRatePrice({ ...base, kind: "graduated", tiers: "100 0 0\n* 0.01 5" })).toEqual({
      ok: true,
      price: {
        type: "graduated",
        property: "tokens",
        per: 1,
        tiers: [
          { upTo: 100, rate: "0", flat: "0" },
          { upTo: null, rate: "0.01", flat: "5" },
        ],
      },
    })
  })

  it("names what is missing instead of building a partial price", () => {
    expect(
      buildRatePrice({ kind: "graduated", amount: "", per: "1", property: "", tiers: "x" })
    ).toMatchObject({ ok: false })
    expect(
      buildRatePrice({ kind: "unit", amount: "1", per: "0", property: "", tiers: "" })
    ).toMatchObject({ ok: false })
  })
})

describe("parsing helpers", () => {
  it("reads a match and tiers, and refuses a pair without a key", () => {
    expect(parseMatch("")).toEqual({})
    expect(parseMatch("model=gpt-4o, region=eu")).toEqual({ model: "gpt-4o", region: "eu" })
    expect(parseMatch("=gpt-4o")).toBeNull()
    expect(parseTiers("10 1.5\n* 1")).toEqual([
      { upTo: 10, rate: "1.5", flat: "0" },
      { upTo: null, rate: "1", flat: "0" },
    ])
    expect(parseTiers("1.5 2")).toBeNull()
  })

  it("lets a card's first rows start at once and gives later ones the notice", () => {
    expect(earliestStart(false, NOW, 600_000)).toBe(NOW)
    expect(earliestStart(true, NOW, 600_000)).toBe(NOW + 660_000)
  })
})
