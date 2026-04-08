# Phase 10: Compound Metering & Cost Attribution

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add compound metering and cost attribution`  
Branch: `feat/compound-metering`

## Mission

Support multi-dimensional metering where a single event produces billing facts
for multiple dimensions (e.g., input tokens, output tokens, compute time). Add
cost-to-serve tracking alongside charges to enable per-customer and per-feature
margin analysis.

## Dependencies

- Phase 6 for agent billing pipeline
- Phase 7 for credit burn rates (per-dimension burn rate multipliers)

## Why This Phase Exists

- AI workloads have multiple cost dimensions: input tokens, output tokens, cached
  tokens, thinking tokens, tool calls, compute time — each priced differently
- the current model is one meter per feature slug, one event per meter
- forcing developers to send separate events per dimension is fragile and noisy
- AI gross margins are 50-60% vs 80-90% for traditional SaaS — margin visibility
  is critical for pricing decisions
- per-customer cost attribution enables identification of negative-margin
  customers before they become a financial problem
- cost tables with effective dates handle rapid AI price deflation (~10x/year)

## Read First

- [../../internal/db/src/validators/shared.ts](../../internal/db/src/validators/shared.ts)
- [../../internal/services/src/entitlements/engine.ts](../../internal/services/src/entitlements/engine.ts)
- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
- [../../internal/services/src/rating/service.ts](../../internal/services/src/rating/service.ts)
- [../../internal/db/src/schema/credit-burn-rates.ts](../../internal/db/src/schema/credit-burn-rates.ts)
- [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md)
- [./unprice-phase-07-credits-wallets.md](./unprice-phase-07-credits-wallets.md)

## Guardrails

- Do not introduce TypeScript `any` types.
- Compound meters produce multiple facts from one event. Each fact is
  independent and enters the same pipeline as a single-dimension fact.
- Do not change the behavior of existing single-dimension meters. Compound
  metering is additive.
- Cost data is optional and informational. Missing cost data must never block
  billing.
- Keep the `EntitlementWindowDO` as the single metering authority. Compound
  fan-out happens inside the DO, not downstream.

## Primary Touchpoints

- `internal/db/src/validators/shared.ts` — extend `meterConfigSchema`
- `internal/db/src/schema/cost-tables.ts` — new
- `internal/db/src/validators/cost-tables.ts` — new
- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` — compound fan-out
- `internal/services/src/entitlements/engine.ts` — multi-dimension aggregation
- `internal/services/src/rating/service.ts` — per-dimension rating
- `packages/api/src/openapi.d.ts` — SDK types
- dashboard UI: compound meter config, cost table editor, margin dashboard

## Execution Plan

### Slice 1: Extend meter config for compound meters

Add to `meterConfigSchema` in `internal/db/src/validators/shared.ts`:

```typescript
compoundMeters: z.array(z.object({
  // dimension name, e.g. "input_tokens", "output_tokens", "compute_seconds"
  dimension: z.string().min(1),
  // how to aggregate this dimension
  aggregationMethod: aggregationMethodSchema,
  // which event property to aggregate
  aggregationField: z.string().min(1),
  // optional: different burn rate multiplier per dimension
  // e.g. output tokens cost 3x input tokens
  burnRateMultiplier: z.number().positive().default(1),
})).optional(),
```

Validation rules:

- `compoundMeters` is optional. If absent, the meter works as before (single
  dimension).
- If `compoundMeters` is present, each dimension must have a unique `dimension`
  name.
- Each dimension's `aggregationField` must be present in the event properties
  (validated at ingestion time, not at config time).
- `burnRateMultiplier` adjusts how many credits this dimension consumes relative
  to the base burn rate.

### Slice 2: Compound fan-out in EntitlementWindowDO

When a meter has `compoundMeters`, the DO's `apply()` method produces one
`AnalyticsEntitlementMeterFact` per dimension per event.

Each fact carries:

- `dimension: string` — which compound dimension this fact represents
- `delta` — the incremental change for this dimension
- `valueAfter` — the cumulative value for this dimension

The DO maintains separate aggregation state per dimension in its SQLite tables.
The meter key derivation in `AsyncMeterAggregationEngine` extends to include
the dimension name.

Existing single-dimension meters are unaffected — they continue to produce one
fact per event with `dimension: null`.

### Slice 3: Per-dimension rating

Update `RatingService.rateIncrementalUsage()` to handle compound facts:

- For each dimension fact, compute the marginal price independently
- Apply the `burnRateMultiplier` to the credit cost
- The total charge for a compound event is the sum of all dimension charges
- Post one ledger debit per event (not per dimension) with the total charge.
  The dimension breakdown is stored in the ledger entry metadata for
  auditability.

### Slice 4: Cost table schema

Create `internal/db/src/schema/cost-tables.ts`:

```
cost_tables(
  id, projectId,
  featureSlug,            -- which feature this cost applies to
  dimension,              -- nullable; for compound meters, which dimension
  costPerUnitCents,       -- cost to serve 1 unit of this feature/dimension
  effectiveAt,            -- when this cost rate takes effect
  supersededAt,           -- when replaced by a newer rate (null = current)
  createdAt
)
```

Cost tables are versioned the same way as credit burn rates: changing a cost
creates a new row and supersedes the old one.

Add validators and export from barrels. Run migration.

### Slice 5: Cost metadata on meter facts

Add optional fields to `AnalyticsEntitlementMeterFact`:

- `cost_cents: number | null` — estimated cost-to-serve for this usage
- `cost_source: string | null` — how cost was determined
  (`"cost_table"`, `"manual"`, etc.)

When a cost table exists for the feature and dimension, the DO populates
`cost_cents` on the fact using the current effective cost rate. When no cost
table exists, `cost_cents` is null (cost tracking is optional).

Cost data flows to Tinybird alongside the regular fact fields.

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

### Slice 7: API endpoints

New routes:

- `GET /v1/analytics/margins?customerId=X&period=...` — margin summary
- `POST /v1/cost-tables` — create or update a cost table entry
- `GET /v1/cost-tables?featureSlug=X` — list cost table entries

Update `packages/api/` OpenAPI types.

DX note: developers report a single event with all dimensions in properties.
The meter config handles fan-out — no need to send separate events.

```typescript
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
// Compound meter automatically produces facts for each configured dimension
```

### Slice 8: UI

**Compound meter configuration:**

- On the feature/meter config page, add a "Dimensions" section when compound
  metering is enabled
- Each dimension row: name, aggregation method, property field,
  burn rate multiplier
- Add/remove dimension rows dynamically
- Visual preview: "Each event produces billing facts for: [dim1] (sum of
  input_tokens, 1x), [dim2] (sum of output_tokens, 3x), ..."

**Cost table management:**

- Per-feature cost editor with effective date picker
- For compound meters: per-dimension cost entries
- History view showing cost rate changes over time
- Visual indicator of current vs superseded rates

**Margin dashboard:**

- Per-customer profitability chart: revenue vs cost over time
- Per-feature profitability breakdown
- Margin alerts: highlight customers below configurable threshold (e.g., below
  60% margin)
- Aggregate margin trend across all customers

**Feature usage breakdown:**

- For compound meters: show usage across dimensions (e.g., input vs output
  tokens) as a stacked chart
- Per-dimension cost contribution

### Slice 9: Tests

Cover:

- single event → multiple facts (one per dimension)
- per-dimension aggregation state in DO
- per-dimension rating with burn rate multipliers
- total charge = sum of dimension charges
- compound meter + single-dimension meter coexistence
- cost table effective date versioning
- cost metadata on facts when cost table exists
- null cost when no cost table (graceful degradation)
- margin calculation accuracy
- compound meter + outcome meter interaction (outcome DO produces compound
  aggregated facts)
- dimension validation at ingestion time (missing property → skip dimension,
  don't fail event)

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`
- `pnpm --filter @unprice/api typecheck`

## Exit Criteria

- compound meters can be configured with multiple dimensions per feature
- a single event produces one billing fact per configured dimension
- per-dimension rating and burn rate multipliers work correctly
- cost tables track cost-to-serve with effective date versioning
- cost metadata flows through to analytics
- margin analytics are available per customer and per feature
- SDK and API support compound meter events without developer-side fan-out
- dashboard shows compound meter configuration, cost management, and margin
  analytics

## Out Of Scope

- automatic cost discovery from provider invoices
- ML-based margin prediction
- cost allocation for shared infrastructure (only direct per-unit costs)
- cost-based pricing recommendations
