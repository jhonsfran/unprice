import type { Metadata } from "next"
import { BudgetsChecks } from "~/components/landing/budgets-checks"
import { BudgetsCta } from "~/components/landing/budgets-cta"
import { BudgetsFaq } from "~/components/landing/budgets-faq"
import { BudgetsHero } from "~/components/landing/budgets-hero"
import { BudgetsIntegration } from "~/components/landing/budgets-integration"
import { BudgetsPerKey } from "~/components/landing/budgets-per-key"
import { BudgetsProblem } from "~/components/landing/budgets-problem"

// Unprice Budgets has its own page because launch traffic arrives with the
// video's promise (hard caps, per key, nothing to migrate), and the home page
// sells the whole billing path. Same arc as the home page: promise (beside the
// video that made it), incident, objection, integration, proof, questions, offer.

const title = "Unprice Budgets"
const description =
  "Hard spending caps for AI agents, on any key you choose. Checked before the call, with nothing to migrate."

const ogImage = `/og?title=${encodeURIComponent("Unprice Budgets")}&description=${encodeURIComponent(
  "Hard caps. Per key. Actually hard. Put a budget in front of your agent."
)}`

export const metadata: Metadata = {
  title: "Budgets",
  description,
  openGraph: {
    type: "website",
    url: "https://unprice.dev/budgets",
    title,
    description,
    images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
  },
  alternates: {
    canonical: "https://unprice.dev/budgets",
  },
}

export default function Budgets() {
  return (
    <div className="flex flex-col overflow-hidden">
      <BudgetsHero />
      <BudgetsProblem />
      <BudgetsPerKey />
      <BudgetsIntegration />
      <BudgetsChecks />
      <BudgetsFaq />
      <BudgetsCta />
    </div>
  )
}
