import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The objection station. The marketing framework routes every campaign
// asset here instead of re-arguing — these are the questions the avatar
// asks, in roughly the order they ask them, each answered in claim-boundary
// language (no latency numbers until measured, Stripe-first today,
// "your own Cloudflare account" not "self-host"). Answers stay plain
// strings so the same array feeds the FAQPage JSON-LD below — the citable
// version of this section for search engines and LLMs.

const REPO_URL = "https://github.com/jhonsfran1165/unprice"

type FaqItem = {
  question: string
  answer: string
  link?: { href: string; label: string; external?: boolean }
}

const faqs: FaqItem[] = [
  {
    question: "Why not just Stripe?",
    answer:
      "Keep Stripe for payment capture. Unprice owns the customer money path before and around the invoice: plan versions, entitlements, budgets, credits, ledger captures, and evidence.",
    link: { href: "/manifesto", label: "The full argument" },
  },
  {
    question: "Is it Stripe-only?",
    answer:
      "Stripe today — your own account or Stripe Connect — plus the built-in Sandbox provider for proving the path without a processor. The provider layer is one interface: Stripe-first today, provider-extensible by design. No other provider is claimed until it ships.",
  },
  {
    question: "Does Unprice touch the money?",
    answer:
      "No. Your app asks Unprice before paid work runs and gets an allow or deny with evidence attached. Your payment provider captures the payment — Stripe today, in your own account. Unprice owns the decision, the ledger, and the evidence; it never sits in your funds flow.",
  },
  {
    question: "What does the check add to my request latency?",
    answer:
      "One authorization request. A warm check is a cached read plus one Durable Object read; invoicing, analytics, and the ledger ride queues off the request path — never inside it. Numbers depend on where your traffic runs, so the repo ships a k6 harness instead of a marketing claim: point it at your own deployment and read the percentiles.",
    link: {
      href: `${REPO_URL}/tree/main/tooling/k6`,
      label: "Run the benchmark",
      external: true,
    },
  },
  {
    question: "What happens if Unprice is down?",
    answer:
      "The check fails loud, never silent: you get an explicit error and your code owns the fallback — fail open and log, or fail closed for the expensive actions. Caches serve stale answers while they revalidate, and shadow mode blocks nothing by construction, so an outage during adoption costs you nothing.",
  },
  {
    question: "Why not an AI gateway?",
    answer:
      "Gateways cap provider spend. Unprice governs what your customer is allowed to spend and connects that decision to invoice evidence.",
  },
  {
    question: "Is it safe enough for money logic?",
    answer:
      "Do not adopt it all at once. Read the source, run one request path in shadow, prove it on Sandbox, then enforce only when the evidence matches.",
    link: { href: REPO_URL, label: "Read the source", external: true },
  },
  {
    question: "Do I need Cloudflare?",
    answer:
      "Today, yes. The runtime deploys to your own Cloudflare account — Workers, Durable Objects, Queues — because the spend decision needs fast per-customer state where requests run. Your account, your data, your keys.",
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

export function FaqSection() {
  return (
    <SectionShell labelledBy="faq-title">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="flex flex-col items-start">
        <StationHeader index="05" label="The questions" fact="short answers · receipts attached" />
        <h2
          id="faq-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Asked before you integrate.
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
