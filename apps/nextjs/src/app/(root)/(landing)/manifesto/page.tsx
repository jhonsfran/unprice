import type { Metadata } from "next"
import dynamic from "next/dynamic"
import { LazyMotionWrapper } from "~/components/landing/lazy-motion-wrapper"
import ManifestoHero from "~/components/landing/manifesto-hero"

const MechanismSection = dynamic(() =>
  import("~/components/landing/mechanism").then((mod) => mod.MechanismSection)
)
const ManifestoPriceOps = dynamic(() => import("~/components/landing/manifesto-priceops"))
const CapabilitiesSection = dynamic(() =>
  import("~/components/landing/capabilities").then((mod) => mod.CapabilitiesSection)
)
const ManifestoOwnership = dynamic(() => import("~/components/landing/manifesto-ownership"))
const ManifestoBelief = dynamic(() => import("~/components/landing/manifesto-belief"))

export const metadata: Metadata = {
  title: "Manifesto",
  description:
    "Pricing is a runtime decision. Why the customer money path belongs in the request path, in the open — and why it should be yours.",
}

export default function Manifesto() {
  return (
    <LazyMotionWrapper>
      <main className="flex flex-col overflow-hidden">
        <ManifestoHero />
        <MechanismSection />
        <ManifestoPriceOps />
        <CapabilitiesSection />
        <ManifestoOwnership />
        <ManifestoBelief />
      </main>
    </LazyMotionWrapper>
  )
}
