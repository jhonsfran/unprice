import { DOCS_DOMAIN } from "@unprice/config"
import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The objections a builder raises before putting a cap in front of an agent,
// answered inside the claim boundaries: no latency figure, gateways described
// only by what every gateway cap does, the offer as the home page states it.
// Answers stay plain strings so the same array feeds the FAQPage JSON-LD.

const REPO_URL = "https://github.com/jhonsfran1165/unprice"

type FaqItem = {
  question: string
  answer: string
  link?: { href: string; label: string; external?: boolean }
}

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

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer,
    },
  })),
}

export function BudgetsFaq() {
  return (
    <SectionShell labelledBy="budgets-faq-title">
      {/* JSON.stringify does not HTML-escape; escape `<` so no answer can
          close the script element. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c"),
        }}
      />
      <div className="flex flex-col items-start">
        <StationHeader index="05" label="The questions" fact="short answers" />
        <h2
          id="budgets-faq-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Asked before the first cap.
        </h2>
      </div>

      <dl className="mt-12 grid gap-x-8 border-background-border border-t md:grid-cols-2">
        {faqs.map((item) => (
          <div key={item.question} className="border-background-border border-b py-6">
            <dt className="font-medium text-background-textContrast text-sm">{item.question}</dt>
            <dd className="mt-2 text-background-text text-sm leading-6">
              {item.answer}
              {item.link ? (
                <>
                  {" "}
                  <a
                    href={item.link.href}
                    {...(item.link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                    className={cn(
                      "group inline-flex items-baseline gap-1 rounded-sm font-medium text-background-textContrast underline decoration-background-borderHover underline-offset-4 hover:decoration-background-textContrast",
                      focusRing
                    )}
                  >
                    {item.link.label}
                    <ArrowRight
                      aria-hidden
                      className="size-3 self-center transition-transform duration-quick ease-out-quad group-hover:translate-x-0.5"
                    />
                  </a>
                </>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </SectionShell>
  )
}
