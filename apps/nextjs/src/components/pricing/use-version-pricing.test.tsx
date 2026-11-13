import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient } from "@trpc/client"
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query"
import { rateRowSchema } from "@unprice/db/validators"
import type { AppRouter } from "@unprice/trpc/routes"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TRPCProvider } from "~/trpc/client"
import { useVersionPricing } from "./use-version-pricing"

const NOW = Date.parse("2026-11-05T12:00:00.000Z")
const row = rateRowSchema.parse({
  id: "rr_1",
  rateCardId: "rc_1",
  featureSlug: "tokens",
  match: {},
  price: { type: "flat", amount: "1" },
  cost: null,
  effectiveFrom: NOW + 1000,
  effectiveTo: null,
  source: "manual",
  sourceRef: null,
})
function readPricing(currency: string) {
  const queryClient = new QueryClient()
  const trpcClient = createTRPCClient<AppRouter>({ links: [] })
  const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient })
  queryClient.setQueryData(
    trpc.rateCards.forPlanVersion.queryKey({ planVersionId: "pv_1" }),
    {
      cards: [
        {
          own: true,
          currency: "USD",
          rows: [row],
          card: {
            id: "rc_1",
            projectId: "proj_1",
            name: "version USD",
            unit: "money:USD",
            marginPolicy: { type: "manual" },
          },
        },
      ],
      hasCard: true,
      unpricedFeatureSlugs: ["requests"],
    },
    { updatedAt: NOW }
  )
  const captured: ReturnType<typeof useVersionPricing>[] = []
  function Read() {
    captured.push(useVersionPricing("pv_1", currency))
    return null
  }
  renderToString(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <Read />
      </TRPCProvider>
    </QueryClientProvider>
  )
  const [pricing] = captured
  if (!pricing) throw new Error("Pricing did not render")
  return pricing
}

describe("useVersionPricing", () => {
  it("selects the requested currency and classifies rows at dataUpdatedAt", () => {
    const pricing = readPricing("USD")
    expect(pricing.card?.card.id).toBe("rc_1")
    expect(pricing.now).toBe(NOW)
    expect(pricing.rows.get("tokens")?.current).toBeNull()
    expect(pricing.rows.get("tokens")?.scheduled?.id).toBe("rr_1")
    expect(pricing.isLoading).toBe(false)
  })
  it("does not use another currency's first card", () => {
    const pricing = readPricing("EUR")
    expect(pricing.card).toBeUndefined()
    expect(pricing.rows.size).toBe(0)
  })
  it("returns server readiness without deriving it from the display rows", () => {
    expect(readPricing("USD").readiness).toEqual({
      hasCard: true,
      unpricedFeatureSlugs: ["requests"],
    })
  })
})
