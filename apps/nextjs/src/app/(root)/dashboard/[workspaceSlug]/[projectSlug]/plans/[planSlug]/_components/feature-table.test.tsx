import { DndContext } from "@dnd-kit/core"
import type { PlanVersionFeatureDragDrop, RatePrice } from "@unprice/db/validators"
import { rateRowSchema } from "@unprice/db/validators"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { rowsByFeature } from "../../_components/plan-prices"
import { FeatureTableView } from "./feature-table"
import {
  currencySymbol,
  cycleWord,
  dimensionSummary,
  formatCellValue,
  formatUnits,
  includedCellOf,
  kindChangeOf,
  limitCellOf,
  priceCellOf,
  tierSummary,
  unitSuffixOf,
} from "./feature-table-cells"

const NOW = Date.parse("2026-11-05T12:00:00.000Z")
const HOUR = 3_600_000

const billingConfig = {
  name: "monthly",
  billingInterval: "month" as const,
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation" as const,
  planType: "recurring" as const,
}

function feature(
  overrides: Partial<PlanVersionFeatureDragDrop> & {
    slug: string
    title: string
    unit?: string
    template?: boolean
  }
): PlanVersionFeatureDragDrop {
  const { slug, title, unit = "units", template = false, ...rest } = overrides
  return {
    id: `pvf_${slug}`,
    projectId: "proj_1",
    planVersionId: "pv_1",
    featureId: `feat_${slug}`,
    featureType: "flat",
    config: {},
    metadata: { hidden: false, realtime: false, overageStrategy: "none" },
    order: 1024,
    defaultQuantity: 1,
    unitOfMeasure: unit,
    billingConfig,
    included: null,
    feature: {
      id: `feat_${slug}`,
      projectId: "proj_1",
      slug,
      title,
      description: null,
      unitOfMeasure: unit,
      meterConfig: template
        ? { eventId: "evt_1", eventSlug: "api_calls", aggregationMethod: "count" }
        : null,
      createdAtM: NOW,
      updatedAtM: NOW,
    },
    ...rest,
  } as PlanVersionFeatureDragDrop
}

function row(
  id: string,
  featureSlug: string,
  price: Record<string, unknown>,
  match: Record<string, string> = {},
  from = NOW - HOUR
) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug,
    match,
    price,
    cost: null,
    effectiveFrom: from,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
}

const baseFee = feature({ slug: "base-fee", title: "Base fee" })
const seats = feature({
  slug: "seats",
  title: "Seats",
  featureType: "tier",
  unit: "seats",
  defaultQuantity: 3,
})
const apiCalls = feature({
  slug: "api-calls",
  title: "API calls",
  featureType: "usage",
  unit: "calls",
  config: { usageMode: "unit" },
  included: "1000",
  limit: 50000,
  meterConfig: { eventId: "evt_1", eventSlug: "api_calls", aggregationMethod: "count" },
  template: true,
})
const images = feature({
  slug: "images",
  title: "Images",
  featureType: "usage",
  unit: "images",
  config: { usageMode: "unit" },
  limit: 50,
  meterConfig: { eventId: "evt_3", eventSlug: "images", aggregationMethod: "count" },
  resetConfig: {
    name: "daily",
    resetInterval: "day",
    resetIntervalCount: 1,
    resetAnchor: "dayOfCreation",
    planType: "recurring",
  },
  template: true,
})
const tokens = feature({
  slug: "tokens",
  title: "LLM tokens",
  featureType: "usage",
  unit: "tokens",
  config: { usageMode: "unit" },
  meterConfig: {
    eventId: "evt_2",
    eventSlug: "tokens",
    aggregationMethod: "sum",
    aggregationField: "input_tokens",
    groupBy: ["model"],
  },
})

const rows = [
  row("rr_base", "base-fee", { type: "flat", amount: "49" }),
  row("rr_seats", "seats", {
    type: "graduated",
    property: null,
    per: 1,
    tiers: [
      { upTo: 3, rate: "0", flat: "0" },
      { upTo: null, rate: "10", flat: "0" },
    ],
  }),
  row("rr_calls", "api-calls", {
    type: "unit",
    components: [{ property: null, rate: "0.002", per: 1 }],
  }),
  row("rr_images", "images", {
    type: "unit",
    components: [{ property: null, rate: "0.04", per: 1 }],
  }),
  row(
    "rr_gpt",
    "tokens",
    { type: "unit", components: [{ property: "input_tokens", rate: "0.000003", per: 1 }] },
    { model: "gpt-4o" }
  ),
  row(
    "rr_claude",
    "tokens",
    { type: "unit", components: [{ property: "input_tokens", rate: "0.000004", per: 1 }] },
    { model: "claude-sonnet-4" }
  ),
]

function render(
  features: PlanVersionFeatureDragDrop[],
  { editable = true, withRows = rows }: { editable?: boolean; withRows?: typeof rows } = {}
) {
  return renderToString(
    <DndContext>
      <FeatureTableView
        features={features}
        rows={rowsByFeature(withRows, NOW)}
        currency="USD"
        planBillingName="monthly"
        editable={editable}
        pendingIds={[]}
        problems={{}}
        onCommit={() => {}}
        onConfigure={() => {}}
        onEditFeature={() => {}}
        onRemove={() => {}}
      />
    </DndContext>
  ).replace(/<!-- -->/g, "")
}

/** The `value` attribute of the input labelled `label`: what the cell reads at rest. */
function inputValue(html: string, label: string): string | null {
  const input = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0]
  return input?.match(/value="([^"]*)"/)?.[1] ?? null
}

describe("FeatureTableView", () => {
  it("prices a fixed feature in its cell per billing cycle, with no limit or included cell", () => {
    const html = render([baseFee])

    expect(html).toContain("Base fee")
    expect(html).toContain("base-fee")
    expect(html).toContain("Fixed")
    expect(inputValue(html, "Price")).toBe("$49")
    expect(html).toContain("/ month")
    expect(inputValue(html, "Limit")).toBeNull()
    expect(inputValue(html, "Included")).toBeNull()
  })

  it("asks for a price on a fixed feature without a row", () => {
    const html = render([baseFee], { withRows: [] })

    expect(inputValue(html, "Price")).toBe("")
    expect(html).toContain('placeholder="Set price"')
    expect(html).not.toContain("Not priced")
  })

  it("reads a metered feature's limit, included units and unit price as formatted text", () => {
    const html = render([apiCalls])

    expect(html).toContain("Metered")
    expect(inputValue(html, "Limit")).toBe("50,000")
    expect(inputValue(html, "Included")).toBe("1,000")
    expect(inputValue(html, "Price")).toBe("$0.002")
    expect(html).toContain(">calls<")
    expect(html).toContain("/ call")
  })

  it("names the reset period after the unit when it differs from the plan's billing", () => {
    const html = render([images])

    expect(inputValue(html, "Limit")).toBe("50")
    expect(html).toContain(">images / day<")
    expect(inputValue(html, "Included")).toBe("")
    expect(html).toContain('placeholder="0"')
  })

  it("summarizes tiers and sends the user to the sheet for them", () => {
    const html = render([seats])

    expect(html).toContain("Tiered")
    expect(html).toContain("3 included, then $10 / seat")
    expect(html).toContain("Set tiers")
    expect(inputValue(html, "Included")).toBe("3")
    expect(html).toContain(">seats<")
    expect(inputValue(html, "Price")).toBeNull()
  })

  it("counts the prices by dimension and hides included units for them", () => {
    const html = render([tokens])

    expect(html).toContain("2 models from the catalog")
    expect(html).toContain("Price models")
    expect(inputValue(html, "Included")).toBeNull()
  })

  it("reads only for a published version, as the same text without controls", () => {
    const html = render([baseFee, apiCalls], { editable: false })

    expect(html).not.toContain("<input")
    expect(html).toContain(">$49<")
    expect(html).toContain(">/ month<")
    expect(html).toContain(">$0.002<")
    expect(html).toContain(">/ call<")
    expect(html).toContain(">50,000<")
    expect(html).toContain(">1,000<")
    expect(html).not.toContain("Drag to reorder")
    expect(html).toContain("Actions for Base fee")
  })

  it("keeps a feature without a row unpriced in the read view", () => {
    const html = render([seats], { editable: false, withRows: [] })

    expect(html).toContain("Not priced")
    expect(html).toContain(">No limit<")
  })
})

describe("kindChangeOf", () => {
  it("commits Fixed and Tiered at once, and Metered when the feature carries a meter template", () => {
    expect(kindChangeOf(apiCalls, "flat")).toEqual({ commit: { featureType: "flat", config: {} } })
    expect(kindChangeOf(baseFee, "tier")).toEqual({ commit: { featureType: "tier", config: {} } })
    expect(kindChangeOf(feature({ slug: "x", title: "X", template: true }), "usage")).toEqual({
      commit: { featureType: "usage", config: { usageMode: "unit" } },
    })
    expect(kindChangeOf(baseFee, "flat")).toBeNull()
  })

  it("opens the sheet for Metered without a meter and for Bundle, with the kind pending", () => {
    const metered = kindChangeOf(baseFee, "usage")
    expect(metered && "configure" in metered && metered.configure.featureType).toBe("usage")
    const bundle = kindChangeOf(seats, "package")
    expect(bundle && "configure" in bundle && bundle.configure.featureType).toBe("package")
  })
})

describe("cells", () => {
  it("derives the limit and included cells from the kind", () => {
    expect(limitCellOf(baseFee)).toBeNull()
    expect(limitCellOf(apiCalls)).toEqual({ value: "50000" })
    expect(limitCellOf(seats)).toEqual({ value: "" })
    expect(includedCellOf(baseFee)).toBeNull()
    expect(includedCellOf(apiCalls)).toEqual({ field: "included", value: "1000" })
    expect(includedCellOf(tokens)).toBeNull()
    expect(includedCellOf(seats)).toEqual({ field: "defaultQuantity", value: "3" })
  })

  it("derives the price cell from the shape and the rows", () => {
    const byFeature = rowsByFeature(rows, NOW)
    expect(priceCellOf(baseFee, byFeature.get("base-fee"), "USD", "monthly")).toMatchObject({
      kind: "amount",
      shape: "flat",
      amount: "49",
      suffix: "/ month",
      priced: true,
    })
    expect(priceCellOf(baseFee, undefined, "USD", "yearly")).toMatchObject({
      amount: "0",
      suffix: "/ year",
      priced: false,
    })
    expect(priceCellOf(apiCalls, byFeature.get("api-calls"), "USD", "monthly")).toMatchObject({
      kind: "amount",
      shape: "unit",
      amount: "0.002",
      suffix: "/ call",
    })
    expect(priceCellOf(seats, byFeature.get("seats"), "USD", "monthly")).toMatchObject({
      kind: "summary",
      action: "tiers",
      text: "3 included, then $10 / seat",
    })
    expect(priceCellOf(tokens, byFeature.get("tokens"), "USD", "monthly")).toMatchObject({
      kind: "summary",
      action: "catalog",
      text: "2 models from the catalog",
    })
  })
})

describe("cell text", () => {
  it("names a billing or reset period", () => {
    expect(cycleWord("monthly")).toBe("month")
    expect(cycleWord("yearly")).toBe("year")
    expect(cycleWord("weekly")).toBe("week")
    expect(cycleWord("daily")).toBe("day")
    expect(cycleWord("every-5-minutes")).toBe("cycle")
    expect(cycleWord(undefined)).toBe("cycle")
  })

  it("formats a count, a price in its currency, and leaves other text alone", () => {
    expect(formatCellValue("1000")).toBe("1,000")
    expect(formatCellValue("1234.5")).toBe("1,234.5")
    expect(formatCellValue("49", "USD")).toBe("$49")
    expect(formatCellValue("0.000003", "USD")).toBe("$0.000003")
    expect(formatCellValue("", "USD")).toBe("")
    expect(formatCellValue("abc")).toBe("abc")
    expect(formatUnits("0")).toBe("")
    expect(formatUnits("")).toBe("")
    expect(formatUnits("250000")).toBe("250,000")
  })

  it("takes the symbol from the currency's own format", () => {
    expect(currencySymbol("USD")).toBe("$")
    expect(currencySymbol("EUR")).toBe("€")
  })

  it("puts the unit after a count, singular for one, with a reset period that differs", () => {
    expect(unitSuffixOf(apiCalls, "monthly", "1000")).toBe("calls")
    expect(unitSuffixOf(seats, "monthly", "1")).toBe("seat")
    expect(unitSuffixOf(images, "monthly", "50")).toBe("images / day")
    expect(unitSuffixOf(images, "daily", "50")).toBe("images")
    expect(unitSuffixOf({ ...apiCalls, unitOfMeasure: "call" }, "monthly", "2")).toBe("calls")
    expect(unitSuffixOf({ ...images, unitOfMeasure: "image" }, "monthly", "1")).toBe("image / day")
  })

  it("summarizes tiers as included units then a rate, or every tier", () => {
    const seatTiers = rows[1]?.price as Extract<RatePrice, { type: "graduated" }>
    expect(tierSummary(seatTiers, "USD", "seat")).toBe("3 included, then $10 / seat")

    const volume = row("rr_volume", "api-calls", {
      type: "graduated",
      property: null,
      per: 1,
      tiers: [
        { upTo: 100, rate: "0.01", flat: "0" },
        { upTo: 1000, rate: "0.008", flat: "5" },
        { upTo: null, rate: "0.005", flat: "0" },
      ],
    }).price as Extract<RatePrice, { type: "graduated" }>
    expect(tierSummary(volume, "USD", "call")).toBe(
      "1-100 call at $0.01 / call, 101-1000 call at $5 + $0.008 / call, 1001-∞ call at $0.005 / call"
    )
  })

  it("counts prices by dimension", () => {
    const byFeature = rowsByFeature(rows, NOW)
    expect(dimensionSummary(byFeature.get("tokens")?.byDimension ?? [])).toBe(
      "2 models from the catalog"
    )
    expect(dimensionSummary(rows.slice(4, 5))).toBe("1 model from the catalog")
  })
})
