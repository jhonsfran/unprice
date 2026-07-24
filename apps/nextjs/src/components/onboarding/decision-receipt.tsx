import { Leader, LedgerRow, StationDot } from "@unprice/ui/station"
import { cn } from "@unprice/ui/utils"
import { Ban, Check } from "lucide-react"

import type { ProofAction, ProofDecisions } from "./paid-action-schema"

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
})

function formatMoney(amountMinor: number) {
  return USD_FORMATTER.format(amountMinor / 100)
}

// icon box + outcome + request tag + status code — the money-path outcome chip.
function OutcomeChip({ kind }: { kind: "allowed" | "denied" }) {
  const isAllowed = kind === "allowed"
  const Icon = isAllowed ? Check : Ban
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-sm text-white",
          isAllowed ? "bg-success-solid" : "bg-danger-solid"
        )}
      >
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="flex flex-1 items-baseline justify-between gap-2">
        <div>
          <p className="font-medium text-background-textContrast text-sm">
            {isAllowed ? "Allowed" : "Denied"}
          </p>
          <p className="font-mono text-[11px] text-background-text">
            request {isAllowed ? "1" : "2"}
          </p>
        </div>
        <p
          className={cn(
            "whitespace-nowrap font-mono text-[11px]",
            isAllowed ? "text-success-text" : "text-danger-text"
          )}
        >
          {isAllowed ? "200 · accepted" : "402 · insufficient_budget"}
        </p>
      </div>
    </div>
  )
}

// The deny branch proves itself by what it did NOT create — a dashed station
// dot + muted fact, the same evidence-of-absence grammar as the money path.
function GhostRow({ label, fact }: { label: string; fact: string }) {
  return (
    <div className="flex items-baseline gap-2 py-[5px]">
      <StationDot variant="ghost" className="self-center" />
      <span className="text-background-text text-xs">{label}</span>
      <Leader />
      <span className="whitespace-nowrap text-right font-mono text-[11px] text-background-text">
        {fact}
      </span>
    </div>
  )
}

export function DecisionReceipt({
  action,
  decisions,
  deniedRevealed,
}: {
  action: ProofAction
  decisions: ProofDecisions
  deniedRevealed: boolean
}) {
  const [allowed, denied] = decisions

  return (
    <article
      aria-label="Paid-action decision receipt"
      className="relative rounded-md border border-background-border bg-surface-raised p-4 shadow-ambient sm:p-5"
    >
      {/* Bracket corners — the logo's containment motif marks the decision moment. */}
      <span
        aria-hidden
        className="-top-px -left-px absolute size-3 border-primary-text border-t-2 border-l-2"
      />
      <span
        aria-hidden
        className="-top-px -right-px absolute size-3 border-primary-text border-t-2 border-r-2"
      />
      <span
        aria-hidden
        className="-bottom-px -left-px absolute size-3 border-primary-text border-b-2 border-l-2"
      />
      <span
        aria-hidden
        className="-right-px -bottom-px absolute size-3 border-primary-text border-r-2 border-b-2"
      />

      <div className="flex items-baseline justify-between gap-2 pb-3">
        <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
          budgeted run
        </span>
        <span className="whitespace-nowrap font-mono text-[11px] text-background-text tabular-nums">
          {formatMoney(action.unitPriceMinor)} · one action
        </span>
      </div>

      <div className="border-background-border border-t pt-3">
        <OutcomeChip kind="allowed" />
        <div className="mt-2">
          <LedgerRow
            label={action.title}
            fact={action.featureSlug}
            factClassName="text-info-text"
          />
          <LedgerRow label="run spend" fact={formatMoney(allowed.consumedAmountMinor)} />
          <LedgerRow
            label="budget remaining"
            fact={formatMoney(allowed.remainingAmountMinor)}
            factClassName="text-background-textContrast tabular-nums"
          />
        </div>
      </div>

      {deniedRevealed ? (
        <div className="fade-in slide-in-from-top-1 mt-1 animate-in border-background-border border-t pt-3 duration-regular motion-reduce:animate-none">
          <OutcomeChip kind="denied" />
          <div className="mt-2">
            <GhostRow label="paid action" fact="not authorized" />
            <GhostRow label="additional run spend" fact="none" />
            <GhostRow
              label="budget remaining"
              fact={`${formatMoney(denied.remainingAmountMinor)} · unchanged`}
            />
          </div>
        </div>
      ) : null}
    </article>
  )
}
