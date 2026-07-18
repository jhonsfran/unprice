import dynamic from "next/dynamic"
import { FloorDivider } from "~/components/landing/floor-divider"
import Hero from "~/components/landing/hero"

// The page is two floors for the two brains of the same buyer
// (marketing-framework.md): the business floor above the divider sells in
// money language — pain first (the status quo gives the reader tension
// before release, 2026-07-18 critique), then the thesis (why), then the
// outcomes (gains). The proof floor below shows the receipts in the
// engineer's language (the full money path answering station 01's broken
// trace, code, adoption, questions) on alternating band surfaces so the
// register change is visible. The hero's compact demo anchors to
// #money-path here. The interactive decision demo is unplugged for now — it
// will return as its own page (components/landing/decision-demo/ stays).

const UspSection = dynamic(() => import("~/components/landing/usp").then((mod) => mod.UspSection))
const GainsSection = dynamic(() =>
  import("~/components/landing/gains").then((mod) => mod.GainsSection)
)
const ProblemSection = dynamic(() =>
  import("~/components/landing/problem").then((mod) => mod.ProblemSection)
)
const MoneyPathSection = dynamic(() =>
  import("~/components/landing/money-path-section").then((mod) => mod.MoneyPathSection)
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
      <UspSection />
      <GainsSection />
      <FloorDivider />
      <MoneyPathSection />
      <CodeExample />
      <AdoptionSection />
      <FaqSection />
      <Cta />
    </main>
  )
}
