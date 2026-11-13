import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient } from "@trpc/client"
import { observable } from "@trpc/server/observable"
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query"
import {
  type RateCard,
  costPlusFeaturePolicySchema,
  rateCostSchema,
  ratePriceSchema,
  rateRowSchema,
} from "@unprice/db/validators"
import type { AppRouter } from "@unprice/trpc/routes"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  type CatalogPreview,
  DEFAULT_CATALOG_POLICY,
  catalogPricingInputOf,
  markupRateOf,
  policyDraftOf,
} from "~/components/pricing/catalog-policy"
import { rowsByFeature } from "~/components/pricing/plan-prices"
import { useCatalogPricing } from "~/components/pricing/use-catalog-pricing"
import { TRPCProvider } from "~/trpc/client"
import { CatalogUpdates } from "../../../rate-cards/_components/catalog-updates"
import { CatalogPriceBlockView } from "./catalog-price-block"

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
      featureSlug="tokens"
      now={NOW}
      card={{ own: true, currency: "USD", card: rateCard, rows }}
      rows={rowsByFeature(rows, NOW).get("tokens")}
      currency="USD"
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
  it("lists the feature's model prices as a sheet and the markup with its default", () => {
    const html = render()

    expect(html).toContain("1 models priced")
    expect(html).toContain("claude-sonnet-4")
    expect(html).toContain("Input")
    expect(html).toContain("$0.000004")
    expect(html).not.toContain("model=claude-sonnet-4")
    expect(html).toContain('value="30"')
    expect(html).toContain("input_tokens, output_tokens, cache_read_tokens, cache_write_tokens")
    expect(html).toContain("rounded to 0.000001")
    expect(html).toContain("Preview prices")
  })

  it("renders the preview as the lines that change, with its writes to publish", () => {
    const html = render({ preview })

    expect(html).toContain("1 changed, 1 new at cost + 30%.")
    expect(html).toContain("Publish 2 model prices")
    expect(html).toContain("gpt-4o")
    expect(html).toContain("$0.0000033")
    expect(html).toContain("$0.000004")
    expect(html).toContain("$0.0000039")
    // The unchanged model is not a line of the change sheet; it only appears in the tier note.
    expect(html.match(/gemini-2\.5-pro/g)).toHaveLength(1)
    expect(html).not.toContain("unchanged")
    expect(html).toContain("longer contexts cost the provider more")
  })

  it("says the feature is unpriced when the card has no model rows yet", () => {
    const html = render({ rows: undefined })

    expect(html).toContain("Not priced yet. Pick a markup over the provider")
  })

  it("sends another currency to the card, since the catalog prices in USD", () => {
    const html = render({ currency: "EUR" })

    expect(html).toContain("Catalog pricing is in USD; price EUR models")
    expect(html).not.toContain("Preview prices")
  })

  it("reads only, for a published version", () => {
    const html = render({ editable: false })

    expect(html).toContain("1 models priced")
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

describe("policyDraftOf", () => {
  it("opens the editor on the markup the card prices with, not the default 30%", () => {
    const saved = costPlusFeaturePolicySchema.parse({
      featureSlug: "model_tokens",
      markup: "0.5",
      roundTo: "0.0001",
      dimension: "model",
      componentMap: { input: "prompt_tokens", output: "completion_tokens" },
    })

    expect(policyDraftOf(saved)).toEqual({
      markupPercent: "50",
      roundTo: "0.0001",
      components: {
        input: "prompt_tokens",
        output: "completion_tokens",
        cache_read: "",
        cache_write: "",
      },
    })
  })
})

const policyInput = {
  markup: "0.3",
  roundTo: "0.000001",
  dimension: "model",
  componentMap: { input: "input_tokens", output: "output_tokens" },
}

function pricingActions(deferPreview = false) {
  let answerPreview = () => {}
  const requests: { path: string; input: unknown; type: string }[] = []
  const queryClient = new QueryClient()
  const published = { inserted: [], closed: [], unchanged: 0 }
  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input, type: op.type })
            const answer = () => {
              observer.next({
                result: {
                  data:
                    op.path.endsWith("publishCostPlus") || op.path.endsWith("applyCatalogPricing")
                      ? published
                      : preview,
                },
              })
              observer.complete()
            }
            if (deferPreview && op.path.endsWith("previewCatalogPricing")) answerPreview = answer
            else answer()
          }),
    ],
  })
  const captured: ReturnType<typeof useCatalogPricing>[] = []
  function Actions() {
    captured.push(
      useCatalogPricing(
        { planVersionId: "pv_1", featureSlug: "tokens" },
        { ok: true, input: policyInput }
      )
    )
    return null
  }
  renderToString(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <Actions />
      </TRPCProvider>
    </QueryClientProvider>
  )
  const [pricing] = captured
  if (!pricing) throw new Error("Catalog actions did not render")
  return { pricing, requests, published, answerPreview: () => answerPreview() }
}

describe("catalog pricing requests", () => {
  const input = {
    markup: "0.3",
    roundTo: "0.000001",
    dimension: "model",
    componentMap: { input: "input_tokens", output: "output_tokens" },
  }

  it("previews the policy through the read-only preview procedure", async () => {
    const { pricing, requests } = pricingActions()

    await expect(pricing.runPreview({ ok: true, input })).resolves.toBeUndefined()
    expect(requests).toEqual([
      {
        path: "rateCards.previewCatalogPricing",
        type: "query",
        input: { planVersionId: "pv_1", featureSlug: "tokens", ...input },
      },
    ])
  })

  it("applies once with the reviewed hash, without saving or requesting a new preview", async () => {
    const { pricing, requests, published } = pricingActions()

    await pricing.runPreview({ ok: true, input })
    requests.length = 0
    await expect(pricing.apply(input)).resolves.toEqual(published)
    expect(requests).toEqual([
      {
        path: "rateCards.applyCatalogPricing",
        type: "mutation",
        input: {
          planVersionId: "pv_1",
          featureSlug: "tokens",
          ...input,
          draftHash: "hash_1",
        },
      },
    ])
  })
  it("ignores a preview that finishes after the policy editor resets", async () => {
    const { pricing, requests, answerPreview } = pricingActions(true)
    const pending = pricing.runPreview({ ok: true, input })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    pricing.reset()
    answerPreview()
    await pending
    await expect(pricing.apply(input)).resolves.toBeUndefined()
    expect(requests.map((request) => request.path)).toEqual(["rateCards.previewCatalogPricing"])
  })

  it("refuses a policy that differs from the reviewed input", async () => {
    const { pricing, requests } = pricingActions()
    await pricing.runPreview({ ok: true, input })
    await expect(pricing.apply({ ...input, markup: "0.5" })).resolves.toBeUndefined()
    expect(requests.map((request) => request.path)).toEqual(["rateCards.previewCatalogPricing"])
  })
})

describe("CatalogUpdates", () => {
  it("reads the preview for the displayed feature, with a separate hash for each feature", () => {
    const queryClient = new QueryClient()
    const trpcClient = createTRPCClient<AppRouter>({ links: [] })
    const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient })
    queryClient.setQueryData(
      trpc.rateCards.previewCostPlus.queryKey({ cardId: rateCard.id, featureSlug: "tokens" }),
      { draft: preview.draft, draftHash: "tokens_hash" }
    )
    queryClient.setQueryData(
      trpc.rateCards.previewCostPlus.queryKey({ cardId: rateCard.id, featureSlug: "images" }),
      { draft: { cardId: rateCard.id, at: NOW, changes: [] }, draftHash: "images_hash" }
    )
    const policy = costPlusFeaturePolicySchema.parse({
      featureSlug: "tokens",
      markup: "0.3",
      roundTo: "0.000001",
      dimension: "model",
      componentMap: { input: "input_tokens" },
    })
    const html = renderToString(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <CatalogUpdates card={rateCard} policy={policy} live={false} unit="tokens" />
        </TRPCProvider>
      </QueryClientProvider>
    ).replace(/<!-- -->/g, "")

    expect(html).toContain("The catalog changed: 1 changed, 1 new.")
    expect(html).toContain("Apply 2 prices")
    expect(html).toContain("gpt-4o")
  })
})
