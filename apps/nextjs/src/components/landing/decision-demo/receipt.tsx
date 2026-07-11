"use client"

import { cn } from "@unprice/ui/utils"
import { MousePointerClick } from "lucide-react"
import type { ReactNode } from "react"
import { AnimatedCounter } from "../animated-counter"
import { Leader, LedgerRow, StationDot } from "../station"
import {
  BASE_FEE,
  DECISION_COPY,
  DEMO_CUSTOMER,
  DEMO_PLAN_VERSION,
  type Decision,
  type Feature,
  INTENT,
  featureCost,
  guardrailLabel,
  pricingRuleLabel,
} from "./model"

function ReceiptMarker({ children }: { children: string }) {
  return (
    <div aria-hidden className="flex items-center gap-2 pt-3 pb-1">
      <span className="h-px w-3 shrink-0 bg-background-border" />
      <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
        {children}
      </span>
    </div>
  )
}

export function OutcomeChip({
  decision,
  chipHit,
}: {
  decision: Decision | null
  chipHit: boolean
}) {
  if (!decision) {
    return (
      <div className="flex items-center gap-2.5 rounded-sm border border-background-border border-dashed px-3 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-background-borderHover border-dashed text-background-text">
          <MousePointerClick aria-hidden className="size-3.5" />
        </span>
        <div className="flex flex-1 items-baseline justify-between gap-2">
          <p className="font-medium text-background-text text-sm">awaiting the first request</p>
          <p className="font-mono text-[11px] text-background-text">—</p>
        </div>
      </div>
    )
  }

  const copy = DECISION_COPY[decision.kind]
  const intent = INTENT[decision.kind]
  const Icon = intent.icon

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-sm border px-3 py-2 transition-colors duration-regular ease-out-quad",
        chipHit ? intent.chipHit : intent.chipRest
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm",
          intent.iconBox
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </span>
      <div className="flex flex-1 items-baseline justify-between gap-2">
        <p className="font-medium text-background-textContrast text-sm">{copy.title}</p>
        <p className={cn("font-mono text-[11px]", intent.codeText)}>{copy.code}</p>
      </div>
    </div>
  )
}

export function DecisionReceipt({
  decision,
  feature,
  chipHit,
}: {
  decision: Decision | null
  feature: Feature | null
  chipHit: boolean
}) {
  const pending = !decision || !feature
  const denied = decision?.kind === "deny"
  const covered = decision?.reason === "already_included"
  const remaining = feature ? Math.max(0, feature.config.limit - feature.usage) : 0

  // Evidence facts derive from live plan state, not a snapshot: raising a
  // blocked row's limit updates "remaining" on the receipt in place — the fix
  // is visible before the retry.
  const evidence = pending
    ? [
        { label: "call", fact: "—" },
        { label: "plan version", fact: "—" },
        { label: "pricing rule", fact: "—" },
        { label: "guardrail", fact: "—" },
        { label: "remaining", fact: "—" },
      ]
    : [
        {
          label: "call",
          fact: feature.call,
          factClassName: "text-info-text",
        },
        { label: "plan version", fact: DEMO_PLAN_VERSION },
        { label: "pricing rule", fact: pricingRuleLabel(feature) },
        { label: "guardrail", fact: guardrailLabel(feature) },
        {
          label: "remaining",
          fact:
            feature.type === "flat" ? (
              "included"
            ) : (
              <>
                <AnimatedCounter value={remaining} /> {feature.unit}
              </>
            ),
          factClassName: denied ? "text-danger-text" : "text-background-textContrast",
        },
      ]

  // The same four receipt lines on every outcome. The deny proves itself by
  // absence — never ran, no entry, no line — exactly like the money path's
  // untouched ghost stations; the allow fills the same lines in.
  const created: { label: string; fact: ReactNode; ghost: boolean }[] =
    pending || denied
      ? [
          { label: "work", fact: pending ? "—" : "never ran", ghost: true },
          { label: "accepted charge", fact: pending ? "—" : "none", ghost: true },
          { label: "ledger", fact: pending ? "—" : "no entry", ghost: true },
          { label: "invoice line", fact: pending ? "—" : "no line", ghost: true },
        ]
      : [
          { label: "work", fact: "executed", ghost: false },
          {
            label: "accepted charge",
            fact: <AnimatedCounter value={decision.charge} prefix="$" decimals={2} />,
            ghost: false,
          },
          {
            label: "ledger",
            fact: covered ? "no new entry" : "capture · balanced",
            ghost: covered,
          },
          {
            label: "invoice line",
            fact: covered ? "no new line" : "explained · evidence attached",
            ghost: covered,
          },
        ]

  return (
    <div className="flex flex-1 flex-col">
      <div aria-live="polite">
        <OutcomeChip decision={decision} chipHit={chipHit} />
      </div>

      <ReceiptMarker>evidence kept with the decision</ReceiptMarker>
      <div className="flex flex-col">
        {evidence.map((row) => (
          <LedgerRow
            key={row.label}
            label={row.label}
            fact={row.fact}
            variant="ghost"
            labelClassName="text-xs"
            factClassName={"factClassName" in row ? row.factClassName : undefined}
          />
        ))}
      </div>

      <ReceiptMarker>what this click created</ReceiptMarker>
      <div className="flex flex-col">
        {created.map((row) => (
          <div key={row.label} className="flex items-baseline gap-2 py-[5px]">
            <StationDot variant={row.ghost ? "ghost" : "default"} className="self-center" />
            <span className="text-background-text text-xs">{row.label}</span>
            <Leader />
            <span
              className={cn(
                "whitespace-nowrap text-right font-mono text-[11px]",
                row.ghost ? "text-background-text" : "text-background-textContrast"
              )}
            >
              {row.fact}
            </span>
          </div>
        ))}
      </div>

      {/* The API voice, as the terminal receipt artifact. It teaches even
          while idle — the pending state is a real state, not a placeholder. */}
      <div className="mt-auto pt-4">
        <div className="rounded-sm border border-background-border bg-surface-raised px-3 py-2 font-mono text-[11px] text-background-text leading-5">
          <span className="text-background-textContrast">decision</span>
          {` = ${pending ? "pending" : DECISION_COPY[decision.kind].value}`}
          <br />
          <span className="text-background-textContrast">reason</span>
          {` = ${pending ? "no_request_sent" : decision.reason}`}
          <br />
          <span className="text-background-textContrast">next</span>
          {` = ${pending ? "click a paid action on the plan" : DECISION_COPY[decision.kind].next}`}
        </div>
      </div>
    </div>
  )
}

export function InvoiceReceipt({ features }: { features: Feature[] }) {
  const metered = features.reduce((sum, f) => sum + featureCost(f), 0)
  const total = BASE_FEE + metered

  const period = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })

  const qtyLabel = (f: Feature) => {
    if (f.type === "flat") return "1 seat · flat"
    if (f.type === "tiered") return `${f.usage} ${f.unit} · tiered`
    return `${f.usage} × $${f.rate.toFixed(2)}`
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-col">
        <LedgerRow
          label="invoice"
          variant="ghost"
          labelClassName="text-xs"
          fact="INV-0042 · sandbox"
        />
        <LedgerRow label="billed to" variant="ghost" labelClassName="text-xs" fact={DEMO_CUSTOMER} />
        <LedgerRow label="period" variant="ghost" labelClassName="text-xs" fact={period} />
        <LedgerRow
          label="status"
          variant="ghost"
          labelClassName="text-xs"
          fact="paid"
          factClassName="text-success-text"
        />
      </div>

      <ReceiptMarker>lines · each explained by its decision</ReceiptMarker>
      <div className="flex flex-col">
        <div className="flex items-baseline gap-2 py-[5px]">
          <span className="font-medium text-background-textContrast text-sm">Pro plan base</span>
          <span className="font-mono text-[10px] text-background-text">monthly</span>
          <Leader />
          <span className="whitespace-nowrap font-mono text-[11px] text-background-textContrast tabular-nums">
            ${BASE_FEE.toFixed(2)}
          </span>
        </div>
        {features
          .filter((f) => f.usage > 0)
          .map((f) => (
            <div key={f.id} className="flex items-baseline gap-2 py-[5px]">
              <span className="font-medium text-background-textContrast text-sm">
                {f.displayName}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
                {qtyLabel(f)}
              </span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[11px] text-background-textContrast tabular-nums">
                ${featureCost(f).toFixed(2)}
              </span>
            </div>
          ))}
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-4 border-background-border border-t pt-3">
        <span className="font-medium text-background-textContrast text-sm">Total</span>
        <span className="font-mono font-semibold text-background-textContrast text-base tabular-nums">
          <AnimatedCounter value={total} prefix="$" decimals={2} />
        </span>
      </div>

      <div className="mt-auto pt-4">
        <p className="border-background-border border-t pt-3 font-mono text-[10px] text-background-text leading-4">
          every line above links to the decisions that accepted it — dispute answered from the same
          path, not from logs
        </p>
      </div>
    </div>
  )
}
