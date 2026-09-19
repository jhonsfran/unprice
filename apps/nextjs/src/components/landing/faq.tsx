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
      "Stripe captures payment after the work is done, so it cannot stop the work. Keep it. Unprice sits earlier: it authorizes the spend before the provider call, then hands Stripe an invoice line that can be explained. It connects plan versions, entitlements, budgets, wallet credits, ledger captures, and the receipt.",
    link: { href: "/manifesto", label: "The full argument" },
  },
  {
    // Moved to the top three (2026-07-27): this was the last of ten questions,
    // and the previous answer — "Today, yes" — read as a hard infrastructure
    // gate on the hosted product too. A reader on AWS closed the tab over a
    // requirement that does not apply to them.
    question: "Do I need Cloudflare?",
    answer:
      "Not to use the hosted cloud. Install the SDK and call the API. You have nothing to deploy. To run Unprice yourself, deploy the open-source runtime to your Cloudflare account. It uses Workers, Durable Objects, and Queues to keep per-customer state near the request path. In both cases, payments settle to your own Stripe account.",
  },
  {
    // Residency is a gating question for the EU half of the avatar, and it
    // was unanswerable on this page — the reader had to email to find out.
    // Stated as placement, not as a certification we do not hold.
    question: "Where does my data live?",
    answer:
      "In the EU. The hosted runtime, the Postgres database, and the usage analytics run in EU regions. Per-customer Durable Object state — wallet reservations, run budgets, idempotency keys — is pinned to Cloudflare's EU jurisdiction, so it is never placed or migrated outside it. If you run Unprice yourself, your data lives wherever you deploy it. Either way, payments settle in your own Stripe account.",
  },
  {
    // Second, not seventh: this is the distinction that releases the wrong
    // buyer. Arriving from "control AI spend", a reader recognises every
    // artifact on this page before learning it solves the other direction.
    question: "Why not an AI gateway?",
    answer:
      "A gateway sits inside the provider call and caps your aggregate provider bill. Unprice sits before it and authorizes one run against one customer's budget, then ties that decision to plan versions, wallet credits, and the invoice line. A denied run never reaches the gateway. Use a gateway for your provider bill, Unprice for your customer's budget. Some products want both.",
  },
  {
    // The real incumbent is not a competitor, it is the counter the reader
    // already wrote (positioning-and-messaging.md). Answering the branded
    // alternatives while ducking this one reads as evasion.
    question: "Why not a Redis counter?",
    answer:
      "For a single limit it is genuinely fine. It stops being fine when the counter has to agree with money: under concurrency a race lets over-budget work reach the provider, and the counter can tell you usage was high but not which budget was checked, what was reserved, why a request was denied, or how accepted usage became an invoice line. Unprice keeps the authorization, the reservation, and the explanation on one path.",
  },
  {
    question: "Does Unprice touch the money?",
    answer:
      "No. Your app asks Unprice before paid work runs and receives an allow or deny with evidence. Stripe captures production payments in your account or through Stripe Connect. The built-in Sandbox provider lets you test the path without a payment processor. Unprice records the decision, the ledger movement, and the receipt. The money never touches Unprice.",
  },
  {
    question: "What does my customer see when a request is denied?",
    answer:
      "Whatever your app decides to show. A denial is a business result, not an outage or HTTP error. The call returns 200 with allowed set to false and a machine-readable reason such as LIMIT_EXCEEDED, plan expired, or no entitlement. Your app can explain the limit and offer an upgrade. Unprice records the denial and its evidence.",
  },
  {
    question: "What does the check add to my request latency?",
    answer:
      "One authorization request, ahead of a provider call that costs orders of magnitude more. A warm check uses a cached read and one Durable Object read. Invoicing, analytics, and ledger work run outside the request path. Latency depends on where your traffic runs, so the repo includes a k6 harness. Point it at your deployment and read the percentiles.",
    link: {
      href: `${REPO_URL}/tree/main/tooling/k6`,
      label: "Run the benchmark",
      external: true,
    },
  },
  {
    question: "What happens if Unprice is down?",
    answer:
      "The check returns an explicit error. Your code controls the fallback. You can fail open and log the error, or fail closed for expensive actions. Caches can serve stale answers while they revalidate. Shadow mode blocks nothing, so it does not stop work during adoption.",
  },
  {
    question: "Is it safe enough for money logic?",
    answer:
      "Do not adopt it all at once. Read the source, run one request path in shadow, prove it on Sandbox, then enforce only when the evidence matches.",
    link: { href: REPO_URL, label: "Read the source", external: true },
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
    <SectionShell labelledBy="faq-title" surface="panel">
      {/* JSON.stringify does not HTML-escape, so a `<` in any answer would
          break out of the script element. The answers are authored here, not
          user input, but escaping is free and keeps the rule honest. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c"),
        }}
      />
      <div className="flex flex-col items-start">
        <StationHeader index="05" label="The questions" fact="short answers · receipts attached" />
        <h2
          id="faq-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Asked before you integrate.
        </h2>
        {/* Qualification, stated plainly. Telling the wrong reader to leave is
            the cheapest credibility a launch with no customers can buy, and
            the disqualifier is canon (landing-page-grand-slam-offer.md). Both
            wrong buyers get named, and each gets sent somewhere real: the
            seat-based one to Stripe Billing, the provider-cost one to a
            gateway. The second was missing, so that reader read the whole page
            before finding out. */}
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Unprice is for products where one customer request can start an agent run or paid workflow
          that spends real money before anyone checks. If your product only charges per seat, Stripe
          Billing is enough. If you want one aggregate cap on your model-provider bill rather than a
          budget per customer, use an AI gateway.
        </p>
        <p className="mt-4 font-mono text-[11px] text-background-text leading-5">
          Stripe today · EU-hosted or your own Cloudflare account · not tax, accounting, or revenue
          recognition
        </p>
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
