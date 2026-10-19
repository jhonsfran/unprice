import { DOCS_DOMAIN } from "@unprice/config"
import { siteConfig } from "~/constants/layout"
import { type FaqItem, FaqList } from "./faq"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The objections a builder raises before putting a cap in front of an agent,
// answered inside the claim boundaries: no latency figure, gateways described
// only by what every gateway cap does, the offer as the home page states it.
// Answers stay plain strings so the same array feeds the FAQPage JSON-LD.

const REPO_URL = siteConfig.links.github

const faqs: FaqItem[] = [
  {
    question: "Do I need Unprice billing?",
    answer:
      "No. A budget needs no plans, subscriptions, customers, or payment provider in Unprice. Keep the billing you have. Unprice billing is there when you want to sell plans, credits, and invoices.",
    link: { href: `${DOCS_DOMAIN}budgets/overview`, label: "Read the overview", external: true },
  },
  {
    question: "Doesn't my AI gateway already have a cap?",
    answer:
      "A gateway cap sits on the key it is configured for, usually your provider key, so one runaway agent can trip it for every customer. Some gateways also budget per customer. A budget caps any key you choose, in front of any paid call, model or tool, and reserves the maximum before the call runs.",
  },
  {
    question: "Can parallel calls overshoot the cap?",
    answer:
      "No. Each authorization reserves its maximum against every hard limit in one serialized step. In the test suite, 100 parallel $0.75 authorizations against a $50 cap admit 66 and refuse 34.",
    link: {
      href: `${REPO_URL}/blob/main/apps/api/src/ingestion/budget/BudgetDO.workers.test.ts`,
      label: "Read the test",
      external: true,
    },
  },
  {
    question: "Can my agent raise its own cap?",
    answer:
      "No. A runtime key can create a budget and tighten it. Raising or removing a cap needs a config key, which you keep out of the environment that spends.",
  },
  {
    question: "What happens if Unprice is unreachable?",
    answer:
      "A remote check denies new work and tells your code to retry. In local mode, the process keeps spending within its lease until the lease's deadline, then denies.",
  },
  {
    question: "Is it open source?",
    answer:
      "Yes. The SDK, @unprice/budgets, is MIT. The budget runtime is AGPL-3.0, in the same repository, and you can deploy it to your own Cloudflare account. On the hosted cloud, each budget is created near its first request, so its state may live outside the EU.",
    link: { href: REPO_URL, label: "Read the source", external: true },
  },
  {
    question: "What does it cost?",
    answer: "Nothing during early access, and there is no card at signup.",
  },
]

export function BudgetsFaq() {
  return (
    <SectionShell labelledBy="budgets-faq-title">
      <div className="flex flex-col items-start">
        <StationHeader index="05" label="The questions" fact="short answers" />
        <h2
          id="budgets-faq-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Asked before the first cap.
        </h2>
      </div>

      <FaqList items={faqs} />
    </SectionShell>
  )
}
