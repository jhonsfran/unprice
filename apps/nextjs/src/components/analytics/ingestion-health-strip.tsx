"use client"

import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { AlertTriangle, CheckCircle2, CircleSlash, ShieldAlert, XCircle } from "lucide-react"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { EvidenceMetricStrip, EvidenceMetricTile, EvidenceSection } from "./evidence-panel"
import {
  type IngestionStatus,
  formatSuccessRate,
  getActionMessages,
  getAttentionCount,
  getEnforcementLabel,
  getEnforcementTone,
  getPipelineLabel,
  getPipelineTone,
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
  const pipelineTone = getPipelineTone(status)
  const enforcementTone = getEnforcementTone(status)
  const successTone = getSuccessTone(status)
  const attentionCount = getAttentionCount(status)
  const actionMessages = getActionMessages(status, { showNoEventsAction })
  const metrics = (
    <EvidenceMetricStrip className="md:grid-cols-5">
      <EvidenceMetricTile
        label="Success"
        value={formatSuccessRate(status.successRate)}
        helper="processed / total"
        tone={successTone}
        icon={<CheckCircle2 className="size-4" />}
      />
      <EvidenceMetricTile
        label="Processed"
        value={<NumberTicker value={status.totals.processed} decimalPlaces={0} startValue={0} />}
        helper="accepted events"
        tone="success"
        icon={<CheckCircle2 className="size-4" />}
      />
      <EvidenceMetricTile
        label="Rejected"
        value={<NumberTicker value={status.totals.rejected} decimalPlaces={0} startValue={0} />}
        helper="business denials"
        tone={status.totals.rejected > 0 ? "warning" : "default"}
        icon={<CircleSlash className="size-4" />}
      />
      <EvidenceMetricTile
        label="Failed"
        value={<NumberTicker value={status.totals.failed} decimalPlaces={0} startValue={0} />}
        helper="system failures"
        tone={status.totals.failed > 0 ? "destructive" : "default"}
        icon={<XCircle className="size-4" />}
      />
      <EvidenceMetricTile
        label="Attention"
        value={<NumberTicker value={attentionCount} decimalPlaces={0} startValue={0} />}
        helper="rejected + failed"
        tone={attentionCount > 0 ? "warning" : "success"}
        icon={<AlertTriangle className="size-4" />}
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
      <EvidenceSection
        title={title}
        description={description}
        badges={
          <>
            <Badge variant={pipelineTone}>{getPipelineLabel(status)}</Badge>
            <Badge variant={enforcementTone}>{getEnforcementLabel(status)}</Badge>
          </>
        }
        actions={
          <FreshnessIndicator generatedAt={status.freshness.generatedAt} isFetching={isFetching} />
        }
        isRefreshing={isFetching}
        className={className}
      >
        {metrics}
        {actionPanel}
      </EvidenceSection>
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
              <Badge variant={pipelineTone}>{getPipelineLabel(status)}</Badge>
              <Badge variant={enforcementTone}>{getEnforcementLabel(status)}</Badge>
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
