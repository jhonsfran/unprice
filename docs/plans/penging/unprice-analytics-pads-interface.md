# Analytics Pads Interface Contract

This document defines the interface for future call-pad and audit-pad UI work.
Pads must compose existing analytics evidence paths instead of inventing new
data paths.

## Context

```typescript
type AnalyticsPadContext = {
  workspaceId: string
  projectId: string
  customerId?: string
  invoiceId?: string
  entryId?: string
  eventId?: string
  periodKey?: string
  sourceId?: string
  fromTs?: number
  toTs?: number
}
```

The context is a routing and scoping object. A pad may receive partial context
from a dashboard, support workflow, invoice view, or event drilldown, then call
the relevant analytics endpoint with the fields it can prove.

## Data Sources

Pads must use these sources:

- `POST /v1/analytics/ingestion/status` for live ingestion health, rejection
  breakdowns, recent events, source filters, and customer time windows.
- `POST /v1/analytics/explain-charge` for invoice-line explanations backed by
  ledger metadata and rated meter facts.
- Future raw event lookup backed directly by R2 Data Catalog or R2 SQL. This
  must not use or recreate the deleted Lakehouse file-plan API.

## Non-Goals

This contract does not implement pad UI, natural-language query generation, or
free-form SQL execution. Those can be designed later on top of the stable
evidence contracts above.
