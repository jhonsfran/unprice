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
    answer: "No. Budgets work with the billing you already have.",
    link: { href: `${DOCS_DOMAIN}budgets/overview`, label: "Read the overview", external: true },
  },
  {
    question: "Doesn't my AI gateway already have a cap?",
    answer:
      "A gateway cap usually covers your whole provider key, so one runaway agent blocks every customer. A budget caps any key you choose, before the call runs.",
  },
  {
    question: "What is the estimate?",
    answer:
      "The most the call can cost, computed by your code. Unprice reserves it, runs the call, then settles the actual cost. If the cap cannot cover the estimate, the call never runs.",
    link: { href: `${DOCS_DOMAIN}budgets/spend`, label: "Read about spend", external: true },
  },
  {
    question: "Can parallel calls overshoot the cap?",
    answer:
      "No. In the test suite, 100 parallel $0.75 calls against a $50 cap admit 66 and refuse 34.",
    link: {
      href: `${REPO_URL}/blob/main/apps/api/src/ingestion/budget/BudgetDO.workers.test.ts`,
      label: "Read the test",
      external: true,
    },
  },
  {
    question: "Can my agent raise its own cap?",
    answer: "No. Raising a cap needs a config key. Keep that key away from the agent.",
  },
  {
    question: "What happens if Unprice is unreachable?",
    answer:
      "Remote checks deny new work. In local mode, the process keeps spending its lease until the lease expires.",
  },
  {
    question: "Is it open source?",
    answer:
      "Yes. The SDK is MIT and the runtime is AGPL-3.0, and you can run it in your own Cloudflare account. On the hosted cloud, budget state may live outside the EU.",
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
          Questions before your first cap.
        </h2>
      </div>

      <FaqList items={faqs} />
    </SectionShell>
  )
}
