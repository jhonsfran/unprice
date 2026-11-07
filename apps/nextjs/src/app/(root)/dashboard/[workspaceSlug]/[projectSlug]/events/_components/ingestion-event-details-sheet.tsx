"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "@unprice/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@unprice/ui/sheet"
import { Skeleton } from "@unprice/ui/skeleton"
import { TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { formatDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import type { IngestionEventRow } from "./ingestion-events-table-schema"

export function IngestionEventDetailsSheet({
  event,
  onOpenChange,
  open,
}: {
  event: IngestionEventRow | null
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const trpc = useTRPC()
  // A refused event keeps its payload and rejection in the budget journal.
  const hasRejectedPayload = event?.state === "rejected"
  const {
    data: payloadData,
    isLoading: isPayloadLoading,
    error: payloadError,
  } = useQuery(
    trpc.analytics.getRejectedEventPayload.queryOptions(
      {
        customerId: event?.customerId ?? "",
        operationId: event?.operationId ?? "",
        handledAt: event?.handledAt ?? 0,
      },
      {
        enabled: open && hasRejectedPayload,
      }
    )
  )

  if (!event) {
    return null
  }

  const issue = getIssueDetails(event)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 space-y-3 border-border border-b px-6 py-5 pr-12 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <SheetTitle className="truncate font-medium font-mono text-base">
              {event.eventSlug}
            </SheetTitle>
            <Badge variant={statusBadgeVariant(event.state)} className="shrink-0">
              {event.state}
            </Badge>
          </div>
          <div className="min-w-0 space-y-1">
            <FieldLabel>Operation ID</FieldLabel>
            <SheetDescription className="break-all font-mono text-background-text text-xs">
              {event.operationId}
            </SheetDescription>
          </div>
        </SheetHeader>

        <div className="hide-scrollbar min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          <Section title="Event context">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
              <Field label="Customer">{event.customerId}</Field>
              <Field label="Operation">{event.sourceType}</Field>
              <Field label="Event ID">{event.eventId}</Field>
              <Field label="Budget key">{event.budgetKey}</Field>
              <Field label="Handled">
                {formatDate(event.handledAt, undefined, "yyyy-MM-dd HH:mm:ss")}
              </Field>
              <Field label="Occurred">
                {formatDate(event.timestamp, undefined, "yyyy-MM-dd HH:mm:ss")}
              </Field>
            </dl>
          </Section>

          <Section title="Outcome">
            {issue ? (
              <div className="flex gap-2.5 rounded-md border border-danger-border bg-danger-bg px-3 py-2.5">
                <TriangleAlert className="mt-px size-4 shrink-0 text-danger-text" />
                <div className="min-w-0 space-y-1">
                  <p className="font-medium text-danger-textContrast text-xs">{issue.title}</p>
                  <p className="break-words font-mono text-danger-text text-xs leading-relaxed">
                    {issue.message}
                  </p>
                </div>
              </div>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
              <Field label="Rejection reason">{event.rejectionReason ?? "none"}</Field>
            </dl>
          </Section>

          <Section title="Payload">
            <PayloadPanel
              event={event}
              payload={{
                data: payloadData,
                isLoading: isPayloadLoading,
                error: payloadError ?? null,
              }}
              canFetchPayload={hasRejectedPayload}
            />
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 px-6 py-5">
      <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
        {title}
      </h3>
      {children}
    </section>
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block text-[11px] text-muted-foreground uppercase tracking-[0.04em]">
      {children}
    </span>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <FieldLabel>{label}</FieldLabel>
      <dd className="break-words font-mono text-background-textContrast text-xs">{children}</dd>
    </div>
  )
}

function getIssueDetails(event: IngestionEventRow): { message: string; title: string } | null {
  if (event.state === "rejected") {
    return {
      title: "Rejected",
      message: event.rejectionReason ?? "No rejection reason was recorded.",
    }
  }

  return null
}

function PayloadPanel({
  event,
  payload,
  canFetchPayload,
}: {
  event: IngestionEventRow
  payload: PayloadQueryState
  canFetchPayload: boolean
}) {
  if (event.state !== "rejected") {
    return (
      <MutedPanel>
        Payload lookup is available for rejected events only. This row is {event.state}.
      </MutedPanel>
    )
  }

  if (!canFetchPayload || payload.isLoading) {
    return <PayloadSkeleton />
  }

  if (payload.error) {
    return <MutedPanel>{payload.error.message}</MutedPanel>
  }

  if (!payload.data?.payloadJson) {
    return (
      <MutedPanel>
        The journal has no payload for this event yet; it lags the budget by a few minutes.
      </MutedPanel>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface-panel">
      <pre className="min-w-max whitespace-pre p-4 font-mono text-[11px] text-background-textContrast leading-5">
        {formatJson(payload.data.payloadJson)}
      </pre>
    </div>
  )
}

function PayloadSkeleton() {
  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  )
}

function MutedPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface-panel px-4 py-3 text-muted-foreground text-xs leading-6">
      {children}
    </div>
  )
}

function statusBadgeVariant(state: IngestionEventRow["state"]): "success" | "warning" {
  if (state === "processed") {
    return "success"
  }

  return "warning"
}

function formatJson(rawJson: string): string {
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2)
  } catch {
    return rawJson
  }
}

type PayloadQueryData = {
  payloadJson: string
} | null

type PayloadQueryState = {
  data: PayloadQueryData | undefined
  error: { message: string } | null
  isLoading: boolean
}
