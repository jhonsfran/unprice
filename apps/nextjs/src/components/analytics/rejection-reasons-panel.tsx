"use client"

import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
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
  if (presentation === "section") {
    return (
      <EvidenceSection
        title="Top rejection reasons"
        description="Business denials grouped by reason, event, and operation."
        className={className}
        contentClassName="mt-3"
        titleClassName="text-base"
      >
        <RejectionReasonsList rejections={rejections} onSelectFilter={onSelectFilter} />
      </EvidenceSection>
    )
  }

  return (
    <Card className={cn("border-muted/60", className)}>
      <CardHeader>
        <CardTitle>Top rejection reasons</CardTitle>
        <CardDescription>Business denials grouped by reason, event, and operation.</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        <RejectionReasonsList rejections={rejections} onSelectFilter={onSelectFilter} unframed />
      </CardContent>
    </Card>
  )
}

function RejectionReasonsList({
  rejections,
  onSelectFilter,
  unframed = false,
}: {
  rejections: IngestionRejection[]
  onSelectFilter?: (filter: RejectionReasonSelection) => void
  unframed?: boolean
}) {
  if (rejections.length === 0) {
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
      {rejections.slice(0, 5).map((rejection) => (
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
