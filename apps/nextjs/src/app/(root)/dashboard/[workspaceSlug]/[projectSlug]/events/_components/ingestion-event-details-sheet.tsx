"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Separator } from "@unprice/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@unprice/ui/sheet"
import { Skeleton } from "@unprice/ui/skeleton"
import { CheckCircle2, Loader2, RotateCcw, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { formatDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import type { IngestionEventRow } from "./ingestion-events-table-schema"

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
  const payload = useQuery(
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

  const issue = getIssueDetails(event, payload.data)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="hide-scrollbar flex max-h-screen w-full flex-col overflow-y-auto md:w-1/2 lg:w-[760px]">
        <SheetHeader className="pr-8">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="font-mono text-xl">{event.eventSlug}</SheetTitle>
                <Badge variant={statusBadgeVariant(event.state)}>{event.state}</Badge>
              </div>
              <SheetDescription className="break-all font-mono">
                {event.canonicalAuditId}
              </SheetDescription>
            </div>
            {hasReplayPayload ? (
              <Button
                type="button"
                variant="primary"
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
                  <CheckCircle2 className="mr-1.5 size-3.5" />
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

        <div className="mt-6 space-y-6">
          <section className="grid gap-3 sm:grid-cols-2">
            <DetailItem label="Customer">{event.customerId}</DetailItem>
            <DetailItem label="Source">{event.sourceType}</DetailItem>
            <DetailItem label="Event ID">{event.eventId}</DetailItem>
            <DetailItem label="Source ID">{event.sourceId}</DetailItem>
            <DetailItem label="Handled">
              {formatDate(event.handledAt, undefined, "yyyy-MM-dd HH:mm:ss")}
            </DetailItem>
            <DetailItem label="Received">
              {formatDate(event.receivedAt, undefined, "yyyy-MM-dd HH:mm:ss")}
            </DetailItem>
          </section>

          <Separator />

          <section className="space-y-3">
            <SectionTitle>Outcome</SectionTitle>
            <div className="rounded-md border bg-muted/20 p-4">
              {issue ? (
                <div className="mb-4 flex gap-3 rounded-md border bg-background/70 p-3">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm">{issue.title}</p>
                    <p className="mt-1 break-words font-mono text-muted-foreground text-xs">
                      {issue.message}
                    </p>
                  </div>
                </div>
              ) : null}
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <DetailTerm label="Rejection reason" value={event.rejectionReason ?? "none"} />
                <DetailTerm label="Failure stage" value={event.failureStage ?? "none"} />
                <DetailTerm label="Failure reason" value={event.failureReason ?? "none"} />
                <DetailTerm
                  label="Failure message"
                  value={event.failureMessage ?? payload.data?.failureMessage ?? "none"}
                />
                <DetailTerm label="Replayable" value={event.replayable ? "yes" : "no"} />
              </dl>
            </div>
          </section>

          <section className="space-y-3">
            <SectionTitle>Payload</SectionTitle>
            <PayloadPanel event={event} payload={payload} canFetchPayload={hasReplayPayload} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 px-3 py-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="mt-1 truncate font-mono text-xs">{children}</div>
    </div>
  )
}

function DetailTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 break-words font-mono text-xs">{value}</dd>
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-medium text-sm">{children}</h3>
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
    <div className="max-h-[45vh] overflow-auto rounded-md border bg-background-subtle">
      <pre className="min-w-max whitespace-pre p-4 font-mono text-xs leading-5">
        {formatJson(payload.data.payloadJson)}
      </pre>
    </div>
  )
}

function PayloadSkeleton() {
  return (
    <div className="space-y-2 rounded-md border p-4">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  )
}

function MutedPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/20 p-4 text-muted-foreground text-sm leading-6">
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
