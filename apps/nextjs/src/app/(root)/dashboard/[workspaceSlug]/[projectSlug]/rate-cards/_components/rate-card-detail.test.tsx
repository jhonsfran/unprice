import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient, httpLink } from "@trpc/client"
import { type RateCard, rateRowSchema } from "@unprice/db/validators"
import { priceTableOf } from "@unprice/services/pricing"
import type { AppRouter } from "@unprice/trpc/routes"
import { transformer } from "@unprice/trpc/transformer"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PriceMatrix } from "~/components/pricing/price-matrix"
import { matrixOf } from "~/components/pricing/rate-card-format"
import { TRPCProvider } from "~/trpc/client"
import { PriceList } from "./rate-card-detail"

const NOW = Date.parse("2026-11-04T12:00:00.000Z")
const MILLION = 1_000_000

const card: RateCard = {
  id: "rc_1",
  projectId: "proj_1",
  name: "Pro USD",
  unit: "money:USD",
  marginPolicy: { type: "manual" },
}

function row(id: string, rate: string, from: number, to: number | null) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug: "tokens",
    match: {},
    price: { type: "unit", components: [{ property: null, rate, per: 1 }] },
    cost: null,
    effectiveFrom: from,
    effectiveTo: to,
    source: "manual",
    sourceRef: null,
  })
}

function modelRow(id: string, model: string, input: string, output: string) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug: "llm_tokens",
    match: { model },
    price: {
      type: "unit",
      components: [
        { property: "input_tokens", rate: input, per: MILLION },
        { property: "output_tokens", rate: output, per: MILLION },
      ],
    },
    cost: null,
    effectiveFrom: NOW - 3_600_000,
    effectiveTo: null,
    source: "catalog",
    sourceRef: null,
  })
}

function render(rows: ReturnType<typeof row>[], live = false): string {
  const queryClient = new QueryClient()
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/unused", transformer })],
  })
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <PriceList
          data={{ card, rows, live }}
          features={[
            { slug: "tokens", title: "Tokens", unit: "token" },
            { slug: "llm_tokens", title: "LLM tokens", unit: "tokens" },
          ]}
          now={NOW}
        />
      </TRPCProvider>
    </QueryClientProvider>
  ).replace(/<!-- -->/g, "")
}

describe("PriceList", () => {
  it("shows a feature's current and scheduled prices, keeps past ones apart, and ends only open rows", () => {
    const html = render([
      row("rr_old", "0.03", NOW - 86_400_000, NOW - 3_600_000),
      row("rr_live", "0.02", NOW - 3_600_000, NOW + 600_000),
      row("rr_next", "0.015", NOW + 600_000, null),
    ])

    expect(html).toContain("Tokens")
    expect(html).toContain("$0.02")
    expect(html).toContain("$0.015")
    expect(html).toContain("scheduled")
    expect(html).toContain("1 past price")
    // History starts closed: the past price is one click away, not on the page.
    expect(html).not.toContain("$0.03")
    // The live row already ends where its successor starts; only the open successor can end.
    expect(html.match(/End…/g)).toHaveLength(1)
    expect(html).toContain("a change starts at once")
  })

  it("closes a sheet of model prices until asked for, and names how many it holds", () => {
    const html = render([
      modelRow("rr_haiku", "claude-haiku-5-5", "0.13", "0.65"),
      modelRow("rr_opus", "claude-opus-4-5", "6.5", "32.5"),
    ])

    expect(html).toContain("LLM tokens")
    expect(html).toContain("2 prices by model")
    expect(html).toContain("Show 2 model prices")
    expect(html).not.toContain("claude-haiku-5-5")
  })

  it("lays model prices out as a sheet: a line per model, a column per token kind, per 1M", () => {
    const rows = [
      modelRow("rr_haiku", "claude-haiku-5-5", "0.13", "0.65"),
      modelRow("rr_opus", "claude-opus-4-5", "6.5", "32.5"),
    ]
    const html = renderToString(
      <PriceMatrix
        matrix={matrixOf(priceTableOf("llm_tokens", rows, NOW, "USD", "token"))}
        currency="USD"
        unit="token"
      />
    ).replace(/<!-- -->/g, "")

    expect(html).toContain("Input")
    expect(html).toContain("Output")
    expect(html).toContain("per 1M tokens")
    expect(html).toContain("claude-haiku-5-5")
    expect(html).toContain("$0.13")
    expect(html).toContain("$32.5")
    expect(html).not.toContain("input_tokens")
  })

  it("says a live card's change waits for the notice", () => {
    const html = render([row("rr_live", "0.02", NOW - 3_600_000, null)], true)

    expect(html).toContain("starts 10 minutes later")
  })

  it("explains that the first prices come from the plan editor when the card has none", () => {
    const html = render([])

    expect(html).toContain("No prices yet")
    expect(html).toContain("Set a price per feature in the plan editor")
  })
})
