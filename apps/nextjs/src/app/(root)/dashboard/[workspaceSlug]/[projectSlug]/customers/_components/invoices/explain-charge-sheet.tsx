"use client"

import { useQuery } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Separator } from "@unprice/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@unprice/ui/sheet"
import { Skeleton } from "@unprice/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { FileSearch, Loader2 } from "lucide-react"
import { useState } from "react"
import { formatDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import { formatInvoiceMoney } from "./format-invoice-money"

type Invoice = RouterOutputs["customers"]["getInvoiceById"]["invoice"]
type InvoiceLine = Invoice["lines"][number]
type ExplainCharge = RouterOutputs["analytics"]["explainCharge"]

export function ExplainChargeSheet({
  invoice,
  line,
}: {
  invoice: Invoice
  line: InvoiceLine
}) {
  const [isOpen, setIsOpen] = useState(false)
  const trpc = useTRPC()
  const explanation = useQuery(
    trpc.analytics.explainCharge.queryOptions(
      {
        invoiceId: invoice.id,
        entryId: line.entryId,
        limit: 50,
      },
      {
        enabled: isOpen,
      }
    )
  )

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              aria-label={`Explain charge for ${line.description ?? line.kind}`}
              className="text-muted-foreground hover:text-foreground"
              size="xs"
              variant="ghost"
            >
              {explanation.isFetching && isOpen ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileSearch className="size-3.5" />
              )}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">Explain charge</TooltipContent>
      </Tooltip>

      <SheetContent className="hide-scrollbar flex max-h-screen w-full flex-col overflow-y-auto md:w-1/2 lg:w-[760px]">
        <SheetHeader className="pr-6">
          <SheetTitle>
            Why this costs {formatInvoiceMoney(line.amount, invoice.currency)}
          </SheetTitle>
          <SheetDescription>
            {line.description ?? line.kind} · {line.quantity ?? "-"} units
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {explanation.isLoading ? (
            <ExplainChargeSkeleton />
          ) : explanation.error ? (
            <ExplainChargeError message={explanation.error.message} />
          ) : explanation.data ? (
            <ExplainChargeContent explanation={explanation.data} invoice={invoice} line={line} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ExplainChargeContent({
  explanation,
  invoice,
  line,
}: {
  explanation: ExplainCharge
  invoice: Invoice
  line: InvoiceLine
}) {
  const ledgerLineCount = explanation.evidence.filter((item) => item.type === "ledger_line").length
  const ratedFactsLabel = `${formatNumber(explanation.summary.eventCount)} rated ${
    explanation.summary.eventCount === 1 ? "fact" : "facts"
  }`

  return (
    <>
      <PricingRule explanation={explanation} />

      <div className="rounded-md border bg-muted/20 p-4">
        <p className="text-muted-foreground text-sm leading-6">{explanation.answer}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Usage" value={formatNumber(explanation.summary.totalUsage)} />
        <Metric label="Rated facts" value={formatNumber(explanation.summary.eventCount)} />
        <Metric label="Amount" value={formatInvoiceMoney(line.amount, invoice.currency)} />
      </div>

      <div className="rounded-md border px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">Calculation</span>
          <span className="text-muted-foreground">
            {formatNumber(explanation.summary.totalUsage)} units
          </span>
          <span className="text-muted-foreground">-&gt;</span>
          <span>
            {formatInvoiceMoney(explanation.summary.totalAmount, explanation.summary.currency)}
          </span>
        </div>
        <div className="mt-1 text-muted-foreground text-xs">
          {ratedFactsLabel}
          {ledgerLineCount > 1 ? `, grouped from ${ledgerLineCount} ledger captures` : ""}
        </div>
      </div>

      {explanation.events.length > 0 ? (
        <div className="space-y-3">
          <SectionHeader
            title="Rated usage events"
            trailing={
              explanation.pagination.hasMore
                ? `Showing ${explanation.events.length} of ${explanation.summary.eventCount}`
                : `${explanation.events.length} shown`
            }
          />
          <ScrollArea className="h-[420px] rounded-md border">
            {explanation.events.map((event) => (
              <div
                className="grid grid-cols-[1fr_auto] gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                key={event.event_id}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{event.event_slug}</div>
                  <div className="truncate text-muted-foreground text-xs">
                    {formatDate(
                      event.timestamp,
                      invoice.subscription.timezone,
                      "MMM d, yyyy hh:mm:ss a"
                    )}{" "}
                    · {formatNumber(event.delta)} units
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium">
                    {formatInvoiceMoney(event.amount, event.currency)}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {formatRawLedgerAmount(event.amount, event.currency, event.amount_scale)}
                  </div>
                </div>
              </div>
            ))}
          </ScrollArea>
        </div>
      ) : null}
    </>
  )
}

function PricingRule({ explanation }: { explanation: ExplainCharge }) {
  return (
    <div className="rounded-md border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-sm">Pricing rule</span>
        <span className="text-muted-foreground text-sm">{explanation.pricing.description}</span>
      </div>

      {explanation.pricing.rows.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {explanation.pricing.rows.slice(0, 4).map((row) => (
            <div className="flex items-center justify-between gap-3 text-xs" key={row.label}>
              <span className="truncate text-muted-foreground">{row.label}</span>
              <span className="shrink-0 font-medium">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 truncate font-semibold text-sm">{value}</div>
    </div>
  )
}

function SectionHeader({ title, trailing }: { title: string; trailing?: string }) {
  return (
    <div className="flex items-center gap-3">
      <h3 className="font-semibold text-sm">{title}</h3>
      <Separator className="flex-1" />
      {trailing ? <span className="text-muted-foreground text-xs">{trailing}</span> : null}
    </div>
  )
}

function ExplainChargeError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
      <div className="font-medium">Could not explain this charge</div>
      <div className="mt-1 text-muted-foreground">{message}</div>
    </div>
  )
}

function ExplainChargeSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 4,
  }).format(value)
}

function formatRawLedgerAmount(amount: number, currency: string, scale: number): string {
  const value = amount / 10 ** scale

  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: scale,
  }).format(value)} ${currency}`
}
