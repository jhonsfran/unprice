import { type RateCard, rateRowSchema } from "@unprice/db/validators"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { rowsByFeature } from "../../_components/plan-prices"
import { PriceBlockView, prefillDraft, priceInputOf } from "./price-block"

// SuperLink needs a mounted app router; the link target is not what these tests check.
vi.mock("~/components/super-link", () => ({
  SuperLink: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}))

const NOW = Date.parse("2026-11-04T12:00:00.000Z")
const HOUR = 3_600_000

const rateCard = {
  id: "rc_1",
  projectId: "proj_1",
  name: "starter pv_1 USD",
  unit: "money:USD",
  marginPolicy: { type: "manual" },
} satisfies RateCard

function row(id: string, from: number, price: Record<string, unknown>) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug: "api-calls",
    match: {},
    price,
    cost: null,
    effectiveFrom: from,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
}

const packageRow = row("rr_1", NOW - HOUR, {
  type: "package",
  property: null,
  size: 1000,
  rate: "5",
})
const scheduledRow = row("rr_2", NOW + HOUR, {
  type: "package",
  property: null,
  size: 1000,
  rate: "4",
})
const twoComponentRow = row("rr_3", NOW - HOUR, {
  type: "unit",
  components: [
    { property: "input_tokens", rate: "0.00001", per: 1 },
    { property: "output_tokens", rate: "0.00003", per: 1 },
  ],
})

function render(
  rows: ReturnType<typeof row>[],
  props: Partial<Parameters<typeof PriceBlockView>[0]> = {}
) {
  const card = { currency: "USD" as const, card: rateCard, rows }
  return renderToString(
    <PriceBlockView
      card={card}
      rows={rowsByFeature(rows, NOW).get("api-calls")}
      currency="USD"
      unit="call"
      shape="package"
      editable
      draft={null}
      onDraftChange={() => {}}
      problem={null}
      {...props}
    />
  ).replace(/<!-- -->/g, "")
}

describe("PriceBlockView", () => {
  it("prefills the input from the current row and links the version's card", () => {
    const html = render([packageRow])

    expect(html).toContain("$5 / 1,000 call")
    expect(html).toContain("starter pv_1 USD")
    expect(html).toContain('value="5"')
    expect(html).toContain("Leave unpriced")
  })

  it("says the feature is unpriced and what publishing does about it", () => {
    const html = render([])

    expect(html).toContain("Not priced yet. Publishing refuses a version with an unpriced feature.")
    expect(html).toContain('id="feature-price"')
    expect(html).not.toContain("Leave unpriced")
  })

  it("starts a fixed feature at $0, so one save includes it", () => {
    const html = render([], { shape: "flat" })

    expect(html).toContain("Included at $0 unless you set an amount.")
    expect(html).toContain('value="0"')
    expect(html).not.toContain("Not priced yet.")
  })

  it("labels a scheduled row with when it starts", () => {
    const html = render([packageRow, scheduledRow])

    expect(html).toContain("$5 / 1,000 call")
    expect(html).toMatch(/\$4 \/ 1,000 call from /)
  })

  it("shows a row the decimal form cannot state read-only, with the card as the editor", () => {
    const html = render([twoComponentRow], { shape: "unit" })

    expect(html).toContain("$0.00001 / input_tokens + $0.00003 / output_tokens")
    expect(html).toContain("Edit it on the card.")
    expect(html).not.toContain('id="feature-price"')
  })

  it("renders a tiers editor with an open-ended last tier", () => {
    const html = render([], {
      shape: "graduated",
      draft: {
        kind: "tiers",
        tiers: [
          { key: "a", upTo: "1000", unitPrice: "0", flatPrice: "0" },
          { key: "b", upTo: "", unitPrice: "0.01", flatPrice: "5" },
        ],
      },
    })

    expect(html).toContain('value="1000"')
    expect(html).toContain("1001 and above")
    expect(html).toContain("Add tier")
  })

  it("keeps a draft that leaves the feature unpriced and a server refusal inline", () => {
    const html = render([packageRow], {
      draft: { kind: "unpriced" },
      problem: "Card starter pv_1 USD also prices v1; price this version on its own card",
    })

    expect(html).toContain("Unpriced on save.")
    expect(html).toContain("Set a price")
    expect(html).toContain("also prices v1")
    expect(html).toContain("Open the card.")
  })

  it("reads only, for a published version", () => {
    const html = render([packageRow], { editable: false })

    expect(html).toContain("$5 / 1,000 call")
    expect(html).not.toContain("feature-price")
    expect(html).not.toContain("Leave unpriced")
  })
})

describe("prefillDraft", () => {
  it("starts from the row when it fits the shape and empty when it does not", () => {
    expect(prefillDraft(packageRow, "package")).toEqual({ kind: "amount", amount: "5" })
    expect(prefillDraft(packageRow, "graduated")).toEqual({
      kind: "tiers",
      tiers: [{ key: "tier-1", upTo: "", unitPrice: "", flatPrice: "0" }],
    })
    expect(prefillDraft(twoComponentRow, "unit")).toBeNull()
    expect(prefillDraft(null, "flat")).toEqual({ kind: "amount", amount: "0" })
    expect(prefillDraft(null, "unit")).toEqual({ kind: "amount", amount: "" })
  })

  it("does not carry a fixed amount over as a unit price when the feature becomes metered", () => {
    const flatRow = row("rr_4", NOW - HOUR, { type: "flat", amount: "49" })
    expect(prefillDraft(flatRow, "unit")).toEqual({ kind: "amount", amount: "" })
    expect(prefillDraft(flatRow, "package")).toEqual({ kind: "amount", amount: "" })
    expect(prefillDraft(flatRow, "flat")).toEqual({ kind: "amount", amount: "49" })
  })

  it("starts tiers as the included units at $0, then an open tier to price", () => {
    expect(prefillDraft(null, "graduated", 3)).toEqual({
      kind: "tiers",
      tiers: [
        { key: "tier-0", upTo: "3", unitPrice: "0", flatPrice: "0" },
        { key: "tier-1", upTo: "", unitPrice: "", flatPrice: "0" },
      ],
    })
    expect(
      priceInputOf({
        kind: "tiers",
        tiers: [
          { key: "tier-0", upTo: "3", unitPrice: "0", flatPrice: "0" },
          { key: "tier-1", upTo: "", unitPrice: "10", flatPrice: "0" },
        ],
      })
    ).toEqual({
      ok: true,
      price: {
        tiers: [
          { firstUnit: 1, lastUnit: 3, unitPrice: "0", flatPrice: "0" },
          { firstUnit: 4, lastUnit: null, unitPrice: "10", flatPrice: "0" },
        ],
      },
    })
  })
})

describe("priceInputOf", () => {
  it("builds the update's price from an amount, tiers, or the choice to stay unpriced", () => {
    expect(priceInputOf({ kind: "amount", amount: " 0.02 " })).toEqual({
      ok: true,
      price: { price: "0.02" },
    })
    expect(priceInputOf({ kind: "unpriced" })).toEqual({ ok: true, price: null })
    expect(
      priceInputOf({
        kind: "tiers",
        tiers: [
          { key: "a", upTo: "1000", unitPrice: "0", flatPrice: "" },
          { key: "b", upTo: "", unitPrice: "0.01", flatPrice: "5" },
        ],
      })
    ).toEqual({
      ok: true,
      price: {
        tiers: [
          { firstUnit: 1, lastUnit: 1000, unitPrice: "0", flatPrice: "0" },
          { firstUnit: 1001, lastUnit: null, unitPrice: "0.01", flatPrice: "5" },
        ],
      },
    })
  })

  it("names what stops the price from being saved", () => {
    expect(priceInputOf({ kind: "amount", amount: "" })).toEqual({
      ok: false,
      message: "Enter a price, or leave the feature unpriced.",
    })
    expect(priceInputOf({ kind: "amount", amount: "-1" })).toMatchObject({ ok: false })
    expect(
      priceInputOf({
        kind: "tiers",
        tiers: [
          { key: "a", upTo: "10", unitPrice: "1", flatPrice: "0" },
          { key: "b", upTo: "5", unitPrice: "1", flatPrice: "0" },
          { key: "c", upTo: "", unitPrice: "1", flatPrice: "0" },
        ],
      })
    ).toEqual({ ok: false, message: "Tier 2 ends at a whole number of at least 11." })
  })
})
