import type { ReactNode } from "react"
import { Reveal } from "./reveal"
import { Leader, LedgerRow, SectionShell, StationDot } from "./station"
import { StationHeader } from "./station-header"

// Station 03, the business floor's close: the differentiators as state
// specimens, not sentences (2026-07-18 round 3: "a more visual way to see
// the USPs"). Each gain is shown as the artifact it produces — a plan sheet
// carrying four pricing models at once, the version pins that keep signed
// terms serving, a dispute closed by its own receipt (the exact inversion of
// station 01's ticket), and a deny arriving in the builder's product as an
// upgrade prompt. The four interiors deliberately use four different
// grammars — rate sheet, pin ledger, ticket, response-into-app — so the grid
// reads as receipts on a desk, not a card template. Same fictional universe
// as the rest of the page: pro@v3 at $0.002/token, the $4.10 request, acme-
// corp, ticket numbers in sequence. Every fact stays inside PRODUCT.md claim
// boundaries.

function Specimen({
  title,
  fact,
  ariaLabel,
  children,
}: {
  title: string
  fact: string
  ariaLabel: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-3">
        <StationDot className="self-center" />
        <h3 className="font-medium text-background-textContrast text-base">{title}</h3>
        <Leader className="hidden sm:block" />
        <span className="hidden whitespace-nowrap font-mono text-[11px] text-background-text sm:inline">
          {fact}
        </span>
      </div>
      <figure
        aria-label={ariaLabel}
        className="mt-3 flex-1 rounded-lg border border-background-border bg-surface-panel p-4 shadow-ambient"
      >
        {children}
      </figure>
    </div>
  )
}

// The mono kicker line every artifact opens with — the same figcaption
// grammar the page's larger receipts use, at specimen scale.
function SpecimenKicker({
  left,
  right,
  rightClassName,
}: { left: string; right?: string; rightClassName?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-background-border border-b pb-2">
      <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
        {left}
      </span>
      {right ? (
        <span
          className={`whitespace-nowrap font-mono text-[10px] ${rightClassName ?? "text-background-text"}`}
        >
          {right}
        </span>
      ) : null}
    </div>
  )
}

export function GainsSection() {
  return (
    <SectionShell labelledBy="gains-title">
      <div className="flex flex-col items-start">
        <StationHeader
          index="03"
          label="What you gain"
          fact="the same system · in business terms"
        />
        <h2
          id="gains-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Margin protected in real time. Pricing you can iterate.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Over-budget work is denied before it creates cost — margin kept, not refunded.
        </p>
      </div>

      <Reveal stagger className="mt-12 grid max-w-4xl grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2">
        {/* One sheet, four pricing models — "any model" rendered as the rate
            card that carries them all at once. */}
        <Specimen
          title="Sell usage-based and credit pricing"
          fact="any model · one system"
          ariaLabel="A plan sheet for pro version 3 carrying four pricing models at once: a flat base of $29 per month, an allowance of 10,000 tokens included, usage at $0.002 per token after the allowance, and credit packs of 5,000 tokens for $10."
        >
          <SpecimenKicker left="plan sheet · pro@v3" right="versioned" />
          <div className="mt-1 flex flex-col">
            <LedgerRow label="flat" fact="base $29 / month" />
            <LedgerRow label="allowance" fact="10,000 tokens included" />
            <LedgerRow label="usage" fact="then $0.002 / token" />
            <LedgerRow label="credits" fact="$10 pack · 5,000 tokens" />
          </div>
        </Specimen>

        {/* The price change that already happened, with nobody migrated —
            absence as the feature, same ghost grammar as everywhere else. */}
        <Specimen
          title="Change prices without breaking contracts"
          fact="no deploy · no migration"
          ariaLabel="A plan version ledger: pro version 4 at $0.0018 per token shipped today for new signups, while pro version 3 at $0.002 per token keeps serving — acme-corp stays on the terms it signed. The migration row reads: none ran."
        >
          <SpecimenKicker left="plan versions" right="v4 shipped today" />
          <div className="mt-1 flex flex-col">
            <LedgerRow
              label="pro@v4"
              labelClassName="font-mono text-xs"
              fact="$0.0018 / token · new signups"
            />
            <LedgerRow
              label="pro@v3"
              labelClassName="font-mono text-xs"
              fact="$0.002 / token · acme-corp stays"
            />
            <LedgerRow label="migration" variant="ghost" fact="none ran · terms keep serving" />
          </div>
        </Specimen>

        {/* Station 01's ticket, inverted: same card grammar, closed the same
            day, answered by the line's own receipt instead of engineering. */}
        <Specimen
          title="Disputes end with receipts"
          fact="evidence · per line"
          ariaLabel="A support ticket, number 4813, closed the same day. The customer asks: why were we charged $4.10? The reply is the invoice line's own receipt — 2,050 tokens at $0.002 on plan version pro v3 — and the ticket was assigned to no one: engineering was never paged."
        >
          <SpecimenKicker
            left="support · ticket #4813"
            right="closed · same day"
            rightClassName="text-success-text"
          />
          <p className="mt-2.5 text-background-textContrast text-sm leading-6">
            “Why were we charged $4.10?”
          </p>
          <div className="mt-1.5 flex flex-col">
            <div className="flex items-baseline gap-2 py-[3px]">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                reply
              </span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
                2,050 × $0.002 · pro@v3
              </span>
            </div>
            <div className="flex items-baseline gap-2 py-[3px]">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                assigned
              </span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
                no one · engineering never paged
              </span>
            </div>
          </div>
        </Specimen>

        {/* The deny as it lands in the builder's product: reason attached,
            rendered as their upgrade moment — their app, their styling. */}
        <Specimen
          title="Denials become upgrade conversations"
          fact="deny · reason attached"
          ariaLabel="A denied request, status 429, with no cost created. The reason — needs $4.10, balance $1.80 — is returned to your app, where it renders as your own upgrade prompt: you've hit the included usage, with an upgrade plan button."
        >
          <SpecimenKicker left="deny · 429" right="no cost created" />
          <div className="mt-1 flex flex-col">
            <LedgerRow label="reason" fact="needs $4.10 · balance $1.80" />
          </div>
          <div aria-hidden className="relative mt-2 mb-2">
            <span className="-translate-y-1/2 absolute top-1/2 left-0 h-px w-3 bg-background-border" />
            <span className="pl-6 font-mono text-[10px] text-background-text uppercase tracking-widest">
              returned to your app as
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-sm border border-background-border bg-surface-raised px-3 py-2.5">
            <p className="text-background-text text-xs leading-5">You’ve hit the included usage.</p>
            <span className="whitespace-nowrap rounded-md border border-background-borderHover bg-background-bgActive px-2.5 py-1 font-medium text-background-textContrast text-xs">
              Upgrade plan →
            </span>
          </div>
        </Specimen>
      </Reveal>
    </SectionShell>
  )
}
