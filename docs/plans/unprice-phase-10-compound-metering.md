# Phase 10: Multi-Dimensional Pricing & Cost Attribution

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: multi-dimensional pricing display and cost attribution`  
Branch: `feat/compound-metering`

## Mission

Unlock the multi-dimensional pricing capability that the data model already
supports by adding event-level grouping for display/invoicing, batch
verification convenience, and cost-to-serve tracking for margin analysis.

## Key Insight: The Model Already Supports Multi-Dimensional Pricing

After reviewing the codebase, the existing architecture already handles the
core mechanics of multi-dimensional pricing:

1. **Events** carry multiple properties (`availableProperties` on the events
   table — e.g., `["input_tokens", "output_tokens", "tool_calls"]`).
2. **Features** are created per dimension, each with its own `meterConfig`
   pointing to the same event via `eventSlug` but with a different
   `aggregationField`.
3. **Ingestion routing** already fans out: `filterProcessableResolvedStates`
   in `state-resolution-service.ts:125` matches every resolved state whose
   `meterConfig.eventSlug === message.slug`, so one event naturally routes to
   all dimension features.
4. **Each feature has independent limits, grants, and pricing** — there is no
   shared "event limit." A customer can exhaust output tokens while having
   plenty of input token budget.
5. **No atomicity concern** — the event already happened (the LLM call was
   made). Usage reporting records reality; it doesn't gate a hypothetical.
   Limit enforcement happens before the next API call, not retroactively.

What is **not** needed:
- A `compoundMeters` field on `meterConfigSchema` — separate features per
  dimension is the correct model.
- Fan-out inside the EntitlementWindowDO — fan-out already happens at the
  routing layer. Each dimension gets its own DO instance.
- Per-dimension rating changes — each feature is already rated independently
  with its own pricing config (`featureType`, `config`, `usageMode`).

What **is** needed:
- Display grouping by shared event for dashboards and invoices.
- Batch verify/ingest convenience endpoints to reduce round-trips.
- Cost tables and margin analytics for AI cost visibility.

## Dependencies

- Phase 6 for agent billing pipeline
- Phase 7 for credit burn rates (per-dimension burn rate multipliers)

## Why This Phase Exists

- AI workloads have multiple cost dimensions priced differently — the model
  supports this, but the UX doesn't surface it clearly
- customers see N unrelated line items instead of grouped dimensions under a
  single product (e.g., "AI Completions")
- SDK callers must verify N features individually when they could batch-verify
  by event slug
- AI gross margins are 50-60% vs 80-90% for traditional SaaS — margin
  visibility is critical for pricing decisions
- per-customer cost attribution enables identification of negative-margin
  customers before they become a financial problem
- cost tables with effective dates handle rapid AI price deflation (~10x/year)

## Read First

- [../../internal/db/src/validators/shared.ts](../../internal/db/src/validators/shared.ts) — `meterConfigSchema`
- [../../internal/services/src/ingestion/state-resolution-service.ts](../../internal/services/src/ingestion/state-resolution-service.ts) — event-to-feature fan-out
- [../../internal/services/src/ingestion/service.ts](../../internal/services/src/ingestion/service.ts) — `verifyFeatureStatus`, `ingestFeatureSync`
- [../../internal/services/src/entitlements/service.ts](../../internal/services/src/entitlements/service.ts) — `buildUsageResponse`, display grouping
- [../../internal/services/src/ingestion/message.ts](../../internal/services/src/ingestion/message.ts) — `filterResolvedStatesWithValidAggregationPayload`
- [../../apps/api/src/routes/customer/verifyV1.ts](../../apps/api/src/routes/customer/verifyV1.ts) — current verify endpoint
- [../../internal/db/src/schema/events.ts](../../internal/db/src/schema/events.ts) — events table
- [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md)
- [./unprice-phase-07-credits-wallets.md](./unprice-phase-07-credits-wallets.md)

## Guardrails

- Do not introduce TypeScript `any` types.
- Do not change the behavior of existing single-feature metering, verification,
  or ingestion. All changes are additive.
- The `meterConfig.eventSlug` is the natural grouping key — do not introduce a
  new `featureGroup` table or entity. Grouping is a query-time concern.
- Cost data is optional and informational. Missing cost data must never block
  billing.
- Each feature/dimension retains independent limits, grants, and pricing.
  There is no cross-dimension limit enforcement.
- The `hidden` flag on feature metadata lets customers control which dimensions
  appear in their UI. Respect it in all display contexts.

## Primary Touchpoints

- `internal/services/src/entitlements/service.ts` — display grouping in
  `buildUsageResponse`
- `internal/services/src/ingestion/service.ts` — new `verifyEventStatus`,
  `ingestEventSync` methods
- `apps/api/src/routes/customer/` — new batch verify/ingest endpoints
- `internal/db/src/schema/cost-tables.ts` — new
- `internal/db/src/validators/cost-tables.ts` — new
- `internal/services/src/billing/` — margin analytics
- `packages/api/src/openapi.d.ts` — SDK types
- dashboard UI: event-grouped usage display, cost table editor, margin
  dashboard

## Execution Plan

### Slice 1: Display grouping by event slug

**Goal:** Customers see related dimensions grouped together on the dashboard
and invoices instead of N unrelated line items.

In `EntitlementService.buildUsageResponse` (`entitlements/service.ts:729`),
the current code hardcodes a single group:

```typescript
groups: [{ id: "all-features", name: "Features", ... }]
```

Replace with grouping by `meterConfig.eventSlug`:

```typescript
const featuresByEvent = new Map<string, typeof features>()
for (const f of features) {
  const eventSlug = f.entitlement.meterConfig?.eventSlug ?? "__platform__"
  const group = featuresByEvent.get(eventSlug) ?? []
  featuresByEvent.set(eventSlug, [...group, f])
}
```

Each event slug becomes a group. Features without a meter (flat features) go
in a "__platform__" group. Use the Event's `name` field for the group display
name (requires a join or cache lookup to `events` table).

Respect the `hidden` metadata flag — hidden features are still in the group
but marked `hidden: true` so the UI can toggle visibility.

**Files:**
- `internal/services/src/entitlements/service.ts` — `buildUsageResponse`,
  `buildFeatureDisplay`
- `internal/db/src/validators/entitlements.ts` — add `hidden` to
  `featureDisplaySchema` variants

**Invoice rendering:** Each group becomes a line-item section:

```
AI Completions
  Input tokens:  1.2M x $3.00/M  = $3.60
  Output tokens: 400K x $15.00/M = $6.00
  Tool calls:    52 x $0.01      = $0.52
                        Subtotal  = $10.12
```

### Slice 2: Batch verify by event slug

**Goal:** SDK callers verify all dimensions of an event in one round-trip.

Add `verifyEventStatus` to `IngestionService`:

```typescript
public async verifyEventStatus(params: {
  customerId: string
  eventSlug: string
  projectId: string
  timestamp: number
}): Promise<EventVerificationResult>
```

Implementation:
1. Call `prepareCustomerGrantContext` (existing, cached).
2. Call `grantsManager.resolveIngestionStatesFromGrants` (existing) to get all
   resolved states for the customer.
3. Filter to states where `meterConfig.eventSlug === eventSlug`.
4. For each matching state, call `getEnforcementState` on the
   EntitlementWindowDO (existing).
5. Return per-feature results. Top-level `allowed` is the AND of all
   dimensions — if any dimension is denied, the event should not be attempted.

Response shape:

```typescript
type EventVerificationResult = {
  allowed: boolean
  deniedBy?: string        // featureSlug that caused denial
  eventSlug: string
  features: Array<{
    featureSlug: string
    allowed: boolean
    usage?: number
    limit?: number | null
    isLimitReached?: boolean
    overageStrategy?: string
    hidden?: boolean
  }>
}
```

**No atomicity/rollback needed.** Each dimension is independently limited.
The top-level `allowed` is a convenience AND — the caller uses it to decide
whether to make the API call. If one dimension is denied, the whole event
is denied because the underlying operation (e.g., LLM call) would produce
usage across all dimensions.

**Files:**
- `internal/services/src/ingestion/service.ts` — new method
- `internal/services/src/ingestion/interface.ts` — new type
- `apps/api/src/routes/customer/verifyEventV1.ts` — new route

### Slice 3: Event-level sync ingest

**Goal:** Report usage for all dimensions of an event in one call.

Add `ingestEventSync` to `IngestionService`:

```typescript
public async ingestEventSync(params: {
  eventSlug: string
  message: IngestionQueueMessage
}): Promise<EventIngestSyncResult>
```

Implementation:
1. Reuse `prepareCustomerGrantContext` (existing).
2. Call `resolveIngestionStatesFromGrants` (existing) — gets all states.
3. Filter by `eventSlug` and valid aggregation payload (existing helpers:
   `filterResolvedStatesWithValidAggregationPayload`).
4. Apply each matching state to its EntitlementWindowDO (existing
   `applyResolvedState`). Use `enforceLimit: true` for all dimensions.
5. If any dimension is denied (LIMIT_EXCEEDED), return denied with the
   specific feature that caused it. The other dimensions' apply calls
   still went through — this is acceptable because the event already
   happened (the usage is real) and each dimension has independent limits.

The existing per-feature `ingestFeatureSync` continues to work for
single-dimension features.

**Files:**
- `internal/services/src/ingestion/service.ts` — new method
- `internal/services/src/ingestion/interface.ts` — new types
- `apps/api/src/routes/customer/reportUsageV1.ts` — extend or new route

### Slice 4: Cost table schema

Create `internal/db/src/schema/cost-tables.ts`:

```
cost_tables(
  id, projectId,
  featureSlug,            -- which feature this cost applies to
  costPerUnitCents,       -- cost to serve 1 unit of this feature
  effectiveAt,            -- when this cost rate takes effect
  supersededAt,           -- when replaced by a newer rate (null = current)
  createdAt
)
```

Cost tables are versioned: changing a cost creates a new row and supersedes
the old one. No `dimension` column needed — each dimension is already a
separate feature with its own slug.

Add validators and export from barrels. Run migration.

**Files:**
- `internal/db/src/schema/cost-tables.ts` — new
- `internal/db/src/validators/cost-tables.ts` — new
- `internal/db/src/migrations/` — new migration

### Slice 5: Cost metadata on meter facts

Add optional fields to `AnalyticsEntitlementMeterFact`:

- `cost_cents: number | null` — estimated cost-to-serve for this usage
- `cost_source: string | null` — how cost was determined
  (`"cost_table"`, `"manual"`, etc.)

When a cost table exists for the feature slug, the EntitlementWindowDO
populates `cost_cents` on the fact using the current effective cost rate.
When no cost table exists, `cost_cents` is null (cost tracking is optional).

Cost data flows to Tinybird alongside the regular fact fields.

**Files:**
- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` — cost lookup
- analytics schema — new columns

### Slice 6: Margin analytics service

Add methods to an analytics service or create a new one:

- `getCustomerMargin(projectId, customerId, periodStart, periodEnd)` — returns
  `{ revenueCents, costCents, marginCents, marginPercent }` computed from
  ledger debits and cost-annotated facts
- `getFeatureMargin(projectId, featureSlug, periodStart, periodEnd)` — same,
  grouped by feature
- `getMarginAlerts(projectId, threshold)` — list customers with margin below
  threshold

Margin = revenue (from ledger debits) - cost (from cost facts for the same
period). Revenue comes from the ledger. Cost comes from Tinybird aggregation
of cost-annotated facts.

Event-level grouping: margin can be viewed per event (summing all dimension
features that share the same `eventSlug`) or per individual feature.

### Slice 7: API endpoints

New routes:

- `POST /v1/customer/verify-event` — batch verify all dimensions of an event
  (Slice 2)
- `POST /v1/customer/report-event` — batch report usage for all dimensions
  (Slice 3)
- `GET /v1/analytics/margins?customerId=X&period=...` — margin summary
  (Slice 6)
- `POST /v1/cost-tables` — create or update a cost table entry (Slice 4)
- `GET /v1/cost-tables?featureSlug=X` — list cost table entries (Slice 4)

Update `packages/api/` OpenAPI types.

DX note: developers report a single event with all dimensions in properties.
The ingestion routing handles fan-out — no need to send separate events per
dimension.

```typescript
// Single event, multiple dimensions — already works today
await unprice.events.ingest({
  slug: "llm_completion",
  properties: {
    input_tokens: 150,
    output_tokens: 300,
    cached_tokens: 50,
    model: "gpt-4o",
    duration_ms: 2300
  }
})
// Each feature with meterConfig.eventSlug === "llm_completion" picks up
// its own aggregationField from the properties

// NEW: batch verify before the LLM call
const { allowed, deniedBy, features } = await unprice.events.verify({
  customerId: "cus_xxx",
  eventSlug: "llm_completion",
})
// allowed = AND of all dimension checks
// deniedBy = which feature slug caused denial (if any)
// features = per-dimension breakdown with usage, limit, remaining
```

### Slice 8: UI

**Event-grouped usage display:**

- On the customer usage dashboard, group features by their shared
  `meterConfig.eventSlug` instead of showing a flat list
- Each group shows a header (event name), per-dimension usage bars, and a
  group subtotal
- Respect the `hidden` metadata flag — hidden dimensions are collapsed by
  default but can be expanded
- Features without a meter (flat features) appear in a separate
  "Platform" section

**Cost table management:**

- Per-feature cost editor with effective date picker
- History view showing cost rate changes over time
- Visual indicator of current vs superseded rates

**Margin dashboard:**

- Per-customer profitability chart: revenue vs cost over time
- Per-feature profitability breakdown (with event-level grouping)
- Margin alerts: highlight customers below configurable threshold (e.g.,
  below 60% margin)
- Aggregate margin trend across all customers

### Slice 9: Tests

Cover:

- display grouping: features sharing the same eventSlug appear in the same
  group in `getCurrentUsage` response
- display grouping: features without meters go in a separate group
- display grouping: hidden features have `hidden: true` in output
- batch verify: returns per-feature results with correct usage/limits
- batch verify: top-level `allowed` is false if any dimension is denied
- batch verify: `deniedBy` correctly identifies the blocking feature
- event-level ingest: single message fans out to all matching features
- event-level ingest: each dimension applies independently to its own DO
- cost table effective date versioning
- cost metadata on facts when cost table exists
- null cost when no cost table (graceful degradation)
- margin calculation accuracy
- existing single-feature verify and ingest still work unchanged

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`
- `pnpm --filter @unprice/api typecheck`

## Exit Criteria

- features sharing the same `meterConfig.eventSlug` are grouped together in
  the usage dashboard and invoice rendering
- batch verify endpoint returns per-dimension status for all features of an
  event in one round-trip
- batch ingest endpoint reports usage across all dimensions of an event
- cost tables track cost-to-serve with effective date versioning
- cost metadata flows through to analytics
- margin analytics are available per customer and per feature
- existing single-feature verify and ingest remain unchanged
- SDK supports event-level verify and ingest alongside feature-level

## Out Of Scope

- automatic cost discovery from provider invoices
- ML-based margin prediction
- cost allocation for shared infrastructure (only direct per-unit costs)
- cost-based pricing recommendations
- cross-dimension limit enforcement (dimensions are independent)
- compound fan-out inside the EntitlementWindowDO (fan-out happens at the
  routing layer)
