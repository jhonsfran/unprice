import { Badge } from "@unprice/ui/badge"
import { AlertTriangle, Clock3, Database, GitBranch } from "lucide-react"

const failureModes = [
  {
    Icon: Clock3,
    title: "The invoice is late",
    body: "The LLM call, data job, API request, or workflow already ran before billing can explain it.",
  },
  {
    Icon: Database,
    title: "The counter drifts",
    body: "Usage tables and Redis limits can disagree with credits, budgets, and real spend under load.",
  },
  {
    Icon: GitBranch,
    title: "Packaging touches code",
    body: "Plan changes spread across app branches, billing jobs, support rules, and reconciliation scripts.",
  },
]

const staticSignals = [
  "No request-path customer spend authorization.",
  "Credits, grants, and usage quantities mixed together.",
  "Invoice disputes reconstructed from logs by hand.",
  "Pricing experiments blocked by hardcoded plan logic.",
]

export function ProblemSection() {
  return (
    <section
      aria-labelledby="problem-title"
      className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_24rem]"
    >
      <div className="flex flex-col gap-6">
        <Badge variant="warning" className="w-fit">
          The status quo
        </Badge>
        <div className="flex flex-col gap-4">
          <h2
            id="problem-title"
            className="max-w-3xl font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl"
          >
            By invoice time, the paid work already ran.
          </h2>
          <p className="max-w-3xl text-background-text text-lg leading-8">
            A customer triggers the expensive action. Your counter notices later. Your invoice
            explains it weeks later. If the request should have been blocked, the cost is already
            real; if the customer disputes it, engineering turns into invoice support.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {failureModes.map((mode) => (
            <div
              key={mode.title}
              className="flex min-h-44 flex-col gap-4 rounded-lg border border-background-border bg-background-base p-4"
            >
              <span className="flex size-9 items-center justify-center rounded-md bg-warning-bg text-warning-text">
                <mode.Icon aria-hidden className="size-4" />
              </span>
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-background-textContrast">{mode.title}</h3>
                <p className="text-background-text text-sm leading-6">{mode.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <aside className="flex flex-col gap-5 rounded-lg border border-danger-border bg-danger-bg/20 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-danger-solid text-white">
            <AlertTriangle aria-hidden className="size-4" />
          </span>
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold text-background-textContrast text-xl">
              Your Redis counter is not a budget.
            </h3>
            <p className="text-background-text text-sm leading-6">
              A counter can say usage is high. It cannot prove which plan version applied, which
              credits were reserved, why a request was denied, and how accepted usage became an
              invoice line.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {staticSignals.map((signal) => (
            <div key={signal} className="flex items-start gap-3 text-sm">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-danger-solid" />
              <span className="text-background-text">{signal}</span>
            </div>
          ))}
        </div>
      </aside>
    </section>
  )
}
