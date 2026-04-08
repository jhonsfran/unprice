# Phase 8: Financial Guardrails & Spending Controls

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add financial guardrails and spending controls`  
Branch: `feat/financial-guardrails`

## Mission

Prevent runaway agents from generating unbounded charges. Add real-time financial
enforcement at the sync ingestion edge, configurable spending limits at multiple
scopes, budget alert hooks, and circuit breakers for cost velocity anomalies.

## Dependencies

- Phase 6 for agent billing pipeline
- Phase 7 for wallet balance and credit infrastructure

## Why This Phase Exists

- "Agentic Resource Exhaustion" is a real and growing risk — a single agent in
  an infinite loop can rack up thousands in compute
- Fortune 500 companies leaked an estimated $400M in unbudgeted AI cloud spend
  (2026)
- only 44% of organizations have financial guardrails for AI (expected to double
  by end of 2026)
- the current entitlement system has usage limits (count-based) but no financial
  limits (dollar-based)
- a customer with `overage: "always"` currently has zero financial protection
- wallet balance enforcement and spending limits are complementary — wallets
  provide the balance, guardrails enforce the policy

## Read First

- [../../internal/services/src/wallet/service.ts](../../internal/services/src/wallet/service.ts)
- [../../internal/services/src/use-cases/agent/report-agent-usage.ts](../../internal/services/src/use-cases/agent/report-agent-usage.ts)
- [../../apps/api/src/routes/events/ingestEventsSyncV1.ts](../../apps/api/src/routes/events/ingestEventsSyncV1.ts)
- [../../internal/services/src/entitlements/limit-policy.ts](../../internal/services/src/entitlements/limit-policy.ts)
- [../../internal/services/src/rating/service.ts](../../internal/services/src/rating/service.ts)
- [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md)
- [./unprice-phase-07-credits-wallets.md](./unprice-phase-07-credits-wallets.md)

## Guardrails

- Spending checks must not add significant latency to the hot ingestion path.
  Use cached balance lookups where possible.
- Do not introduce TypeScript `any` types.
- Spending limits are advisory or enforcement boundaries, not billing
  primitives. The ledger and wallet remain the source of financial truth.
- Alert delivery is best-effort. Do not block ingestion on alert webhook
  delivery.
- Circuit breaker state is ephemeral (cache-based). If cache is lost, the
  breaker resets — this is safer than false-blocking from stale state.

## Primary Touchpoints

- `internal/db/src/schema/spending-limits.ts` — new
- `internal/db/src/validators/spending-limits.ts` — new
- `internal/services/src/spending-guard/service.ts` — new
- `apps/api/src/routes/events/ingestEventsSyncV1.ts` — wire guard
- `apps/api/src/routes/spending/` — new API endpoints
- `packages/api/src/openapi.d.ts` — SDK types
- dashboard UI: spending limits config, budget dashboard, alert history

## Execution Plan

### Slice 1: Spending limits schema

Create `internal/db/src/schema/spending-limits.ts`:

```
spending_limits(
  id, projectId, customerId,
  scope,                  -- "customer" | "session" | "feature"
  scopeId,                -- null for customer-wide, sessionId or featureSlug
  limitCents,             -- maximum spend allowed
  periodType,             -- "billing_period" | "calendar_month" | "session" | "lifetime"
  alertThresholds,        -- JSON array e.g. [0.75, 0.90, 1.0]
  action,                 -- "alert" | "soft_block" | "hard_block"
  createdAt, updatedAt
)
```

Scope semantics:

- `customer` + `periodType: "billing_period"` — total customer spend per cycle
- `session` + `periodType: "session"` — per-agent-session cap (requires `traceId`)
- `feature` + `periodType: "billing_period"` — per-feature spend cap

Add validators and export from barrels. Run migration.

### Slice 2: SpendingGuard service

Create `internal/services/src/spending-guard/service.ts`.

Constructor deps: `db`, `logger`, `cache`, `metrics`.

Methods:

- `checkSpendingLimit(params)` — params: `{ customerId, featureSlug?, sessionId?,
  estimatedCostCents }`. Returns `{ allowed: boolean, reason?: string,
  thresholdBreached?: number, limit?: SpendingLimit }`.
  - For wallet-based customers: `wallet.balance >= estimatedCost`
  - For invoice-based customers: accumulated spend in period vs configured limit
  - Checks all applicable scopes (customer, session, feature) and returns the
    most restrictive result
- `recordSpend(params)` — params: `{ customerId, amountCents, featureSlug?,
  sessionId? }`. Increments spending counters in cache.
- `getSpendingSummary(customerId)` — current spend vs limits across all scopes

Spending counters use the cache layer for speed. Counters are periodically
reconciled against the ledger (the ledger is truth, cache is the fast path).

Register in `internal/services/src/context.ts`.

### Slice 3: Wire into sync ingestion

Update the sync ingestion path. After entitlement check, before billing:

1. Estimate cost: use burn rate (if wallet) or rated price from
   `RatingService.rateIncrementalUsage()`
2. Call `SpendingGuard.checkSpendingLimit()`
3. If `hard_block` → reject with denial reason `spending_limit_exceeded`
4. If `soft_block` → reject but emit alert event
5. If `alert` threshold breached → allow but emit alert event

The sync ingestion response gains new optional fields:

```typescript
spendingWarning?: {
  thresholdBreached: number  // e.g. 0.75
  limitCents: number
  currentSpendCents: number
  scope: "customer" | "session" | "feature"
}
```

DX: every sync ingestion response includes spending context. Developers can
show users budget status without extra API calls.

### Slice 4: Budget alert hooks

When a spending threshold is breached:

- emit an internal event with: `customerId`, `scope`, `scopeId`,
  `thresholdBreached`, `currentSpendCents`, `limitCents`
- if the spending limit has a configured webhook URL, deliver the alert payload
- alert delivery is async (use `waitUntil`) — do not block ingestion
- deduplicate alerts: only fire once per threshold per period (e.g., 75%
  threshold fires once per billing cycle, not on every request after 75%)

### Slice 5: Circuit breaker for runaway agents

Cost velocity detection:

- track spend rate over a sliding window (e.g., last 60 seconds)
- if spend rate exceeds a configurable threshold (e.g., $100/minute),
  auto-block the customer/session
- circuit breaker state is stored in the cache layer (ephemeral)
- auto-reset after a configurable cooldown period
- when tripped, return denial reason `spending_velocity_exceeded`

The circuit breaker is a safety net for cases where configured spending limits
are too high or not yet configured. It catches anomalous cost velocity patterns
that suggest a misbehaving agent.

### Slice 6: API endpoints

New routes:

- `GET /v1/spending/summary?customerId=X` — current spending vs limits
- `POST /v1/spending/limits` — create or update a spending limit
- `DELETE /v1/spending/limits/:id` — remove a spending limit
- `GET /v1/spending/alerts?customerId=X` — recent alert history

Update `packages/api/` OpenAPI types.

### Slice 7: UI

- **Spending limits configuration page:** per-customer limits editor with scope
  selector (customer-wide / per-feature / per-session), period type, and amount
- **Alert threshold configuration:** visual slider for threshold percentages
  (e.g., 75%, 90%, 100%) with action selector (alert / soft block / hard block)
- **Spending dashboard:** real-time spend tracking with visual budget meters
  per customer. Show progress bars for each configured limit.
- **Alert history:** chronological log of triggered alerts with customer,
  scope, threshold, and timestamp
- **Circuit breaker status:** indicator showing if any customer is currently
  circuit-broken, with cooldown timer

### Slice 8: Tests

Cover:

- hard block enforcement at ingestion edge
- soft block rejection plus alert emission
- alert-only mode (allow but emit)
- wallet balance enforcement (wallet balance < estimated cost)
- invoice-based spending accumulation against limits
- multi-scope evaluation (customer + feature + session simultaneously)
- circuit breaker trigger on high velocity
- circuit breaker cooldown and auto-reset
- alert deduplication (one per threshold per period)
- concurrent spending from multiple sessions
- cache reconciliation with ledger truth

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`
- `pnpm --filter @unprice/api typecheck`

## Exit Criteria

- customers can have configurable spending limits at customer, feature, and
  session scopes
- sync ingestion enforces spending limits before billing
- budget alerts fire at configurable thresholds
- circuit breaker detects and blocks anomalous cost velocity
- sync ingestion response includes spending context
- SDK exposes spending summary and limit management
- dashboard shows spending status and allows limit configuration

## Out Of Scope

- automatic spending limit recommendations based on historical usage
- machine-learning-based anomaly detection
- spending limits on async ingestion (async is fire-and-forget by design)
- cross-customer budget pooling
