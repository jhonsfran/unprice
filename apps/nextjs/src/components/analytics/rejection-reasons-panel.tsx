"use client"

import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { useMemo } from "react"
import { EvidenceFrame, EvidenceSection } from "./evidence-panel"
import type { IngestionRejection } from "./ingestion-health-model"

export type RejectionReasonSelection = {
  eventSlug: string
  sourceType: string
  rejectionReason: string | null
}

type RejectionReasonsPanelProps = {
  rejections: IngestionRejection[]
  onSelectFilter?: (filter: RejectionReasonSelection) => void
  presentation?: "card" | "section"
  className?: string
}

export function RejectionReasonsPanel({
  rejections,
  onSelectFilter,
  presentation = "card",
  className,
}: RejectionReasonsPanelProps) {
  const rejectionGroups = useMemo(() => groupVisibleRejections(rejections), [rejections])

  if (presentation === "section") {
    return (
      <EvidenceSection
        title="Top rejection reasons"
        description="Business denials grouped by reason, event, and source."
        className={className}
        contentClassName="mt-3"
        titleClassName="text-base"
      >
        <RejectionReasonsList rejectionGroups={rejectionGroups} onSelectFilter={onSelectFilter} />
      </EvidenceSection>
    )
  }

  return (
    <Card className={cn("border-muted/60", className)}>
      <CardHeader>
        <CardTitle>Top rejection reasons</CardTitle>
        <CardDescription>Business denials grouped by reason, event, and source.</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        <RejectionReasonsList
          rejectionGroups={rejectionGroups}
          onSelectFilter={onSelectFilter}
          unframed
        />
      </CardContent>
    </Card>
  )
}

function RejectionReasonsList({
  rejectionGroups,
  onSelectFilter,
  unframed = false,
}: {
  rejectionGroups: VisibleRejectionGroup[]
  onSelectFilter?: (filter: RejectionReasonSelection) => void
  unframed?: boolean
}) {
  if (rejectionGroups.length === 0) {
    return (
      <EvidenceFrame
        variant="dashed"
        className="flex items-center justify-center text-muted-foreground text-sm"
      >
        No rejected events in this window.
      </EvidenceFrame>
    )
  }

  return (
    <EvidenceFrame
      height="none"
      className={cn(
        "min-h-[220px] divide-y",
        unframed ? "rounded-md border border-border bg-transparent" : "bg-card/40"
      )}
    >
      {rejectionGroups.slice(0, 5).map((rejection) => (
        <button
          key={`${rejection.rejectionReason ?? "unknown"}:${rejection.eventSlug}:${rejection.sourceType}`}
          type="button"
          className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() =>
            onSelectFilter?.({
              eventSlug: rejection.eventSlug,
              sourceType: rejection.sourceType,
              rejectionReason: rejection.rejectionReason,
            })
          }
        >
          <span className="min-w-0">
            <span className="block truncate font-medium text-sm">
              {rejection.rejectionReason ?? "unknown_reason"}
            </span>
            <span className="block truncate font-mono text-muted-foreground text-xs">
              {rejection.eventSlug} / {rejection.sourceType}
              {rejection.sourceCount > 1 ? ` · ${rejection.sourceCount} sources` : null}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Badge variant="warning">{rejection.eventCount}</Badge>
            <ArrowRight className="size-4 text-muted-foreground" />
          </span>
        </button>
      ))}
    </EvidenceFrame>
  )
}

type VisibleRejectionGroup = IngestionRejection & {
  sourceCount: number
}

function groupVisibleRejections(rejections: IngestionRejection[]): VisibleRejectionGroup[] {
  const groups = new Map<
    string,
    Omit<VisibleRejectionGroup, "sourceCount"> & { sourceIds: Set<string> }
  >()

  for (const rejection of rejections) {
    const key = [
      rejection.rejectionReason ?? "unknown",
      rejection.eventSlug,
      rejection.sourceType,
    ].join(":")
    const group = groups.get(key)

    if (!group) {
      groups.set(key, {
        ...rejection,
        sourceIds: new Set([rejection.sourceId]),
      })
      continue
    }

    group.eventCount += rejection.eventCount
    group.lastSeenAt = Math.max(group.lastSeenAt, rejection.lastSeenAt)
    group.sourceIds.add(rejection.sourceId)
  }

  return Array.from(groups.values())
    .map(({ sourceIds, ...group }) => ({
      ...group,
      sourceCount: sourceIds.size,
    }))
    .sort((a, b) => b.eventCount - a.eventCount || b.lastSeenAt - a.lastSeenAt)
}
