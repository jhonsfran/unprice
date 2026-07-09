import dynamic from "next/dynamic"
import { DecisionDemo } from "~/components/landing/decision-demo"
import Hero from "~/components/landing/hero"
import { LazyMotionWrapper } from "~/components/landing/lazy-motion-wrapper"

const ProblemSection = dynamic(() =>
  import("~/components/landing/problem").then((mod) => mod.ProblemSection)
)
const SystemMap = dynamic(() =>
  import("~/components/landing/system-map").then((mod) => mod.SystemMap)
)
const CodeExample = dynamic(() => import("~/components/landing/code-example"))
const AdoptionSection = dynamic(() =>
  import("~/components/landing/adoption").then((mod) => mod.AdoptionSection)
)
// const OfferSection = dynamic(() =>
//     import("~/components/landing/offer").then((mod) => mod.OfferSection)
//   )
const Cta = dynamic(() => import("~/components/landing/cta"))

export default function Home() {
  return (
    <LazyMotionWrapper>
      <main className="flex flex-col overflow-hidden">
        <Hero />
        <ProblemSection />
        <SystemMap />
        <DecisionDemo />
        <CodeExample />
        <AdoptionSection />
        {/* <OfferSection /> */}
        <Cta />
      </main>
    </LazyMotionWrapper>
  )
}
