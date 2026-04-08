# Phase 9: Outcome-Based Pricing & Trace Aggregation

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add outcome-based pricing and trace aggregation`  
Branch: `feat/outcome-pricing`

## Mission

Support billing for outcomes (task completed, issue resolved) rather than raw
usage. Branch the ingestion path so outcome-based meters aggregate events in a
dedicated Durable Object, then create billable facts only when the outcome is
confirmed or times out.

This phase replaces and supersedes the original Phase 7 (Trace Aggregation DO)
which was marked optional. Outcome-based pricing makes trace aggregation
mandatory — you cannot bill for outcomes without grouping the events that
comprise them.

## Dependencies

- Phase 6 for `traceId`/`sessionId` in the event schema
- Phase 7 for settlement router (rated outcomes need settlement)

## Why This Phase Exists

- outcome-based pricing is the dominant trend for agentic AI (Sierra charges per
  resolved conversation, Zendesk per automated resolution, Intercom's Fin at
  $0.99 per resolved ticket)
- aligns vendor and buyer incentives — if the agent fails, the customer pays
  nothing
- Gartner projects 40% of enterprise apps will feature AI agents by end of 2026
- enables per-task pricing for multi-step agent workflows
- without session grouping, you cannot do per-task pricing, per-session spending
  caps, or meaningful cost attribution
- the audit trail preserves individual events for replay and debugging even when
  billing happens at the outcome level

## Read First

- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
- [../../apps/api/src/ingestion/audit/IngestionAuditDO.ts](../../apps/api/src/ingestion/audit/IngestionAuditDO.ts)
- [../../internal/services/src/entitlements/engine.ts](../../internal/services/src/entitlements/engine.ts)
- [../../internal/db/src/validators/shared.ts](../../internal/db/src/validators/shared.ts)
- [../../internal/services/src/ingestion/message.ts](../../internal/services/src/ingestion/message.ts)
- [../../apps/api/src/routes/events/ingestEventsSyncV1.ts](../../apps/api/src/routes/events/ingestEventsSyncV1.ts)
- [../../apps/api/src/index.ts](../../apps/api/src/index.ts)
- [../../apps/api/wrangler.jsonc](../../apps/api/wrangler.jsonc)
- [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md)
- [./unprice-phase-07-credits-wallets.md](./unprice-phase-07-credits-wallets.md)

## Guardrails

- Reuse existing Durable Object and SQLite patterns from `EntitlementWindowDO`.
- Do not introduce TypeScript `any` types.
- Keep the output of aggregation compatible with the standard rating path. The
  `OutcomeAggregationDO` produces `AnalyticsEntitlementMeterFact` objects that
  enter the same pipeline as regular facts.
- Preserve idempotency for duplicate events and for repeated completion signals.
- Keep alarms and cleanup explicit so dormant outcome state does not accumulate.
- Individual events always go to the audit trail regardless of outcome. The
  audit path is never skipped.
- Do not fork a second billing pipeline. Outcome facts flow through the same
  rating → ledger → settlement path.

## Architecture

```
Event arrives at ingestion
  │
  ├── Check: is meter outcome-based OR does event carry group_id?
  │
  │   NO → normal EntitlementWindowDO path (existing, unchanged)
  │
  │   YES → route to OutcomeAggregationDO (keyed by group_id)
  │       │
  │       ├── Aggregate event into DO state
  │       ├── Flush individual event to audit trail (always, unchanged)
  │       │
  │       └── Wait for resolution:
  │           │
  │           ├── Success report (explicit API call)
  │           │   → create aggregated facts with outcome=success
  │           │   → facts enter normal rating pipeline
  │           │   → DO self-destructs
  │           │
  │           ├── Failure report (explicit API call)
  │           │   → create facts with zero charge (audit only)
  │           │   → DO self-destructs
  │           │
  │           └── Timeout (alarm-based)
  │               → configurable: bill / discard / bill_partial
  │               → DO self-destructs
```

## Primary Touchpoints

- `internal/db/src/validators/shared.ts` — extend `meterConfigSchema`
- `internal/db/src/utils/constants.ts` — new enums
- `apps/api/src/ingestion/outcomes/OutcomeAggregationDO.ts` — new DO
- `apps/api/src/routes/outcomes/reportOutcomeV1.ts` — new endpoint
- `apps/api/src/routes/events/ingestEventsSyncV1.ts` — branching logic
- `apps/api/src/routes/events/ingestEventsV1.ts` — branching logic
- `apps/api/src/index.ts` — register DO
- `apps/api/wrangler.jsonc` — register DO binding
- `packages/api/src/openapi.d.ts` — SDK types
- dashboard UI: outcome meter configuration, trace viewer, outcome analytics

## Execution Plan

### Slice 1: Extend meter config for outcome-based meters

Add to `meterConfigSchema` in `internal/db/src/validators/shared.ts`:

```typescript
meterType: z.enum(["usage", "outcome"]).default("usage"),
outcomeConfig: z.object({
  // how to determine success
  successCondition: z.enum(["explicit_report", "property_match"]),

  // if property_match: which event property and what value means success
  successProperty: z.string().optional(),
  successValue: z.union([z.string(), z.number(), z.boolean()]).optional(),

  // timeout before auto-resolving the group
  timeoutSeconds: z.number().int().min(30).max(86400).default(3600),

  // what happens on timeout
  timeoutAction: z.enum(["bill", "discard", "bill_partial"]).default("discard"),

  // how to aggregate the grouped events into a billable unit
  outcomeAggregation: z.enum(["count_events", "sum_field", "last_value"]).default("count_events"),
  outcomeAggregationField: z.string().optional(),
}).optional(),
```

Add new enums to `internal/db/src/utils/constants.ts`.

Validation rules:

- `outcomeConfig` is required when `meterType` is `"outcome"`
- `successProperty` and `successValue` are required when
  `successCondition` is `"property_match"`
- `outcomeAggregationField` is required when `outcomeAggregation` is
  `"sum_field"` or `"last_value"`

### Slice 2: Add `group_id` to ingestion schema

Add to `ingestionQueueMessageSchema`:

- `groupId: z.string().optional()` — groups events into an outcome

Update both ingestion routes to accept `groupId`. The queue message carries it
through to the routing logic.

Note: `traceId`/`sessionId` were already added in Phase 6. `groupId` is the
explicit outcome-grouping key. If `groupId` is not provided but the meter is
outcome-based, the system should require it and return an error.

### Slice 3: Create `OutcomeAggregationDO`

Create `apps/api/src/ingestion/outcomes/OutcomeAggregationDO.ts`.

Follow the same Durable Object + SQLite patterns as `EntitlementWindowDO`.

**Naming convention:** `appEnv:projectId:customerId:groupId`

**SQLite tables inside the DO:**

- `events_buffer` — individual events received (for aggregation state, not for
  audit — audit happens via the normal path)
- `aggregation_state` — running aggregation (count, sum, or last value)
- `resolution` — final outcome status and timestamp

**RPC surface:**

- `append(event)` — add an event to the group, update aggregation state
- `resolve(outcome)` — mark the group as success/failure/partial
- `inspect()` — return current aggregation state and event count (for debugging)

**Lifecycle:**

1. First event with a `groupId` for an outcome meter creates the DO
2. Subsequent events with same `groupId` are routed to the same DO
3. `append()` updates the running aggregation and deduplicates by
   idempotency key
4. Events are always flushed to audit via the normal audit path (this happens
   before/alongside the DO routing — audit is never skipped)
5. On resolution:
   - Create aggregated `AnalyticsEntitlementMeterFact` with the outcome result
   - The fact carries the aggregated value (count of events, sum of field, etc.)
   - Emit facts via the same outbox → Tinybird pattern as `EntitlementWindowDO`
   - Facts enter the normal rating pipeline (same as regular usage facts)
6. Set alarm for self-destruction (mirror `EntitlementWindowDO` cleanup pattern)

**Alarm-based timeout:**

- On DO creation, schedule an alarm at `now + timeoutSeconds`
- If the alarm fires before explicit resolution:
  - `"bill"` → create facts as if success, rate normally
  - `"discard"` → create facts with zero quantity (audit record only)
  - `"bill_partial"` → create facts with the aggregated value so far, rate at
    whatever was accumulated

Register the DO in `apps/api/src/index.ts` and `apps/api/wrangler.jsonc`.

### Slice 4: Branch ingestion routing

In both sync and async ingestion, after resolving entitlements:

1. Check if the resolved meter has `meterType: "outcome"` OR the event carries
   a `groupId` that matches an outcome-configured meter
2. If yes → route to `OutcomeAggregationDO` instead of `EntitlementWindowDO`
3. The event still goes to audit (audit path is unchanged)
4. For sync path: return `{ state: "buffered", groupId, message: "awaiting outcome resolution" }`
5. For async path: ack the queue message after the DO accepts the event

If an event has a `groupId` but the meter is not outcome-based, treat it as a
regular event (ignore the `groupId` for billing purposes but pass it through to
facts for informational grouping).

### Slice 5: Outcome reporting endpoint

Create `apps/api/src/routes/outcomes/reportOutcomeV1.ts`.

```
POST /v1/outcomes/report
{
  groupId: string,
  outcome: "success" | "failure" | "partial",
  metadata?: Record<string, unknown>
}
```

Behavior:

- Resolve the customer and project from the API key (same as ingestion)
- Find the `OutcomeAggregationDO` for the given `groupId`
- Call `resolve(outcome)` on the DO
- On `success`: DO creates aggregated facts → rated → posted to ledger →
  settled via router
- On `failure`: DO creates facts with zero charge (audit-only) → self-destructs
- On `partial`: DO creates facts using accumulated state → rated at partial
  amount → self-destructs

Idempotency: calling `resolve()` on an already-resolved group returns the
existing resolution result. No double-billing.

### Slice 6: Property-match auto-resolution

For meters with `successCondition: "property_match"`:

- After each `append()`, check if the latest event's property matches the
  configured `successProperty` + `successValue`
- If match → auto-resolve as success (no explicit API call needed)
- This enables fire-and-forget outcome billing where the final event in a group
  carries the success signal

Example: a meter with `successProperty: "status"`, `successValue: "resolved"`
will auto-resolve when any event in the group has `{ properties: { status: "resolved" } }`.

### Slice 7: SDK and API

SDK methods:

```typescript
// Report events with grouping
await unprice.events.ingest({
  slug: "llm_call",
  groupId: taskId,
  properties: { tokens: 150 }
})

// Report outcome
await unprice.outcomes.report({
  groupId: taskId,
  outcome: "success"
})

// Query outcome status
const status = await unprice.outcomes.status({ groupId: taskId })
```

API endpoints:

- `POST /v1/events/ingest` — accepts `groupId` field
- `POST /v1/events/ingest/sync` — accepts `groupId`, returns
  `{ state: "buffered" }` for outcome meters
- `POST /v1/outcomes/report` — report outcome for a group
- `GET /v1/outcomes/status?groupId=X` — query current status of a group

Update `packages/api/` OpenAPI types.

DX flow for developers building on outcome pricing:

```typescript
// 1. Start an agent task
const taskId = crypto.randomUUID()

// 2. Report steps as they happen (all grouped, each is a usage event)
await unprice.events.ingest({ slug: "llm_call", groupId: taskId, properties: { tokens: 150 } })
await unprice.events.ingest({ slug: "tool_call", groupId: taskId, properties: { tool: "search" } })
await unprice.events.ingest({ slug: "llm_call", groupId: taskId, properties: { tokens: 300 } })

// 3. Report the outcome — billing only happens now
await unprice.outcomes.report({ groupId: taskId, outcome: "success" })
// Customer is charged for 1 successful task at the configured price
```

### Slice 8: UI

**Outcome meter configuration:**

- New meter type toggle on the feature/meter config page: "Usage" vs "Outcome"
- When "Outcome" is selected, show:
  - Success condition selector: "Explicit report" vs "Property match"
  - If property match: property name and expected value fields
  - Timeout duration input with sensible presets (5 min, 15 min, 1 hour, 24 hours)
  - Timeout action selector: "Bill full amount" / "Discard (no charge)" / "Bill
    partial (what was consumed)"
  - Aggregation method for grouped events: count / sum / last value
- Visual preview at the bottom: "Customer is billed when [success condition]
  within [timeout]. On timeout: [action]."

**Pricing configuration note:**

When a plan version feature uses an outcome meter, the pricing tiers/rates
apply to the aggregated outcome unit, not to individual events within the group.
For example: "1-100 successful tasks: $0.50 each, 101-1000: $0.40 each". The
UI should make this clear.

**Trace/session viewer:**

- Timeline view of events within a group: event slug, timestamp, properties
- Group status: buffered / success / failure / partial / timed_out
- Visual flow: events received → outcome reported → facts created → billed
- Link to the resulting ledger entry when billed

**Outcome analytics dashboard:**

- Success rate over time (% of groups that resolved as success)
- Average time-to-outcome (time from first event to resolution)
- Average events per outcome (task complexity indicator)
- Cost per outcome distribution
- Timeout rate and revenue impact of discarded timeouts

### Slice 9: Tests

Cover:

- OutcomeAggregationDO creation on first grouped event
- Event aggregation within a group (count, sum, last value)
- Idempotent event handling within a group
- Explicit success → fact creation → rating pipeline
- Explicit failure → zero-charge facts → no ledger debit
- Explicit partial → partial charge based on accumulated state
- Timeout with `bill` action → full charge
- Timeout with `discard` action → no charge
- Timeout with `bill_partial` action → partial charge
- Property-match auto-resolution
- Concurrent events to same group
- DO cleanup after resolution
- Audit trail completeness (all individual events present regardless of outcome)
- Rating pipeline integration (aggregated facts rated normally)
- Settlement integration (rated outcome → wallet deduction or invoice)
- Resolve called on already-resolved group (idempotency)
- Group with no events resolved (edge case)
- Multiple meters on same group (if applicable)

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`
- `pnpm --filter @unprice/api typecheck`

## Exit Criteria

- outcome-based meters can be configured via the meter config schema and UI
- events with `groupId` are routed to `OutcomeAggregationDO`
- individual events are always audited regardless of outcome
- explicit outcome reports trigger fact creation and rating
- timeout-based resolution works with configurable actions
- property-match auto-resolution works for fire-and-forget patterns
- aggregated facts flow through the standard rating → ledger → settlement path
- SDK exposes grouping, outcome reporting, and status querying
- dashboard shows outcome meter configuration, trace viewer, and analytics

## Out Of Scope

- nested outcomes (outcome groups within outcome groups)
- cross-customer outcome attribution
- LLM-judged outcome evaluation (success/failure is determined by explicit
  report or property match, not by AI evaluation)
- outcome SLA tracking and refund automation
