"use client"

import { cn } from "@unprice/ui/utils"
import { Ban, Check } from "lucide-react"
import { AnimatedCounter } from "./animated-counter"
import {
  type MoneyPathBudget as Budget,
  MONEY_PATH_GATE_PASS_PLAN,
  MONEY_PATH_PASS_PLAN,
  type MoneyPathRegistry,
  type MoneyPathStation as Station,
  useMoneyPathChoreography,
  useMoneyPathRegistry,
} from "./money-path-choreography"
import { Leader } from "./station"

// The signature visual: the money path, rendered as one request traced end to
// end. The brand works when the buyer can see the commercial decision and the
// evidence trail (docs/brand/brand-identity.md, design-system-guidelines.md):
// receipt-style stations with monospace facts, the budget decision framed by
// the bracket motif from the logo, and a literal fork — the allow branch
// settles and explains; the deny branch shows the same stations untouched, so
// "rejected before any cost" is visible as the absence of state. The path
// ends at the buyer's own payment provider: funds settle in their Stripe
// account, never in Unprice's — the boundary the money never crosses is a
// station, not a footnote. Token-driven; motion is the sanctioned
// request-path education: a dot walks the path in passes that share one
// budget — allowed requests each visibly reduce the balance, so a later
// request arrives at a balance that cannot cover it and is rejected. A
// rejection is a 200 carrying LIMIT_EXCEEDED, never a 429; the status codes
// on this diagram are the ones the API actually returns. The chips rest
// neutral and take
// their color only when the request reaches them, and the winning outcome
// stays lit until the next request spawns. Stacked (mobile) the fork
// collapses to one outcome column that follows the live request — the
// choreography stamps data-mp-outcome per pass and globals.css hides the
// other branch, so allow and deny swap in place instead of reading as
// "success first, denial later". Under prefers-reduced-motion, no dot moves
// and the loop never starts, but the sequence's final chip still lights so the
// diagram never rests on nothing; otherwise it starts when scrolled into view.
//
// The hero uses `reservations.reserve` because the first frame must show the
// economic control, not a read-only check. The full trace uses `usage.consume`
// to show the known-cost path through wallet, ledger, and invoice evidence.

// Narrative order, not dependency order: the event is measured first, then
// the access question, then what it costs — the same journey the request
// makes toward the budget decision. The plan version is not its own station:
// the pricing rule carries its pin (simplification round 2026-07-14), and the
// meter reading (2,050 tokens) is the quantity the invoice line multiplies
// out below, so the math is visible end to end: 2,050 × $0.002 = $4.10.
const resolveStations: Station[] = [
  { id: "meter", label: "Meter", fact: "tokens used · 2,050" },
  { id: "access", label: "Access", fact: "included in plan · yes" },
  { id: "pricing-rule", label: "Pricing rule", fact: "$0.002 / token · pro@v3" },
]

// The compact rail collapses the three resolve stations into the one fact the
// budget check consumes — the priced request. Meter, access, and the plan pin
// keep their own stations only in the full trace.
const gateStations: Station[] = [
  { id: "price", label: "Price", fact: "2,050 tokens × $0.002 = $4.10" },
]

const settleStations: Station[] = [
  { id: "wallet", label: "Wallet", fact: "reserve −$4.10" },
  { id: "ledger", label: "Ledger", fact: "capture · balanced" },
  { id: "invoice", label: "Invoice", fact: "line explained" },
]

// The terminus is the buyer's own provider account — the one distinction the
// diagram must carry: Unprice decides and explains, it never holds the funds.
const paymentStation: Station = { id: "payment", label: "Payment", fact: "your own Stripe" }

const ghostStations: Station[] = [
  { label: "Wallet", fact: "untouched" },
  { label: "Ledger", fact: "no entry" },
  { label: "Invoice", fact: "no line" },
]

function StationRow({
  id,
  label,
  fact,
  note,
  registry,
  variant = "default",
}: Station & {
  note?: string
  registry: MoneyPathRegistry
  variant?: "default" | "ghost" | "terminal"
}) {
  return (
    <div
      ref={id ? registry.waypointRefs[id] : undefined}
      className={cn("group relative py-[5px] pl-8", variant === "ghost" && "opacity-80")}
    >
      {/* The dot lives inside the title line so rows with a note keep it
          centered against the label, not the taller block. */}
      <div className="relative flex items-baseline gap-2">
        <span
          ref={id ? registry.railDotRefs[id] : undefined}
          aria-hidden
          className={cn(
            "-translate-x-1/2 -translate-y-1/2 -left-6 absolute top-1/2 size-[9px] rounded-full",
            variant === "default" && "border border-background-borderHover bg-surface-panel",
            variant === "ghost" && "border border-background-borderHover border-dashed",
            // The settled green is earned, not ambient: neutral until the
            // request actually reaches the line.
            variant === "terminal" &&
              "border border-background-borderHover bg-surface-panel transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:border-success-solid group-data-[mp-hit=true]:bg-success-solid"
          )}
        />
        <span
          className={cn(
            "whitespace-nowrap text-sm transition-colors duration-regular ease-out-quad",
            variant === "ghost"
              ? "text-background-text"
              : "font-medium text-background-textContrast",
            "group-data-[mp-hit=true]:text-info-text"
          )}
        >
          {label}
        </span>
        <Leader />
        <span
          className={cn(
            "whitespace-nowrap font-mono text-[11px] text-background-text",
            variant === "terminal" &&
              "transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-success-text"
          )}
        >
          {fact}
        </span>
      </div>
      {note ? <p className="mt-0.5 text-background-text text-xs">{note}</p> : null}
    </div>
  )
}

// request → decision: one uninterrupted rail — the checks and the budget gate
// read as one section. The balance is the one oversized fact on the rail, so
// the money moving stays the most legible change on screen without the gate
// outshouting the outcomes. Compact drops the request caption (the hero
// subhead directly beside it says the same thing) and keeps the decision
// caption, which carries the arithmetic.
function RequestDecisionRail({
  budget,
  stations,
  registry,
  compact = false,
}: {
  budget: Budget
  stations: Station[]
  registry: MoneyPathRegistry
  compact?: boolean
}) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="-translate-x-1/2 absolute top-1 bottom-0 left-2 w-px bg-background-border"
      />

      <div ref={registry.waypointRefs.request} className="group relative pb-3 pl-8">
        <span
          ref={registry.railDotRefs.request}
          aria-hidden
          className="-translate-x-1/2 absolute top-[5px] left-2 size-2.5 rounded-full bg-info ring-2 ring-info-bg"
        />
        <div className="flex items-baseline gap-2">
          <span className="whitespace-nowrap font-medium text-background-textContrast text-sm transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-info-text">
            Request
          </span>
          <Leader />
          {/* The compact render reserves variable-cost work. The full trace
              shows the atomic known-cost path. */}
          <span className="whitespace-nowrap font-mono text-[11px] text-info-text">
            {compact ? "reservations.reserve" : "usage.consume"}
          </span>
        </div>
        {compact ? null : (
          <p className="mt-0.5 text-background-text text-xs">the paid action asks before it runs</p>
        )}
      </div>

      {stations.map((station) => (
        <StationRow key={station.label} {...station} registry={registry} />
      ))}

      {/* The decision is a station like the others (simplification round
          2026-07-14: the framed box outshouted the outcomes) — what stays
          special is small: the beacon dot, the bracket ticks around the
          balance (the logo echo at the exact deciding fact), and the number
          itself, sized to be watched counting down. */}
      <div ref={registry.waypointRefs.decision} className="group relative mt-1 py-[5px] pl-8">
        {/* The beacon lives inside the title line and centers against it —
            the bracketed balance makes this line taller than a plain row, so
            a block-level offset drifts off the title (user-reported). */}
        <div className="relative flex items-center gap-2">
          <span
            ref={registry.railDotRefs.decision}
            aria-hidden
            className="-translate-x-1/2 -translate-y-1/2 -left-6 absolute top-1/2 block size-2.5"
          >
            <span className="mp-beacon absolute inset-0 rounded-full bg-warning-text" />
            <span className="absolute inset-0 rounded-full bg-warning-text" />
          </span>
          <span className="whitespace-nowrap font-medium text-background-textContrast text-sm transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-info-text">
            Budget check
          </span>
          <Leader />
          <span className="relative whitespace-nowrap px-2 py-0.5">
            <span
              aria-hidden
              className="absolute top-0 left-0 size-1.5 border-warning-text border-t border-l"
            />
            <span
              aria-hidden
              className="absolute top-0 right-0 size-1.5 border-warning-text border-t border-r"
            />
            <span
              aria-hidden
              className="absolute bottom-0 left-0 size-1.5 border-warning-text border-b border-l"
            />
            <span
              aria-hidden
              className="absolute right-0 bottom-0 size-1.5 border-warning-text border-r border-b"
            />
            <span
              className={cn(
                "font-medium font-mono text-lg leading-6 transition-colors duration-regular ease-out-quad",
                budget.short ? "text-warning-text" : "text-background-textContrast"
              )}
            >
              <AnimatedCounter value={budget.value} prefix="$" decimals={2} duration={650} />
            </span>
          </span>
        </div>
        <p className="mt-0.5 text-background-text text-xs">
          does the balance cover this $4.10 request?
        </p>
      </div>
    </div>
  )
}

// One future of the request, as a chip that rests neutral — the color is the
// decision happening, so it arrives only when the request does (management
// feedback 2026-07), and the winning outcome stays lit until the next request
// spawns. Shared by the full fork and the compact gate so both renders speak
// one grammar: outcome, status code, and the arithmetic that decided it.
function OutcomeChip({
  kind,
  registry,
  compact = false,
}: { kind: "allow" | "deny"; registry: MoneyPathRegistry; compact?: boolean }) {
  const allow = kind === "allow"
  const waypointId = allow ? "allow-chip" : "deny-chip"
  // The real API answers with a decision in the body, not an HTTP failure: a
  // denial is a 200 carrying allowed/accepted false and a machine-readable
  // rejection reason. (429 is rate limiting — a different thing entirely, and
  // showing it here would send engineers looking for a status code that never
  // arrives.) The field name follows the call each render is making.
  const verdict = allow ? (compact ? "allowed: true" : "accepted: true") : "LIMIT_EXCEEDED"
  return (
    <div
      ref={registry.waypointRefs[waypointId]}
      className={cn(
        "group flex items-center gap-2.5 rounded-sm border border-background-border bg-surface-raised px-3 py-2 transition-colors duration-regular ease-out-quad",
        allow
          ? "data-[mp-hit=true]:border-success-border data-[mp-hit=true]:bg-success-bg"
          : "data-[mp-hit=true]:border-danger-border data-[mp-hit=true]:bg-danger-bg"
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm bg-background-bgActive text-background-text transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-white",
          allow
            ? "group-data-[mp-hit=true]:bg-success-solid"
            : "group-data-[mp-hit=true]:bg-danger-solid"
        )}
      >
        {allow ? (
          <Check aria-hidden className="size-3.5" />
        ) : (
          <Ban aria-hidden className="size-3.5" />
        )}
      </span>
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium text-background-textContrast text-sm">
            {allow ? "allow · within budget" : "deny · over budget"}
          </p>
          <p
            className={cn(
              "font-mono text-[11px] text-background-text transition-colors duration-regular ease-out-quad",
              allow
                ? "group-data-[mp-hit=true]:text-success-text"
                : "group-data-[mp-hit=true]:text-danger-text"
            )}
          >
            {verdict}
          </p>
        </div>
        {/* The deny arithmetic is the punchline of the whole demo: the third
            request needs more than the balance the first two left. */}
        <p className="font-mono text-[10px] text-background-text leading-4">
          {allow ? "cost $4.10 · covered by balance" : "needs $4.10 · balance $1.80"}
        </p>
      </div>
    </div>
  )
}

// The two futures of the same request, with their consequences. The deny
// branch shows the same stations untouched — absence as proof. The
// data-mp-branch attributes drive the stacked-layout morph (globals.css): on
// mobile only the live pass's branch is shown.
function OutcomeFork({ registry }: { registry: MoneyPathRegistry }) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2">
      <div data-mp-branch="allow">
        <OutcomeChip kind="allow" registry={registry} />
        <div className="relative mt-2">
          <span
            aria-hidden
            className="-top-2 -translate-x-1/2 absolute bottom-8 left-2 w-px bg-background-border"
          />
          {settleStations.map((station) => (
            <StationRow key={station.label} {...station} registry={registry} />
          ))}
          {/* Terminal receipt rule (design-system-guidelines.md): the allow
              pass ends in a literal invoice line with its explain chain, not
              a sentence claiming one exists. */}
          <div className="my-1 ml-8 rounded-sm border border-background-border bg-surface-raised px-3 py-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                invoice line · explain
              </span>
              <span className="font-medium font-mono text-[11px] text-background-textContrast">
                $4.10
              </span>
            </div>
            <p className="mt-1 font-mono text-[10px] text-background-text leading-4">
              2,050 tokens × $0.002 · pro@v3
            </p>
            <p className="font-mono text-[10px] text-background-text leading-4">
              reserve → capture · balanced
            </p>
          </div>
          {/* The path ends in the buyer's account, not ours — the funds
              boundary stated as a station. */}
          <StationRow
            {...paymentStation}
            registry={registry}
            variant="terminal"
            note="the money never touches Unprice"
          />
        </div>
      </div>

      <div data-mp-branch="deny">
        <OutcomeChip kind="deny" registry={registry} />
        <div className="relative mt-2">
          <span
            aria-hidden
            className="-top-2 -translate-x-1/2 absolute bottom-4 left-2 w-0 border-background-border border-l border-dashed"
          />
          {ghostStations.map((station) => (
            <StationRow key={station.label} {...station} registry={registry} variant="ghost" />
          ))}
          {/* The deny receipt is the same receipt, empty: absence as proof —
              plus the one thing a deny does return: its reason, to your app. */}
          <div className="my-1 ml-8 rounded-sm border border-background-border border-dashed px-3 py-2 opacity-80">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                invoice line
              </span>
              <span className="font-mono text-[11px] text-background-text">—</span>
            </div>
            <p className="mt-1 font-mono text-[10px] text-background-text leading-4">
              no cost created · nothing to explain
            </p>
            {/* Same arrow grammar as the allow receipt's "reserve → capture":
                the one thing a deny does produce is its reason, delivered to
                the builder's app. */}
            <p className="font-mono text-[10px] text-background-text leading-4">
              reason → your app · limit exceeded
            </p>
          </div>
          <StationRow label="Payment" fact="no charge" registry={registry} variant="ghost" />
        </div>
      </div>
    </div>
  )
}

const FULL_ARIA =
  "Three identical usage.consume requests use one $10.00 budget. Each request meters 2,050 tokens at $0.002 per token on plan version pro@v3, for a cost of $4.10. The first two requests are accepted. Each one reserves $4.10, captures the ledger movement, writes the invoice line, and settles payment to your Stripe account. The balance falls to $1.80. Unprice never holds the funds. The third request is denied with LIMIT_EXCEEDED because it needs $4.10. The wallet stays untouched, and Unprice writes no ledger entry, invoice line, or charge. Your app receives the reason."

const COMPACT_ARIA =
  "Customer credits have $5.90 available. A reservation holds $4.10 before the provider runs and leaves $1.80 available. An identical second reservation is denied with LIMIT_EXCEEDED, so the provider does not run. The full path below traces usage, wallet movement, ledger capture, invoice evidence, and payment in your own Stripe account."

export function MoneyPath({
  className,
  variant = "full",
}: {
  className?: string
  /** "compact" is the hero render: reservation, price, budget decision, and
   * the two outcomes, with a pointer to the full trace. */
  variant?: "full" | "compact"
}) {
  const compact = variant === "compact"
  const stations = compact ? gateStations : resolveStations
  const passPlan = compact ? MONEY_PATH_GATE_PASS_PLAN : MONEY_PATH_PASS_PLAN
  const registry = useMoneyPathRegistry()
  const { budget, passNumber } = useMoneyPathChoreography(registry, stations, passPlan)

  return (
    <figure
      aria-label={compact ? COMPACT_ARIA : FULL_ARIA}
      className={cn("mx-auto w-full", compact ? "max-w-xl" : "max-w-3xl", className)}
    >
      <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          {compact ? "The reservation" : "The money path"}
        </span>
        {compact ? (
          // The reservation arrives with a balance already drawn down, so the
          // denial has something concrete to deny.
          <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
            customer funds · before provider
          </span>
        ) : (
          <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
            {passNumber === null
              ? `${passPlan.length} requests · one budget`
              : `request ${passNumber} of ${passPlan.length}`}
          </span>
        )}
      </figcaption>

      <div ref={registry.stageRef} className="relative">
        {/* request → decision */}
        <RequestDecisionRail
          budget={budget}
          stations={stations}
          registry={registry}
          compact={compact}
        />

        {/* fork connector (desktop) */}
        <div ref={registry.connectorRef} aria-hidden className="relative hidden h-9 sm:block">
          <span className="-translate-x-1/2 absolute top-0 bottom-0 left-2 w-px bg-background-border" />
          <span className="absolute top-3 right-[calc(50%-20px)] bottom-0 left-2 rounded-tr-[10px] border-background-border border-t border-r border-dashed" />
        </div>

        {/* fork connector (stacked): keep the rail continuous so the fork
            reads as a consequence of the decision, not a new diagram */}
        <div aria-hidden className="relative h-7 sm:hidden">
          <span className="-translate-x-1/2 absolute top-0 bottom-0 left-2 w-0 border-background-border border-l border-dashed" />
        </div>

        {/* the two futures of the same request — the compact gate ends here;
            the full render carries each future to its consequences */}
        {compact ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div data-mp-branch="allow">
              <OutcomeChip kind="allow" registry={registry} compact />
            </div>
            <div data-mp-branch="deny">
              <OutcomeChip kind="deny" registry={registry} compact />
            </div>
          </div>
        ) : (
          <OutcomeFork registry={registry} />
        )}

        {/* the request in flight — driven by the choreography effect above */}
        <span
          ref={registry.dotRef}
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 size-[9px] rounded-full bg-info opacity-0 will-change-transform"
        />
      </div>

      {compact ? (
        // The abridged render hands off to the full receipt instead of
        // carrying it: the terminal-moment rule is satisfied one anchor away.
        <a
          href="#money-path"
          className="group mt-5 flex items-baseline justify-between gap-4 border-background-border border-t pt-3"
        >
          <span className="text-background-text text-xs leading-6">
            Reserve first. Settle actual usage after.
          </span>
          <span className="whitespace-nowrap font-mono text-[11px] text-background-text transition-colors duration-regular ease-out-quad group-hover:text-background-textContrast">
            follow the full path ↓
          </span>
        </a>
      ) : (
        <p className="mt-5 border-background-border border-t pt-3 text-background-text text-xs leading-6">
          Every step is in the public SDK. Reserve variable-cost AI work, or consume known usage in
          one call. Use TypeScript, REST, or curl.
        </p>
      )}
    </figure>
  )
}
