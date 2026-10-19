import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { siteConfig } from "~/constants/layout"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The objection station. The marketing framework routes every campaign
// asset here instead of re-arguing — these are the questions the avatar
// asks, in roughly the order they ask them, each answered in claim-boundary
// language (no latency numbers until measured, Stripe-first today,
// "your own Cloudflare account" not "self-host"). Answers stay plain
// strings so the same array feeds the FAQPage JSON-LD below — the citable
// version of this section for search engines and LLMs.
//
// Eight, not ten. "Do I need Cloudflare?" and "Where does my data live?"
// were one question about where this runs, and "is it safe enough for money
// logic?" was answered three times over by station 03, the Redis link, and
// the Sandbox block in the close. A long FAQ reads as a long list of doubts.

const REPO_URL = siteConfig.links.github

export type FaqItem = {
  question: string
  answer: string
  link?: { href: string; label: string; external?: boolean }
}

const faqs: FaqItem[] = [
  {
    question: "Why not just Stripe?",
    answer:
      "Keep Stripe. It charges after the work runs, so it can't stop the work. Unprice checks the spend before the work runs.",
    link: { href: "/manifesto", label: "The full argument" },
  },
  {
    // The distinction that releases the wrong buyer early. Arriving from
    // "control AI spend", a reader recognises every artifact on this page
    // before learning it solves the other direction.
    question: "Why not an AI gateway?",
    answer:
      "A gateway caps your total provider bill. Unprice caps each customer's budget before the call reaches the gateway. Some products use both.",
  },
  {
    // The real incumbent is not a competitor, it is the counter the reader
    // already wrote (positioning-and-messaging.md).
    //
    // The old answer claimed a Redis reservation races under concurrency.
    // That is false and trivially falsifiable — a Lua script is atomic — and
    // an engineer who has written one discards the whole page over it. Concede
    // the part Redis genuinely does well, then name the part that actually
    // costs a quarter to build.
    question: "Why not Redis?",
    answer:
      "You can build the hold in Redis in about fifty lines. The hard part is the record behind each charge: the plan version, the rate, the ledger entry, and the invoice line. Unprice keeps that record for every charge.",
    link: { href: REPO_URL, label: "Read the source", external: true },
  },
  {
    // Merged from "Do I need Cloudflare?" and "Where does my data live?".
    // Both were really one question — where does this thing run — and the
    // Cloudflare one used to read as a hard infrastructure gate on the hosted
    // product, which cost a signup from a reader on AWS.
    question: "Where does this run?",
    answer:
      "On the hosted cloud there is nothing to deploy, and billing state stays in Cloudflare's EU jurisdiction. Budget state is the exception and can live outside the EU. You can also run Unprice in your own Cloudflare account.",
  },
  {
    question: "Does Unprice hold the money?",
    answer:
      "No. Payments go through your own Stripe account. Unprice records the decision, the ledger entry, and the invoice line.",
  },
  {
    question: "What does a deny look like to my user?",
    answer:
      "Whatever you choose. A deny returns 200 with allowed set to false and a reason such as LIMIT_EXCEEDED, so your app can offer an upgrade.",
  },
  {
    question: "How much latency does the check add?",
    answer:
      "One request, before a provider call that costs far more. Ledger and invoice work run afterward. Run the k6 benchmark against your deployment to see real numbers.",
    link: {
      href: `${REPO_URL}/tree/main/tooling/k6`,
      label: "Run the benchmark",
      external: true,
    },
  },
  {
    question: "What if Unprice is down?",
    answer: "Your code decides. Fail open and log it, or fail closed for expensive actions.",
  },
]

/**
 * The answers as a definition list, plus the same items as FAQPage JSON-LD: the citable version
 * of the section for search engines and LLMs.
 */
export function FaqList({ items }: { items: FaqItem[] }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  }

  return (
    <>
      {/* JSON.stringify does not HTML-escape, so a `<` in any answer would
          break out of the script element. The answers are authored here, not
          user input, but escaping is free and keeps the rule honest. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
      <dl className="mt-12 grid gap-x-8 border-background-border border-t md:grid-cols-2">
        {items.map((item) => (
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
    </>
  )
}

export function FaqSection() {
  return (
    <SectionShell labelledBy="faq-title" surface="panel">
      <div className="flex flex-col items-start">
        <StationHeader index="05" label="The questions" fact="short answers · links to check" />
        <h2
          id="faq-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Questions before you integrate.
        </h2>
        {/* Qualification, stated plainly. Telling the wrong reader to leave is
            the cheapest credibility a launch with no customers can buy, and
            the disqualifier is canon (landing-page-grand-slam-offer.md). Both
            wrong buyers get named, and each gets sent somewhere real: the
            seat-based one to Stripe Billing, the provider-cost one to a
            gateway. The second was missing, so that reader read the whole page
            before finding out. */}
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Unprice is for products where one customer request can trigger paid AI work. If you only
          charge per seat, use Stripe Billing. If you want one cap on your whole provider bill, use
          an AI gateway.
        </p>
        {/* Hosting moved into "Where does this run?" — stating it twice in
            one viewport is the padding that made this section feel long. */}
        <p className="mt-4 font-mono text-[11px] text-background-text leading-5">
          payments through Stripe today · no tax, accounting, or revenue recognition
        </p>
      </div>

      <FaqList items={faqs} />
    </SectionShell>
  )
}
