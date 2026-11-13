"use client"

import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { CheckCircle2, CircleSlash, ShieldAlert } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { EvidenceMetricStrip, EvidenceMetricTile, EvidenceSection } from "./evidence-panel"
import {
  type IngestionStatus,
  formatSuccessRate,
  getActionMessages,
  getEnforcementLabel,
  getEnforcementTone,
  getSuccessTone,
} from "./ingestion-health-model"

type IngestionHealthStripProps = {
  status: IngestionStatus
  isFetching?: boolean
  title: string
  description: string
  className?: string
  presentation?: "card" | "section"
  showNoEventsAction?: boolean
}

export function IngestionHealthStrip({
  status,
  isFetching = false,
  title,
  description,
  className,
  presentation = "card",
  showNoEventsAction = true,
}: IngestionHealthStripProps) {
  const enforcementTone = getEnforcementTone(status)
  const successTone = getSuccessTone(status)
  const processedCount = status.totals.processed
  const rejectedCount = status.totals.rejected
  const actionMessages = getActionMessages(status, { showNoEventsAction })
  const enforcementLabel = getEnforcementLabel(status)
  const isEmptyWindow = status.totals.total === 0
  const metrics = isEmptyWindow ? (
    <div className="flex items-center gap-2 rounded-md border border-dashed px-4 py-3 text-muted-foreground text-sm">
      <CircleSlash className="size-4 shrink-0" />
      <span>No events in this window. Health tiles appear once traffic arrives.</span>
    </div>
  ) : (
    <EvidenceMetricStrip className="md:grid-cols-3">
      <EvidenceMetricTile
        label="Success"
        value={formatSuccessRate(status.successRate)}
        helper="processed / total"
        tone={successTone}
        icon={<CheckCircle2 className="size-4" />}
      />
      <EvidenceMetricTile
        label="Processed"
        value={
          <NumberTicker value={processedCount} decimalPlaces={0} startValue={processedCount} />
        }
        helper="accepted events"
        tone="success"
        icon={<CheckCircle2 className="size-4" />}
      />
      <EvidenceMetricTile
        label="Rejected"
        value={<NumberTicker value={rejectedCount} decimalPlaces={0} startValue={rejectedCount} />}
        helper="business denials"
        tone={status.totals.rejected > 0 ? "warning" : "default"}
        icon={<CircleSlash className="size-4" />}
      />
    </EvidenceMetricStrip>
  )
  const actionPanel =
    actionMessages.length > 0 ? (
      <div className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
        {actionMessages.map((message) => (
          <div key={message} className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span>{message}</span>
          </div>
        ))}
      </div>
    ) : null

  if (presentation === "section") {
    return (
      <IngestionHealthEvidenceSection
        status={status}
        isFetching={isFetching}
        title={title}
        description={description}
        className={className}
      >
        {metrics}
        {actionPanel}
      </IngestionHealthEvidenceSection>
    )
  }

  return (
    <Card className={cn("overflow-hidden border-muted/60", className)}>
      <div
        className={cn(
          "pointer-events-none h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent transition-opacity duration-300 motion-reduce:transition-none",
          isFetching ? "opacity-100" : "opacity-0"
        )}
      />
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{title}</CardTitle>
              <Badge variant={enforcementTone}>{enforcementLabel}</Badge>
            </div>
            <CardDescription>{description}</CardDescription>
          </div>
          <FreshnessIndicator generatedAt={status.freshness.generatedAt} isFetching={isFetching} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-6">
        {metrics}
        {actionPanel}
      </CardContent>
    </Card>
  )
}

function IngestionHealthEvidenceSection({
  status,
  isFetching,
  title,
  description,
  className,
  children,
}: {
  status: IngestionStatus
  isFetching: boolean
  title: string
  description: string
  className?: string
  children: ReactNode
}) {
  const enforcementTone = getEnforcementTone(status)
  const enforcementLabel = getEnforcementLabel(status)
  const badges = useMemo(
    () => <Badge variant={enforcementTone}>{enforcementLabel}</Badge>,
    [enforcementLabel, enforcementTone]
  )
  const actions = useMemo(
    () => <FreshnessIndicator generatedAt={status.freshness.generatedAt} isFetching={isFetching} />,
    [isFetching, status.freshness.generatedAt]
  )

  return (
    <EvidenceSection
      title={title}
      description={description}
      badges={badges}
      actions={actions}
      isRefreshing={isFetching}
      className={className}
    >
      {children}
    </EvidenceSection>
  )
}
