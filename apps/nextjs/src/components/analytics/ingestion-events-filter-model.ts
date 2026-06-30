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
      state: "rejected",
      eventSlug: rejection.eventSlug,
      sourceId: rejection.sourceId,
    },
    search: rejection.eventSlug,
    label: `${rejection.eventSlug} / ${rejection.sourceType}`,
  }
}

export function getSelectedIngestionQueryFilter(
  selectedFilter: SelectedIngestionFilter | null
): IngestionQueryFilter {
  return selectedFilter?.query ?? {}
}
