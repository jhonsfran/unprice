import dynamic from "next/dynamic"
import { DecisionDemo } from "~/components/landing/decision-demo"
import Hero from "~/components/landing/hero"

const ProblemSection = dynamic(() =>
  import("~/components/landing/problem").then((mod) => mod.ProblemSection)
)
const CodeExample = dynamic(() => import("~/components/landing/code-example"))
const AdoptionSection = dynamic(() =>
  import("~/components/landing/adoption").then((mod) => mod.AdoptionSection)
)
const FaqSection = dynamic(() => import("~/components/landing/faq").then((mod) => mod.FaqSection))
const Cta = dynamic(() => import("~/components/landing/cta"))

export default function Home() {
  return (
    <main className="flex flex-col overflow-hidden">
      <Hero />
      <ProblemSection />
      <DecisionDemo />
      <CodeExample />
      <AdoptionSection />
      <FaqSection />
      <Cta />
    </main>
  )
}
