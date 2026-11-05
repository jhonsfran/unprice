import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient, httpLink } from "@trpc/client"
import { type RateCard, rateRowSchema } from "@unprice/db/validators"
import type { AppRouter } from "@unprice/trpc/routes"
import { transformer } from "@unprice/trpc/transformer"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TRPCProvider } from "~/trpc/client"
import { RateCardRows } from "./rate-card-detail"

const NOW = Date.parse("2026-11-04T12:00:00.000Z")

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

function render(rows: ReturnType<typeof row>[]): string {
  const queryClient = new QueryClient()
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/unused", transformer })],
  })
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <RateCardRows data={{ card, rows, live: false }} now={NOW} />
      </TRPCProvider>
    </QueryClientProvider>
  ).replace(/<!-- -->/g, "")
}

describe("RateCardRows", () => {
  it("groups a feature's rows into current and ended, and offers to close only open rows", () => {
    const html = render([
      row("rr_old", "0.03", NOW - 86_400_000, NOW - 3_600_000),
      row("rr_live", "0.02", NOW - 3_600_000, NOW + 600_000),
      row("rr_next", "0.015", NOW + 600_000, null),
    ])

    expect(html).toContain("tokens")
    expect(html).toContain("$0.02 / unit")
    expect(html).toContain("$0.015 / unit")
    expect(html).toContain("1 ended row")
    // The live row already ends where its successor starts; only the open successor can close.
    expect(html.match(/Close…/g)).toHaveLength(1)
    expect(html).toContain("a price change publishes a successor")
  })

  it("explains that a card's first rows start at once when it has none", () => {
    const html = render([])

    expect(html).toContain("No rows yet")
    expect(html).toContain("can start at once")
  })
})
