import { Badge } from "@unprice/ui/badge"
import { CheckCircle2, FileSearch, GitFork, LockKeyhole, ShieldCheck, Wallet } from "lucide-react"

const trustLayers = [
  {
    Icon: FileSearch,
    title: "Read the money path",
    body: "The core is AGPL-3.0 open source. Inspect the logic that allows, denies, reserves, captures, and explains usage.",
  },
  {
    Icon: ShieldCheck,
    title: "Shadow before enforcement",
    body: "`access.check` is read-only, so you can compare Unprice decisions beside the logic you already run.",
  },
  {
    Icon: LockKeyhole,
    title: "Sandbox before processor",
    body: "Model customers, plan versions, budgets, credits, invoices, and failures before a real dollar moves.",
  },
  {
    Icon: Wallet,
    title: "Your money stays in your account",
    body: "Go live with your own Stripe account. Unprice never sits between you and your revenue.",
  },
  {
    Icon: GitFork,
    title: "Forkable by design",
    body: "If the layer guards margin, the layer should be inspectable, self-hostable, and portable.",
  },
  {
    Icon: CheckCircle2,
    title: "Honest fit check",
    body: "If your product is pure seat-based SaaS, Stripe Billing may be enough. Unprice is for paid actions that need authorization and evidence.",
  },
]

const objections = [
  {
    question: "Why not just Stripe?",
    answer:
      "Keep Stripe for payment capture. Unprice owns the customer money path before and around the invoice: plan versions, entitlements, budgets, credits, ledger captures, and evidence.",
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
  },
]

export function TrustSection() {
  return (
    <section aria-labelledby="trust-title" className="mx-auto w-full max-w-6xl px-6 py-16">
      <div className="flex flex-col gap-10">
        <div className="flex max-w-3xl flex-col gap-5">
          <Badge variant="success" className="w-fit">
            Trust by sequence
          </Badge>
          <div className="flex flex-col gap-4">
            <h2
              id="trust-title"
              className="font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl"
            >
              No leap of faith on the request path.
            </h2>
            <p className="text-background-text text-lg leading-8">
              The trust strategy is not louder claims. It is sequencing: inspect, shadow, simulate,
              then enforce. Each step should remove one reason to hesitate.
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {trustLayers.map((layer) => (
            <article
              key={layer.title}
              className="flex min-h-48 flex-col gap-4 rounded-lg border border-background-border bg-background-base p-5"
            >
              <span className="flex size-9 items-center justify-center rounded-md bg-success-bg text-success-text">
                <layer.Icon aria-hidden className="size-4" />
              </span>
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-background-textContrast">{layer.title}</h3>
                <p className="text-background-text text-sm leading-6">{layer.body}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {objections.map((item) => (
            <div
              key={item.question}
              className="rounded-lg border border-background-border bg-background-bgSubtle p-5"
            >
              <h3 className="font-semibold text-background-textContrast">{item.question}</h3>
              <p className="mt-3 text-background-text text-sm leading-6">{item.answer}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
