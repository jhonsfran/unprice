import { cn } from "@unprice/ui/utils"
import {
  ArrowRight,
  Ban,
  Check,
  CircleDollarSign,
  FileText,
  Gauge,
  type LucideIcon,
  ShieldCheck,
  Wallet,
  Zap,
} from "lucide-react"
import { Fragment } from "react"

// The signature visual: the money path. request -> meter -> entitlement -> budget
// -> wallet -> invoice, with the budget allow/deny decision as the hero moment.
// Static and token-driven by design (see docs/brand/design-system-guidelines.md):
// the brand's distinctiveness is legibility of real state, not decoration.
type PathNode = {
  label: string
  fact: string
  Icon: LucideIcon
  accent: string
  hero?: boolean
}

const nodes: PathNode[] = [
  {
    label: "Request",
    fact: "POST /run",
    Icon: Zap,
    accent: "bg-info text-info-foreground",
  },
  {
    label: "Meter",
    fact: "events.report",
    Icon: Gauge,
    accent: "bg-background-bgHover text-background-textContrast",
  },
  {
    label: "Entitlement",
    fact: "access.check",
    Icon: ShieldCheck,
    accent: "bg-background-bgHover text-background-textContrast",
  },
  {
    label: "Budget",
    fact: "remaining $4.10",
    Icon: CircleDollarSign,
    accent: "bg-primary text-primary-foreground",
    hero: true,
  },
  {
    label: "Wallet",
    fact: "credits −1",
    Icon: Wallet,
    accent: "bg-background-bgHover text-background-textContrast",
  },
  {
    label: "Invoice",
    fact: "explained",
    Icon: FileText,
    accent: "bg-success-solid text-white",
  },
]

export function MoneyPath({ className }: { className?: string }) {
  return (
    <figure
      aria-label="The money path. A request is metered, checked against entitlement and budget, settled against wallet credits, and explained on the invoice. The budget decision allows or denies the request in the request path, before any cost is created."
      className={cn("w-full", className)}
    >
      <figcaption className="mb-4 font-mono text-background-text text-xs uppercase tracking-widest">
        The money path
      </figcaption>

      {/* The path */}
      <div className="flex flex-col md:flex-row md:items-center">
        {nodes.map((node, i) => (
          <Fragment key={node.label}>
            <div
              className={cn(
                "flex items-center gap-3 rounded-md border border-background-border bg-background-base p-3 md:flex-1",
                node.hero && "border-primary-border ring-1 ring-primary/40"
              )}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md",
                  node.accent
                )}
              >
                <node.Icon aria-hidden className="size-4" />
              </span>
              <span className="flex flex-col">
                <span className="font-medium text-background-textContrast text-sm">
                  {node.label}
                </span>
                <span className="font-mono text-[11px] text-background-text">{node.fact}</span>
              </span>
            </div>
            {i < nodes.length - 1 && (
              <ArrowRight
                aria-hidden
                className="mx-auto my-1 size-4 shrink-0 rotate-90 text-background-solid md:mx-1 md:my-0 md:rotate-0"
              />
            )}
          </Fragment>
        ))}
      </div>

      {/* The hero moment: the budget decision */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-3 rounded-md border border-success-border bg-success-bg/40 p-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-success-solid text-white">
            <Check aria-hidden className="size-4" />
          </span>
          <div>
            <p className="font-medium text-background-textContrast text-sm">
              allow · within budget
            </p>
            <p className="font-mono text-[11px] text-background-text">200 — the run continues</p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-md border border-danger-border bg-danger-bg/40 p-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-danger-solid text-white">
            <Ban aria-hidden className="size-4" />
          </span>
          <div>
            <p className="font-medium text-background-textContrast text-sm">deny · over budget</p>
            <p className="font-mono text-[11px] text-background-text">
              429 — rejected before any cost
            </p>
          </div>
        </div>
      </div>

      <p className="mt-4 text-background-text text-sm leading-6">
        The budget decision runs in the request path. Over-budget work is rejected before it
        executes, and the same trail explains every invoice line later.
      </p>
    </figure>
  )
}
