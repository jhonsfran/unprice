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
//
// Eight, not ten. "Do I need Cloudflare?" and "Where does my data live?"
// were one question about where this runs, and "is it safe enough for money
// logic?" was answered three times over by station 03, the Redis link, and
// the Sandbox block in the close. A long FAQ reads as a long list of doubts.

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
      "Stripe captures payment after the work is done, so it cannot stop the work. Keep it. Unprice runs earlier: it authorizes the spend before the provider call, then hands Stripe an invoice line that can be explained.",
    link: { href: "/manifesto", label: "The full argument" },
  },
  {
    // The distinction that releases the wrong buyer early. Arriving from
    // "control AI spend", a reader recognises every artifact on this page
    // before learning it solves the other direction.
    question: "Why not an AI gateway?",
    answer:
      "A gateway sits inside the provider call and caps your total provider bill. Unprice sits before it and authorizes one run against one customer's budget. A denied run never reaches the gateway. Some products want both.",
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
      "You can build the reservation in Redis. A Lua script that holds an amount and releases the remainder is about fifty lines, and it will be correct. The reservation was never the hard part. The trail is: which plan version was in force, what rate applied, which grant the hold came from, how the settled amount became a ledger entry that balances, and which invoice line it landed on. That is what gets rebuilt by hand every time support asks why a customer was charged. Unprice keeps it on one path, with the reservation attached.",
    link: { href: REPO_URL, label: "Read the source", external: true },
  },
  {
    // Merged from "Do I need Cloudflare?" and "Where does my data live?".
    // Both were really one question — where does this thing run — and the
    // Cloudflare one used to read as a hard infrastructure gate on the hosted
    // product, which cost a signup from a reader on AWS.
    question: "Where does this run?",
    answer:
      "On the hosted cloud: install the SDK, call the API, nothing to deploy. It runs in EU regions, and per-customer state — wallet reservations, run budgets, idempotency keys — is pinned to Cloudflare's EU jurisdiction, so it is never placed outside it. To run Unprice yourself, deploy the open-source runtime to your own Cloudflare account, and your data lives wherever you put it. Either way, payments settle in your own Stripe account.",
  },
  {
    question: "Does Unprice hold the money?",
    answer:
      "No. Your app asks before paid work runs and gets an allow or deny with evidence. Stripe captures payment in your own account or through Stripe Connect, and the built-in Sandbox provider lets you test the path without a processor. Unprice records the decision, the ledger movement, and the receipt. The money never touches Unprice.",
  },
  {
    question: "What does a deny look like to my user?",
    answer:
      "Whatever you decide to show. A deny is a business result, not an outage: the call returns 200 with allowed set to false and a machine-readable reason such as LIMIT_EXCEEDED. Your app can explain the limit and offer an upgrade.",
  },
  {
    question: "How much latency does the check add?",
    answer:
      "One request, ahead of a provider call that costs orders of magnitude more. A warm check is a cached read plus one Durable Object read. Invoicing, analytics, and ledger work run off the request path. Latency depends on where your traffic runs, so the repo ships a k6 harness — point it at your deployment and read the percentiles.",
    link: {
      href: `${REPO_URL}/tree/main/tooling/k6`,
      label: "Run the benchmark",
      external: true,
    },
  },
  {
    question: "What if Unprice is down?",
    answer:
      "The check returns an explicit error and your code picks the fallback: fail open and log it, or fail closed for expensive actions. Caches can serve stale answers while they revalidate, and shadow mode blocks nothing during adoption.",
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
        {/* Hosting moved into "Where does this run?" — stating it twice in
            one viewport is the padding that made this section feel long. */}
        <p className="mt-4 font-mono text-[11px] text-background-text leading-5">
          Stripe today · not tax, accounting, or revenue recognition
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
