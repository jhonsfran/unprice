import type { IngestionQueryFilter, IngestionRejection } from "./ingestion-health-model"

export type SelectedIngestionFilter = {
  query: IngestionQueryFilter
  search: string | null
  label: string
}

export function buildSelectedRejectionFilter(
  rejection: IngestionRejection
): SelectedIngestionFilter {
  return {
    query: {
      states: ["rejected"],
      eventSlugs: [rejection.eventSlug],
      sourceTypes: [rejection.sourceType],
      ...(rejection.rejectionReason ? { rejectionReasons: [rejection.rejectionReason] } : {}),
    },
    search: null,
    label: `${rejection.eventSlug} / ${rejection.sourceType}`,
  }
}

export function getSelectedIngestionQueryFilter(
  selectedFilter: SelectedIngestionFilter | null
): IngestionQueryFilter {
  return selectedFilter?.query ?? {}
}
