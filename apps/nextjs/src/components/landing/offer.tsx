import { APP_DOMAIN, DOCS_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
import { buttonVariants } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { ArrowRight, Check, ClipboardCheck, Code2, FlaskConical, Route } from "lucide-react"
import Link from "next/link"

const steps = [
  {
    Icon: ClipboardCheck,
    title: "Name one paid action",
    body: "Pick the workflow, API call, data job, or package action that can burn credits or create invoice questions.",
  },
  {
    Icon: Route,
    title: "Define the money path",
    body: "Create the plan version, feature, meter, entitlement, budget, wallet, and invoice evidence you expect.",
  },
  {
    Icon: Code2,
    title: "Run it in shadow",
    body: "Call `access.check` beside your current logic. It mutates nothing, so production behavior stays unchanged.",
  },
  {
    Icon: FlaskConical,
    title: "Prove it on Sandbox",
    body: "Simulate the customer, budget, credits, and invoice explanation before a real processor or dollar moves.",
  },
]

const valueStack = [
  "One `signUp` call provisions customer, subscription, entitlements, wallet, and billing period.",
  "`usage.consume` denies over-limit usage while the request is still in flight.",
  "`runs.*` reserves a budget envelope before multi-step workloads can overspend.",
  "Invoice evidence traces back to plan version, pricing rule, wallet movement, and ledger capture.",
  "Open-source core lets you read the money-path logic before you trust it.",
]

export function OfferSection() {
  return (
    <section aria-labelledby="offer-title" className="mx-auto w-full max-w-6xl px-6 py-16">
      <div className="grid gap-10 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Badge variant="primary" className="w-fit">
            The offer
          </Badge>
          <div className="flex flex-col gap-4">
            <h2
              id="offer-title"
              className="font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl"
            >
              Start with one paid action in one afternoon.
            </h2>
            <p className="text-background-text text-lg leading-8">
              This is not a billing migration. It is a fit check on the one request path that can
              hurt margin or confuse an invoice.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
            <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
              Start with one paid action
              <ArrowRight data-icon="inline-end" />
            </Link>
            <Link
              href={`${DOCS_DOMAIN}`}
              target="_blank"
              className={buttonVariants({ variant: "outline" })}
            >
              Explore the SDK
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {steps.map((step, index) => (
              <article
                key={step.title}
                className="flex min-h-52 flex-col gap-5 rounded-lg border border-background-border bg-background-base p-5"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="flex size-9 items-center justify-center rounded-md bg-primary-bg text-primary-text">
                    <step.Icon aria-hidden className="size-4" />
                  </span>
                  <span className="font-mono text-background-text text-xs">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="font-semibold text-background-textContrast">{step.title}</h3>
                  <p className="text-background-text text-sm leading-6">{step.body}</p>
                </div>
              </article>
            ))}
          </div>

          <div className="rounded-lg border border-background-border bg-background-bgSubtle p-5">
            <h3 className="font-semibold text-background-textContrast text-xl">
              What becomes easier to trust
            </h3>
            <div className="mt-5 grid gap-3">
              {valueStack.map((item) => (
                <div key={item} className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                      "bg-success-bg text-success-text"
                    )}
                  >
                    <Check aria-hidden className="size-3" />
                  </span>
                  <p className="text-background-text text-sm leading-6">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
