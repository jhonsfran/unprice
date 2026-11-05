import { type RateCard, rateRowSchema } from "@unprice/db/validators"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { PricedByCardView } from "./priced-by-card"

// SuperLink needs a mounted app router; the link target is not what these tests check.
vi.mock("~/components/super-link", () => ({
  SuperLink: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}))

const card = {
  currency: "USD" as const,
  card: {
    id: "rc_1",
    projectId: "proj_1",
    name: "Pro USD",
    unit: "money:USD",
    marginPolicy: { type: "manual" },
  } satisfies RateCard,
  rows: [
    rateRowSchema.parse({
      id: "rr_1",
      rateCardId: "rc_1",
      featureSlug: "api-calls",
      match: {},
      price: { type: "package", property: null, size: 1000, rate: "5" },
      cost: null,
      effectiveFrom: 0,
      effectiveTo: null,
      source: "manual",
      sourceRef: null,
    }),
  ],
}

function render(props: Partial<Parameters<typeof PricedByCardView>[0]>) {
  return renderToString(
    <PricedByCardView card={card} featureSlug="api-calls" currency="USD" unit="call" {...props} />
  ).replace(/<!-- -->/g, "")
}

describe("PricedByCardView", () => {
  it("shows the feature's current row on the version's card instead of a price form", () => {
    const html = render({})

    expect(html).toContain("Priced by card")
    expect(html).toContain("Pro USD")
    expect(html).toContain("$5 / 1,000 call")
  })

  it("says the feature is not priced when the card has no row for it", () => {
    expect(render({ featureSlug: "seats" })).toContain("not priced")
  })

  it("asks for a card when the version has none in its currency", () => {
    expect(render({ card: undefined })).toContain("has no USD rate card")
  })
})
