import dynamic from "next/dynamic"
import { DecisionDemo } from "~/components/landing/decision-demo"
import Hero from "~/components/landing/hero"
import { LazyMotionWrapper } from "~/components/landing/lazy-motion-wrapper"

const ProblemSection = dynamic(() =>
  import("~/components/landing/problem").then((mod) => mod.ProblemSection)
)
const CodeExample = dynamic(() => import("~/components/landing/code-example"))
const AdoptionSection = dynamic(() =>
  import("~/components/landing/adoption").then((mod) => mod.AdoptionSection)
)
const Cta = dynamic(() => import("~/components/landing/cta"))

export default function Home() {
  return (
    <LazyMotionWrapper>
      <main className="flex flex-col overflow-hidden">
        <Hero />
        <ProblemSection />
        <DecisionDemo />
        <CodeExample />
        <AdoptionSection />
        <Cta />
      </main>
    </LazyMotionWrapper>
  )
}
