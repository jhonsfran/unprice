import type { Metadata } from "next"
import dynamic from "next/dynamic"
import ManifestoHero from "~/components/landing/manifesto-hero"

const MechanismSection = dynamic(() =>
  import("~/components/landing/mechanism").then((mod) => mod.MechanismSection)
)
const ManifestoPriceOps = dynamic(() => import("~/components/landing/manifesto-priceops"))
const ManifestoOwnership = dynamic(() => import("~/components/landing/manifesto-ownership"))
const ManifestoBelief = dynamic(() => import("~/components/landing/manifesto-belief"))

const description =
  "Pricing is a runtime decision. Why the check on customer spend belongs in the request, in open-source code you own."

// The manifesto ships its own social card: the generic landing card sells the
// product frame; this page's card must carry the manifesto's own line.
const ogImage = `/og?title=${encodeURIComponent("The Unprice manifesto")}&description=${encodeURIComponent(
  "Pricing is a runtime decision. The check on customer spend belongs in the request, in open-source code you own."
)}`

export const metadata: Metadata = {
  title: "Manifesto",
  description,
  openGraph: {
    type: "article",
    url: "https://unprice.dev/manifesto",
    title: "The Unprice manifesto",
    description,
    images: [{ url: ogImage, width: 1200, height: 630, alt: "The Unprice manifesto" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "The Unprice manifesto",
    description,
    images: [{ url: ogImage, width: 1200, height: 630, alt: "The Unprice manifesto" }],
  },
  alternates: {
    canonical: "https://unprice.dev/manifesto",
  },
}

export default function Manifesto() {
  return (
    <main className="flex flex-col overflow-hidden">
      <ManifestoHero />
      <MechanismSection />
      <ManifestoPriceOps />
      <ManifestoOwnership />
      <ManifestoBelief />
    </main>
  )
}
