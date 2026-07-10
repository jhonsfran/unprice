"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@unprice/ui/sheet"
import { Skeleton } from "@unprice/ui/skeleton"
import { CheckCircle2, Loader2, RotateCcw, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { formatDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import {
  type IngestionEventRow,
  formatIngestionEventModeLabel,
} from "./ingestion-events-table-schema"

export function IngestionEventDetailsSheet({
  event,
  isReplayQueued,
  isReplayPending,
  onOpenChange,
  onReplay,
  open,
}: {
  event: IngestionEventRow | null
  isReplayQueued: boolean
  isReplayPending: boolean
  onOpenChange: (open: boolean) => void
  onReplay: (canonicalAuditId: string) => Promise<void>
  open: boolean
}) {
  const trpc = useTRPC()
  const hasReplayPayload = event?.state === "failed" && event.replayable
  const canReplay = hasReplayPayload && !isReplayQueued
  const {
    data: payloadData,
    isLoading: isPayloadLoading,
    error: payloadError,
  } = useQuery(
    trpc.analytics.getFailedIngestionEventPayload.queryOptions(
      {
        canonicalAuditId: event?.canonicalAuditId ?? "",
      },
      {
        enabled: open && hasReplayPayload,
      }
    )
  )

  if (!event) {
    return null
  }

  const issue = getIssueDetails(event, payloadData)

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
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <FieldLabel>Audit ID</FieldLabel>
              <SheetDescription className="break-all font-mono text-background-text text-xs">
                {event.canonicalAuditId}
              </SheetDescription>
            </div>
            {hasReplayPayload ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={isReplayPending || isReplayQueued}
                className="shrink-0"
                onClick={() => {
                  if (!canReplay) {
                    return
                  }

                  void onReplay(event.canonicalAuditId).catch(() => undefined)
                }}
              >
                {isReplayQueued ? (
                  <CheckCircle2 className="mr-1.5 size-3.5 text-success-text" />
                ) : isReplayPending ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1.5 size-3.5" />
                )}
                {isReplayQueued ? "Replay queued" : "Replay"}
              </Button>
            ) : null}
          </div>
        </SheetHeader>

        <div className="hide-scrollbar min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          <Section title="Event context">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
              <Field label="Customer">{event.customerId}</Field>
              <Field label="Source">{event.sourceType}</Field>
              <Field label="Ingestion mode">{formatIngestionEventModeLabel(event)}</Field>
              <Field label="Event ID">{event.eventId}</Field>
              <Field label="Source ID">{event.sourceId}</Field>
              {event.runId ? <Field label="Run ID">{event.runId}</Field> : null}
              {event.workloadType || event.workloadId ? (
                <Field label="Workload">{formatWorkload(event)}</Field>
              ) : null}
              <Field label="Handled">
                {formatDate(event.handledAt, undefined, "yyyy-MM-dd HH:mm:ss")}
              </Field>
              <Field label="Received">
                {formatDate(event.receivedAt, undefined, "yyyy-MM-dd HH:mm:ss")}
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
              <Field label="Failure stage">{event.failureStage ?? "none"}</Field>
              <Field label="Failure reason">{event.failureReason ?? "none"}</Field>
              <Field label="Failure message">
                {event.failureMessage ?? payloadData?.failureMessage ?? "none"}
              </Field>
              <Field label="Replayable">{event.replayable ? "yes" : "no"}</Field>
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
              canFetchPayload={hasReplayPayload}
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

function formatWorkload(event: IngestionEventRow): string {
  if (event.workloadType && event.workloadId) {
    return `${event.workloadType}:${event.workloadId}`
  }

  return event.workloadType ?? event.workloadId ?? "none"
}

function getIssueDetails(
  event: IngestionEventRow,
  payload: PayloadQueryData | undefined
): { message: string; title: string } | null {
  if (event.state === "rejected") {
    return {
      title: "Rejected",
      message: event.rejectionReason ?? "No rejection reason was recorded.",
    }
  }

  if (event.state === "failed") {
    return {
      title: "Pipeline failure",
      message:
        event.failureMessage ??
        payload?.failureMessage ??
        event.failureReason ??
        event.failureStage ??
        "No failure detail was recorded.",
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
  if (event.state !== "failed") {
    return (
      <MutedPanel>
        Payload lookup is currently available for failed events only. This row is {event.state}.
      </MutedPanel>
    )
  }

  if (!event.replayable) {
    return (
      <MutedPanel>This failed event is not replayable, so no replay payload is stored.</MutedPanel>
    )
  }

  if (!canFetchPayload || payload.isLoading) {
    return <PayloadSkeleton />
  }

  if (payload.error) {
    return <MutedPanel>{payload.error.message}</MutedPanel>
  }

  if (!payload.data?.payloadJson) {
    return <MutedPanel>No replay payload was found for this failed event.</MutedPanel>
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

function statusBadgeVariant(
  state: IngestionEventRow["state"]
): "success" | "warning" | "destructive" {
  if (state === "processed") {
    return "success"
  }

  return state === "failed" ? "destructive" : "warning"
}

function formatJson(rawJson: string): string {
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2)
  } catch {
    return rawJson
  }
}

type PayloadQueryData = {
  failureMessage: string | null
  payloadJson: string
} | null

type PayloadQueryState = {
  data: PayloadQueryData | undefined
  error: { message: string } | null
  isLoading: boolean
}
