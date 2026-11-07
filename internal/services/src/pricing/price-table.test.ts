import { rateRowSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import {
  columnKey,
  columnLabel,
  describeLine,
  featureSlugsOf,
  lineLabel,
  perLabel,
  priceTableOf,
} from "./price-table"

const NOW = Date.parse("2026-11-05T12:00:00.000Z")
const HOUR = 3_600_000
const MILLION = 1_000_000

function modelRow(
  id: string,
  model: string,
  rates: Record<string, string>,
  from = NOW - HOUR,
  to: number | null = null
) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug: "llm_tokens",
    match: { model },
    price: {
      type: "unit",
      components: Object.entries(rates).map(([property, rate]) => ({
        property,
        rate,
        per: MILLION,
      })),
    },
    cost: null,
    effectiveFrom: from,
    effectiveTo: to,
    source: "catalog",
    sourceRef: null,
  })
}

function defaultRow(id: string, price: unknown, featureSlug = "api_calls") {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug,
    match: {},
    price,
    cost: null,
    effectiveFrom: NOW - HOUR,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
}

describe("priceTableOf", () => {
  it("turns model rows into a matrix: one line per model, one column per token kind in vendor order", () => {
    const rows = [
      modelRow("rr_haiku", "claude-haiku-5-5", {
        cache_write_tokens: "0.1625",
        output_tokens: "0.65",
        input_tokens: "0.13",
        cache_read_tokens: "0.013",
      }),
      modelRow("rr_opus", "claude-opus-4-5", { input_tokens: "6.5", output_tokens: "32.5" }),
    ]

    const table = priceTableOf("llm_tokens", rows, NOW, "USD", "token")

    expect(table.dimensions).toEqual(["model"])
    expect(table.columns.map((column) => columnLabel(column))).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Cache write",
    ])
    expect(table.columns.map((column) => perLabel(column, "token"))).toEqual([
      "1M tokens",
      "1M tokens",
      "1M tokens",
      "1M tokens",
    ])
    expect(table.lines.map((line) => lineLabel(line, table.dimensions))).toEqual([
      "claude-haiku-5-5",
      "claude-opus-4-5",
    ])
    const [haiku, opus] = table.lines
    const cell = (line: typeof haiku, property: string) => {
      const amount = line?.cells.get(columnKey({ property, per: MILLION }))
      return amount === undefined ? undefined : formatAmount(amount)
    }
    expect(cell(haiku, "input_tokens")).toBe("0.13")
    expect(cell(haiku, "cache_write_tokens")).toBe("0.1625")
    expect(cell(opus, "cache_read_tokens")).toBeUndefined()
    expect(haiku?.text).toBeNull()
    expect(table.ended).toEqual([])
  })

  it("splits lines by when they apply and keeps ended ones newest first", () => {
    const rows = [
      modelRow("rr_oldest", "gpt-5", { input_tokens: "1" }, NOW - 3 * HOUR, NOW - 2 * HOUR),
      modelRow("rr_old", "gpt-5", { input_tokens: "1.1" }, NOW - 2 * HOUR, NOW - HOUR),
      modelRow("rr_live", "gpt-5", { input_tokens: "1.2" }, NOW - HOUR, NOW + HOUR),
      modelRow("rr_next", "gpt-5", { input_tokens: "1.3" }, NOW + HOUR, null),
    ]

    const table = priceTableOf("llm_tokens", rows, NOW, "USD", "token")

    expect(table.lines.map((line) => [line.row.id, line.status])).toEqual([
      ["rr_live", "current"],
      ["rr_next", "scheduled"],
    ])
    expect(table.ended.map((line) => line.row.id)).toEqual(["rr_old", "rr_oldest"])
  })

  it("describes a graduated or flat row in words when the price has no components", () => {
    const tiers = defaultRow("rr_seats", {
      type: "graduated",
      property: null,
      per: 1,
      tiers: [
        { upTo: 3, rate: "0", flat: "0" },
        { upTo: null, rate: "10", flat: "0" },
      ],
    })
    const fee = defaultRow("rr_fee", { type: "flat", amount: "49" }, "base_fee")

    const seats = priceTableOf("api_calls", [tiers], NOW, "USD", "seat")
    const base = priceTableOf("base_fee", [fee], NOW, "USD", "cycle")

    expect(seats.columns).toEqual([])
    expect(seats.dimensions).toEqual([])
    expect(seats.lines[0]?.text).toBe("1-3 seats: $0 / seat · 4+ seats: $10 / seat")
    expect(lineLabel(seats.lines[0]!, seats.dimensions)).toBe("Default")
    expect(base.lines[0]?.text).toBe("$49")
    expect(describeLine(fee.price, "USD", "cycle")).toBe("$49")
  })

  it("labels a per-event column by the feature's unit", () => {
    const calls = defaultRow("rr_calls", {
      type: "unit",
      components: [{ property: null, rate: "0.002", per: 1 }],
    })

    const table = priceTableOf("api_calls", [calls], NOW, "USD", "call")

    expect(table.columns).toEqual([{ property: null, per: 1 }])
    expect(columnLabel(table.columns[0]!)).toBe("Rate")
    expect(perLabel(table.columns[0]!, "call")).toBe("call")
    expect(perLabel({ property: null, per: 1000 }, "call")).toBe("1K calls")
    expect(perLabel({ property: "input_tokens", per: 1_000_000 }, "token")).toBe("1M tokens")
  })

  it("lists the card's features once each, in first-seen order", () => {
    const rows = [
      defaultRow("rr_a", { type: "flat", amount: "1" }, "base_fee"),
      modelRow("rr_b", "gpt-5", { input_tokens: "1" }),
      defaultRow("rr_c", { type: "flat", amount: "2" }, "base_fee"),
    ]

    expect(featureSlugsOf(rows)).toEqual(["base_fee", "llm_tokens"])
  })
})
