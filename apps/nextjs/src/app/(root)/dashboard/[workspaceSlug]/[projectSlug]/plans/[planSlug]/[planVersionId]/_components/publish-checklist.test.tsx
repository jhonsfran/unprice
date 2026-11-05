import { rateRowSchema } from "@unprice/db/validators"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PublishChecklistView } from "./publish-checklist"

const NOW = Date.parse("2026-11-05T12:00:00.000Z")
const HOUR = 3_600_000

function row(id: string, featureSlug: string, from: number, match: Record<string, string> = {}) {
  return rateRowSchema.parse({
    id,
    rateCardId: "rc_1",
    featureSlug,
    match,
    price: { type: "unit", components: [{ property: null, rate: "0.02", per: 1 }] },
    cost: null,
    effectiveFrom: from,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
}

const features = [
  { slug: "base-fee", title: "Base fee" },
  { slug: "seats", title: "Seats" },
  { slug: "tokens", title: "LLM tokens" },
  { slug: "images", title: "Images" },
]

function render(props: Partial<Parameters<typeof PublishChecklistView>[0]> = {}) {
  return renderToString(
    <PublishChecklistView
      features={features}
      rows={[
        row("rr_base", "base-fee", NOW - HOUR),
        row("rr_seats", "seats", NOW + HOUR),
        row("rr_gpt", "tokens", NOW - HOUR, { model: "gpt-4o" }),
      ]}
      hasCard
      currency="USD"
      now={NOW}
      {...props}
    />
  ).replace(/<!-- -->/g, "")
}

describe("PublishChecklistView", () => {
  it("marks each feature priced, scheduled, or unpriced and counts the unpriced ones", () => {
    const html = render()

    expect(html).toContain("Card in USD")
    expect(html).toContain("present")
    expect(html).toMatch(/Base fee.*priced/)
    expect(html).toMatch(/Seats.*scheduled/)
    expect(html).toMatch(/LLM tokens.*priced/)
    expect(html).toMatch(/Images.*unpriced/)
    expect(html).toContain("1 unpriced feature. Publishing refuses until each has a price.")
  })

  it("says every feature is priced when none is missing a row", () => {
    const html = render({ rows: features.map((f) => row(`rr_${f.slug}`, f.slug, NOW - HOUR)) })

    expect(html).toContain("Every feature is priced.")
    expect(html).not.toContain("unpriced")
  })

  it("names the missing card and the empty feature list", () => {
    const html = render({ features: [], rows: [], hasCard: false })

    expect(html).toContain("none yet")
    expect(html).toContain("Attach a feature to start.")
  })
})
