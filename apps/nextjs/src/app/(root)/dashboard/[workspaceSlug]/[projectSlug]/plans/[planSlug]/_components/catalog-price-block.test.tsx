import {
  type RateCard,
  rateCostSchema,
  ratePriceSchema,
  rateRowSchema,
} from "@unprice/db/validators"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { rowsByFeature } from "../../_components/plan-prices"
import {
  type CatalogPreview,
  CatalogPriceBlockView,
  DEFAULT_CATALOG_POLICY,
  catalogPricingInputOf,
  markupRateOf,
} from "./catalog-price-block"

// SuperLink needs a mounted app router; the link target is not what these tests check.
vi.mock("~/components/super-link", () => ({
  SuperLink: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}))

const NOW = Date.parse("2026-11-04T12:00:00.000Z")

const rateCard = {
  id: "rc_1",
  projectId: "proj_1",
  name: "starter pv_1 USD",
  unit: "money:USD",
  marginPolicy: { type: "manual" },
} satisfies RateCard

function modelRow(id: string, model: string, rate: string) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug: "tokens",
    match: { model },
    price: { type: "unit", components: [{ property: "input_tokens", rate, per: 1 }] },
    cost: null,
    effectiveFrom: NOW - 3_600_000,
    effectiveTo: null,
    source: "catalog",
    sourceRef: null,
  })
}

function proposed(model: string, rate: string) {
  return {
    featureSlug: "tokens",
    match: { model },
    price: ratePriceSchema.parse({
      type: "unit",
      components: [{ property: "input_tokens", rate, per: 1 }],
    }) as Extract<ReturnType<typeof ratePriceSchema.parse>, { type: "unit" }>,
    cost: rateCostSchema.parse({ components: [{ property: "input_tokens", rate, per: 1 }] }),
    source: "catalog" as const,
    sourceRef: null,
  }
}

const preview: CatalogPreview = {
  cardId: "rc_1",
  draftHash: "hash_1",
  tieredModels: ["gemini-2.5-pro"],
  draft: {
    cardId: "rc_1",
    at: NOW,
    changes: [
      { type: "added", proposed: proposed("gpt-4o", "0.0000033") },
      {
        type: "changed",
        current: modelRow("rr_claude", "claude-sonnet-4", "0.000004"),
        proposed: proposed("claude-sonnet-4", "0.0000039"),
        components: [],
      },
      {
        type: "unchanged",
        current: modelRow("rr_gemini", "gemini-2.5-pro", "0.0000016"),
        proposed: proposed("gemini-2.5-pro", "0.0000016"),
      },
    ],
  },
}

function render(props: Partial<Parameters<typeof CatalogPriceBlockView>[0]> = {}) {
  const rows = [modelRow("rr_claude", "claude-sonnet-4", "0.000004")]
  return renderToString(
    <CatalogPriceBlockView
      card={{ currency: "USD", card: rateCard, rows }}
      rows={rowsByFeature(rows, NOW).get("tokens")}
      currency="USD"
      dimension="model"
      editable
      policy={DEFAULT_CATALOG_POLICY}
      onPolicyChange={() => {}}
      preview={null}
      problem={null}
      onPreview={() => {}}
      onPublish={() => {}}
      {...props}
    />
  ).replace(/<!-- -->/g, "")
}

describe("CatalogPriceBlockView", () => {
  it("lists the feature's model prices and the policy inputs with their defaults", () => {
    const html = render()

    expect(html).toContain("1 prices by model")
    expect(html).toContain("model=claude-sonnet-4")
    expect(html).toContain("$0.000004 / input_tokens")
    expect(html).toContain('value="30"')
    expect(html).toContain('value="0.000001"')
    expect(html).toContain('value="cache_write_tokens"')
    expect(html).toContain("models.dev 2026-10-20")
    expect(html).toContain("openai, anthropic, google")
    expect(html).toContain("Preview prices")
  })

  it("renders the preview with its writes to publish and the models priced at their base tier", () => {
    const html = render({ preview })

    expect(html).toContain("Publish 2 model prices")
    expect(html).toContain("model=gpt-4o")
    expect(html).toContain("$0.0000033 / input_tokens")
    expect(html).toContain("longer contexts cost the provider more")
    expect(html).toContain("gemini-2.5-pro")
  })

  it("says the feature is unpriced when the card has no model rows yet", () => {
    const html = render({ rows: undefined })

    expect(html).toContain("Not priced yet. Publishing refuses a version with an unpriced feature.")
  })

  it("sends another currency to the card, since the catalog prices in USD", () => {
    const html = render({ currency: "EUR" })

    expect(html).toContain("Catalog pricing is in USD; price EUR models")
    expect(html).not.toContain("Preview prices")
  })

  it("reads only, for a published version", () => {
    const html = render({ editable: false })

    expect(html).toContain("1 prices by model")
    expect(html).not.toContain("Preview prices")
  })
})

describe("catalogPricingInputOf", () => {
  it("turns the typed policy into the procedure's input", () => {
    expect(markupRateOf("30")).toBe("0.3")
    expect(markupRateOf("12.5")).toBe("0.125")
    expect(markupRateOf("0")).toBe("0")
    expect(markupRateOf("-1")).toBeNull()
    expect(
      catalogPricingInputOf(
        {
          ...DEFAULT_CATALOG_POLICY,
          components: { ...DEFAULT_CATALOG_POLICY.components, cache_write: " " },
        },
        "model"
      )
    ).toEqual({
      ok: true,
      input: {
        markup: "0.3",
        roundTo: "0.000001",
        dimension: "model",
        componentMap: {
          input: "input_tokens",
          output: "output_tokens",
          cache_read: "cache_read_tokens",
        },
      },
    })
  })

  it("names what stops the preview", () => {
    expect(
      catalogPricingInputOf({ ...DEFAULT_CATALOG_POLICY, markupPercent: "x" }, "model")
    ).toEqual({ ok: false, message: "Markup is a percentage, like 30." })
    expect(catalogPricingInputOf({ ...DEFAULT_CATALOG_POLICY, roundTo: "0" }, "model")).toEqual({
      ok: false,
      message: "Round to is a positive decimal, like 0.000001.",
    })
    expect(
      catalogPricingInputOf(
        {
          ...DEFAULT_CATALOG_POLICY,
          components: { input: "", output: "", cache_read: "", cache_write: "" },
        },
        undefined
      )
    ).toEqual({ ok: false, message: "Map at least one cost component to an event property." })
  })
})
