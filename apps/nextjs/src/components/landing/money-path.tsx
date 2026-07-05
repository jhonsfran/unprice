import { cn } from "@unprice/ui/utils"
import {
  Ban,
  Check,
  CircleDollarSign,
  FileText,
  Gauge,
  type LucideIcon,
  ReceiptText,
  ShieldCheck,
  Wallet,
  Zap,
} from "lucide-react"

// The signature visual: the money path. Keep this literal and stateful; the brand
// works when the buyer can see the commercial decision and the evidence trail.
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
    fact: "POST /workflow",
    Icon: Zap,
    accent: "bg-info text-info-foreground",
  },
  {
    label: "Plan version",
    fact: "pro@v3",
    Icon: ReceiptText,
    accent: "bg-background-bgHover text-background-textContrast",
  },
  {
    label: "Pricing rule",
    fact: "$0.002/token",
    Icon: FileText,
    accent: "bg-background-bgHover text-background-textContrast",
  },
  {
    label: "Meter",
    fact: "tokens_used",
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
    fact: "reserve -1 credit",
    Icon: Wallet,
    accent: "bg-background-bgHover text-background-textContrast",
  },
  {
    label: "Ledger",
    fact: "capture balanced",
    Icon: ReceiptText,
    accent: "bg-background-bgHover text-background-textContrast",
  },
  {
    label: "Invoice",
    fact: "line explained",
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

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-9">
        {nodes.map((node, index) => (
          <div
            key={node.label}
            className={cn(
              "relative flex min-h-24 flex-col gap-3 rounded-md border border-background-border bg-background-base p-3",
              node.hero && "border-primary-border ring-1 ring-primary/40"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md",
                  node.accent
                )}
              >
                <node.Icon aria-hidden className="size-4" />
              </span>
              <span className="font-mono text-[10px] text-background-text">
                {String(index + 1).padStart(2, "0")}
              </span>
            </div>
            <span className="flex flex-col gap-1">
              <span className="font-medium text-background-textContrast text-sm">{node.label}</span>
              <span className="font-mono text-[11px] text-background-text">{node.fact}</span>
            </span>
          </div>
        ))}
      </div>

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
        `access.check` is safe to run in shadow. `usage.consume` enforces in the request path.
        `runs.*` reserves budget before multi-step work. `usage.record` reports evidence without
        blocking.
      </p>
    </figure>
  )
}
