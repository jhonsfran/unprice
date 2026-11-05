import { DndContext } from "@dnd-kit/core"
import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { rateRowSchema } from "@unprice/db/validators"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { rowsByFeature } from "../../_components/plan-prices"
import { FeatureTableView } from "./feature-table"
import { includedCellOf, kindChangeOf, limitCellOf, priceCellOf } from "./feature-table-cells"

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

/** The `value` attribute of the input labelled `label`. */
function inputValue(html: string, label: string): string | null {
  const input = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0]
  return input?.match(/value="([^"]*)"/)?.[1] ?? null
}

describe("FeatureTableView", () => {
  it("prices a fixed feature in its cell, with no limit or included cell", () => {
    const html = render([baseFee])

    expect(html).toContain("Base fee")
    expect(html).toContain("base-fee")
    expect(html).toContain("Fixed")
    expect(inputValue(html, "Price")).toBe("49")
    expect(html).toContain("per cycle")
    expect(inputValue(html, "Limit")).toBeNull()
    expect(inputValue(html, "Included")).toBeNull()
  })

  it("shows 0 for a fixed feature without a row, so committing the cell includes it", () => {
    const html = render([baseFee], { withRows: [] })

    expect(inputValue(html, "Price")).toBe("0")
    expect(html).not.toContain("Not priced")
  })

  it("edits a metered feature's limit, included units and unit price in place", () => {
    const html = render([apiCalls])

    expect(html).toContain("Metered")
    expect(inputValue(html, "Limit")).toBe("50000")
    expect(inputValue(html, "Included")).toBe("1000")
    expect(inputValue(html, "Price")).toBe("0.002")
    expect(html).toContain("per call")
  })

  it("summarizes tiers and sends the user to the sheet for them", () => {
    const html = render([seats])

    expect(html).toContain("Tiered")
    expect(html).toContain("$0 / seat (2 tiers)")
    expect(html).toContain("Set tiers")
    expect(inputValue(html, "Included")).toBe("3")
    expect(inputValue(html, "Price")).toBeNull()
  })

  it("counts the prices by dimension and hides included units for them", () => {
    const html = render([tokens])

    expect(html).toContain("2 prices by model")
    expect(html).toContain("Price models")
    expect(inputValue(html, "Included")).toBeNull()
  })

  it("reads only for a published version, as facts in mono", () => {
    const html = render([baseFee, apiCalls], { editable: false })

    expect(html).not.toContain("<input")
    expect(html).toContain("$49")
    expect(html).toContain("$0.002 / call")
    expect(html).toContain("50,000")
    expect(html).toContain("1,000")
    expect(html).not.toContain("Drag to reorder")
    expect(html).toContain("Actions for Base fee")
  })

  it("keeps a feature without a row unpriced in the read view", () => {
    const html = render([seats], { editable: false, withRows: [] })

    expect(html).toContain("Not priced")
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
    expect(priceCellOf(baseFee, byFeature.get("base-fee"), "USD")).toMatchObject({
      kind: "amount",
      shape: "flat",
      amount: "49",
      priced: true,
    })
    expect(priceCellOf(baseFee, undefined, "USD")).toMatchObject({ amount: "0", priced: false })
    expect(priceCellOf(seats, byFeature.get("seats"), "USD")).toMatchObject({
      kind: "summary",
      action: "tiers",
      text: "$0 / seat (2 tiers)",
    })
    expect(priceCellOf(tokens, byFeature.get("tokens"), "USD")).toMatchObject({
      kind: "summary",
      action: "catalog",
      text: "2 prices by model",
    })
  })
})
