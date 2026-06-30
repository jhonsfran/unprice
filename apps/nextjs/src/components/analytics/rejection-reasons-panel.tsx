"use client"

import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { ArrowRight } from "lucide-react"
import {
  type SelectedIngestionFilter,
  buildSelectedRejectionFilter,
} from "./ingestion-events-filter-model"
import type { IngestionRejection } from "./ingestion-health-model"

type RejectionReasonsPanelProps = {
  rejections: IngestionRejection[]
  onSelectFilter?: (filter: SelectedIngestionFilter) => void
}

export function RejectionReasonsPanel({ rejections, onSelectFilter }: RejectionReasonsPanelProps) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Top rejection reasons</CardTitle>
        <CardDescription>Business denials grouped by reason, event, and source.</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        {rejections.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed text-muted-foreground text-sm">
            No rejected events in this window.
          </div>
        ) : (
          <div className="divide-y rounded-md border">
            {rejections.slice(0, 5).map((rejection) => (
              <button
                key={`${rejection.rejectionReason ?? "unknown"}:${rejection.eventSlug}:${rejection.sourceId}`}
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelectFilter?.(buildSelectedRejectionFilter(rejection))}
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
          </div>
        )}
      </CardContent>
    </Card>
  )
}
