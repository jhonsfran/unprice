import dynamic from "next/dynamic"
import Hero from "~/components/landing/hero"
import { LazyMotionWrapper } from "~/components/landing/lazy-motion-wrapper"
import { PricingHero } from "~/components/landing/pricing-hero"

const Features = dynamic(() => import("~/components/landing/features").then((mod) => mod.Features))
const FeaturesApp = dynamic(() =>
  import("~/components/landing/features-app").then((mod) => mod.FeaturesApp)
)
const Global = dynamic(() => import("~/components/landing/global").then((mod) => mod.Global))
const LogoCloud = dynamic(() => import("~/components/landing/logo-cloud"))
const PriceOpsSection = dynamic(() => import("~/components/landing/ami"))
const CodeExample = dynamic(() => import("~/components/landing/code-example"))
const Cta = dynamic(() => import("~/components/landing/cta"))

export default function Home() {
  return (
    <LazyMotionWrapper>
      <main className="flex flex-col overflow-hidden">
        <Hero />
        <PricingHero
          headline="Test out unprice now."
          description="Notice how 1,000,000 events transform into one perfect invoice. Experience the clarity of the metering engine below."
          docsLinkText="Read the Docs"
        />
        <PriceOpsSection />
        {/* <Testimonials /> */}
        <Features />
        <FeaturesApp />
        <Global />
        <CodeExample />
        <LogoCloud />
        <Cta />
      </main>
    </LazyMotionWrapper>
  )
}
