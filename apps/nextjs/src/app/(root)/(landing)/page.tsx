import Cta from "~/components/landing/cta"
import { DemoSection } from "~/components/landing/demo"
import { FaqSection } from "~/components/landing/faq"
import Hero from "~/components/landing/hero"
import { LaunchPathSection } from "~/components/landing/launch-path"
import { MoneyPathSection } from "~/components/landing/money-path-section"
import { ProblemSection } from "~/components/landing/problem"

// Six moves, each advancing exactly one level: promise → incident →
// mechanism → proof → implementation → objections → offer.
//
// The page used to run eight stations and argue twice before proving once: a
// comparison matrix and an outcome grid sat between the incident and the
// money path, and the same four claims (own Stripe, shadow-first, one
// afternoon, invoice evidence) repeated instead of advancing. The comparison
// work moved into the FAQ, where "why not X" is answered as the question a
// reader actually asks; the outcome grid was restating the FAQ in prettier
// boxes. The floor divider went with them — it segmented one reader with two
// brains into two readers and gave the founder brain permission to stop
// exactly where the proof begins.
//
// Station 03 is the only one that is not our own drawing, which is why it
// exists: everything above it is authored by us, and money infrastructure has
// to be checkable by someone who does not trust us yet.
//
// Server components throughout — these sections are static, and the dynamic
// imports bought nothing but layout shift on the highest-traffic day of the
// year. The marketing layout already owns the `main` landmark, so this
// returns a plain wrapper. The interactive decision demo stays unplugged
// (components/landing/decision-demo/); it returns as its own page.

export default function Home() {
  return (
    <div className="flex flex-col overflow-hidden">
      <Hero />
      <ProblemSection />
      <MoneyPathSection />
      <DemoSection />
      <LaunchPathSection />
      <FaqSection />
      <Cta />
    </div>
  )
}
