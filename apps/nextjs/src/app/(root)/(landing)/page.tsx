import dynamic from "next/dynamic"
import Hero from "~/components/landing/hero"
import { LazyMotionWrapper } from "~/components/landing/lazy-motion-wrapper"
import { PricingHero } from "~/components/landing/pricing-hero"

const Features = dynamic(() => import("~/components/landing/features").then((mod) => mod.Features))
const FeaturesApp = dynamic(() =>
  import("~/components/landing/features-app").then((mod) => mod.FeaturesApp)
)
const OfferSection = dynamic(() =>
  import("~/components/landing/offer").then((mod) => mod.OfferSection)
)
const ProblemSection = dynamic(() =>
  import("~/components/landing/problem").then((mod) => mod.ProblemSection)
)
const TrustSection = dynamic(() =>
  import("~/components/landing/trust").then((mod) => mod.TrustSection)
)
const CodeExample = dynamic(() => import("~/components/landing/code-example"))
const Cta = dynamic(() => import("~/components/landing/cta"))

export default function Home() {
  return (
    <LazyMotionWrapper>
      <main className="flex flex-col overflow-hidden">
        <Hero />
        <ProblemSection />
        <FeaturesApp />
        <OfferSection />
        <TrustSection />
        <PricingHero
          headline="Click until the budget blocks the request."
          description="This live model shows the moment Unprice stops over-budget work before it runs and keeps the response evidence visible."
          docsLinkText="Read the Docs"
        />
        <Features />
        <CodeExample />
        <Cta />
      </main>
    </LazyMotionWrapper>
  )
}
