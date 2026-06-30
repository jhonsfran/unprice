import type { RouterInputs, RouterOutputs } from "@unprice/trpc/routes"

export type IngestionStatus = RouterOutputs["analytics"]["getIngestionStatus"]
export type IngestionRejection = IngestionStatus["rejections"][number]

export type IngestionQueryFilter = NonNullable<
  RouterInputs["analytics"]["getIngestionStatus"]["filter"]
>

export type IngestionTone = "default" | "success" | "warning" | "destructive"

const NON_ACTION_MESSAGES = new Set(["No immediate action required."])

type ActionMessageOptions = {
  showNoEventsAction?: boolean
}

export function formatSuccessRate(successRate: number): string {
  return `${(successRate * 100).toFixed(1)}%`
}

export function getAttentionCount(status: Pick<IngestionStatus, "totals">): number {
  return status.totals.rejected + status.totals.failed
}

export function getPipelineTone(status: Pick<IngestionStatus, "totals">): IngestionTone {
  if (status.totals.total === 0) {
    return "default"
  }

  if (status.totals.failed > 0) {
    return "destructive"
  }

  return "success"
}

export function getPipelineLabel(status: Pick<IngestionStatus, "totals">): string {
  if (status.totals.total === 0) {
    return "no events"
  }

  if (status.totals.failed > 0) {
    return "pipeline failing"
  }

  return "pipeline healthy"
}

export function getEnforcementTone(status: Pick<IngestionStatus, "totals">): IngestionTone {
  if (status.totals.rejected > 0) {
    return "warning"
  }

  return "default"
}

export function getEnforcementLabel(status: Pick<IngestionStatus, "totals">): string {
  if (status.totals.rejected > 0) {
    return "business denials"
  }

  return "no denials"
}

export function getActionMessages(
  status: Pick<IngestionStatus, "nextActions" | "totals">,
  { showNoEventsAction = true }: ActionMessageOptions = {}
): string[] {
  if (!showNoEventsAction && status.totals.total === 0) {
    return []
  }

  return status.nextActions.filter((message) => !NON_ACTION_MESSAGES.has(message))
}

export function getSuccessTone(
  status: Pick<IngestionStatus, "successRate" | "totals">
): IngestionTone {
  if (status.totals.total === 0) {
    return "default"
  }

  if (status.totals.failed > 0) {
    return "destructive"
  }

  if (status.totals.rejected > 0 || status.successRate < 0.99) {
    return "warning"
  }

  return "success"
}
