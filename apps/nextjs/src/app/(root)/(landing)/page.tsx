import dynamic from "next/dynamic"
import Hero from "~/components/landing/hero"
import { LazyMotionWrapper } from "~/components/landing/lazy-motion-wrapper"
import { PricingHero } from "~/components/landing/pricing-hero"

const ProblemSection = dynamic(() =>
  import("~/components/landing/problem").then((mod) => mod.ProblemSection)
)
const MechanismSection = dynamic(() =>
  import("~/components/landing/mechanism").then((mod) => mod.MechanismSection)
)
const CodeExample = dynamic(() => import("~/components/landing/code-example"))
const AdoptionSection = dynamic(() =>
  import("~/components/landing/adoption").then((mod) => mod.AdoptionSection)
)
const CapabilitiesSection = dynamic(() =>
  import("~/components/landing/capabilities").then((mod) => mod.CapabilitiesSection)
)
const IndependenceSection = dynamic(() =>
  import("~/components/landing/independence").then((mod) => mod.IndependenceSection)
)
const Cta = dynamic(() => import("~/components/landing/cta"))

export default function Home() {
  return (
    <LazyMotionWrapper>
      <main className="flex flex-col overflow-hidden">
        <Hero />
        <ProblemSection />
        <MechanismSection />
        <div className="w-full border-background-border border-t">
          <PricingHero
            headline="Watch paid work stop before it creates cost."
            description="Click a paid action against the plan. The model shows the allow/deny decision, remaining budget, and invoice evidence from the same money path."
            docsLinkText="Read the Docs"
          />
        </div>
        <CodeExample />
        <AdoptionSection />
        <CapabilitiesSection />
        <IndependenceSection />
        <Cta />
      </main>
    </LazyMotionWrapper>
  )
}
