# Phase 6: Agent Billing Foundation

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
PR title: `feat: add agent billing foundation`
Branch: `feat/agent-billing`

## Mission

Make agent usage a first-class billing path by resolving customers from API
keys, extending the existing meter-facts outbox for billing consumption, rating
those facts asynchronously via `rateIncrementalUsage()`, and posting resulting
debits into the ledger. Keep the sync metering path untouched and let the
Durable Object alarm drive background billing as the primary trigger.

## Dependencies

- Phase 1 for `RatingService`
- Phase 3 for provider-neutral runtime
- Phase 4 for ledger posting

## Why This Phase Exists

- today ingestion expects `customerId` at the API edge
- the Durable Object already computes authoritative meter facts, but billing
  does not yet consume them as a durable handoff
- agent usage should enter the same rating and ledger system as subscriptions
- future spend controls need a clean seam between metering facts, estimated
  spend, rated charges, and settled financial artifacts

## Read First

- [../../internal/services/src/apikey/service.ts](../../internal/services/src/apikey/service.ts)
- [../../internal/db/src/schema/apikeys.ts](../../internal/db/src/schema/apikeys.ts)
- [../../apps/api/src/routes/events/ingestEventsV1.ts](../../apps/api/src/routes/events/ingestEventsV1.ts)
- [../../apps/api/src/routes/events/ingestEventsSyncV1.ts](../../apps/api/src/routes/events/ingestEventsSyncV1.ts)
- [../../apps/api/src/auth/key.ts](../../apps/api/src/auth/key.ts)
- [../../internal/services/src/ingestion/message.ts](../../internal/services/src/ingestion/message.ts)
- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
- [../../apps/api/src/ingestion/entitlements/db/schema.ts](../../apps/api/src/ingestion/entitlements/db/schema.ts)
- [../../internal/services/src/rating/service.ts](../../internal/services/src/rating/service.ts)
- [../../internal/services/src/ledger/service.ts](../../internal/services/src/ledger/service.ts)
- [./unprice-phase-01-rating-service.md](./unprice-phase-01-rating-service.md)
- [./unprice-phase-04-ledger-foundation.md](./unprice-phase-04-ledger-foundation.md)

## Guardrails

- Do not invent a second metering algorithm. Reuse the billing facts the
  entitlement flow already computes.
- Do not introduce TypeScript `any` types. Use concrete types or `unknown`
  with explicit narrowing where needed.
- Do not add a new external queue or a per-event state machine in this phase.
- Do not add a second outbox table in the Durable Object. Extend the existing
  `meter_facts_outbox` with billing lifecycle columns.
- Do not change the public SDK surface in this phase. Backend behavior may
  evolve, but SDK and docs stay simple for now.
- Failed rating or ledger posting must not silently corrupt metering state.
- Billing facts and ledger entries are different layers. Durable billing facts
  are expected to be more granular than settled financial artifacts over time.
- Use canonical billing identity derived from resolved customer context and
  idempotency key. Do not use generated `event.id` as ledger identity.
- The Durable Object alarm is the primary trigger for background billing.
  `waitUntil` may serve as an opportunistic fast-path but must never be the
  only delivery mechanism.
- Settlement routing is NOT part of this phase. Ledger debits are posted, but
  settlement remains deferred to Phase 7.
- Customer provisioning is NOT part of this phase. Customers and their grants
  are created through existing CRUD services (dashboard, management API).
  This phase only owns the resolution path from API key to customer.

## Primary Touchpoints

- `internal/db/src/schema/apikeys.ts` — add `defaultCustomerId` column
- `internal/db/src/validators/` — matching validators
- `internal/services/src/apikey/service.ts` — customer resolution methods
- `internal/services/src/ingestion/message.ts`
- `apps/api/src/routes/events/ingestEventsV1.ts`
- `apps/api/src/routes/events/ingestEventsSyncV1.ts`
- `apps/api/src/auth/key.ts`
- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`
- `apps/api/src/ingestion/entitlements/db/schema.ts` — extend outbox schema
- `internal/services/src/use-cases/agent/report-agent-usage.ts` — new

## Execution Plan

### Slice 1: Add default customer binding to API keys

Add a nullable `defaultCustomerId` column to the existing `apikeys` table
instead of creating a separate join table.

Schema change:

- `apikeys.default_customer_id` — nullable FK to `customers.id`, project-scoped
- add a partial index on `(projectId, default_customer_id)` where
  `default_customer_id IS NOT NULL` for efficient lookups

Service changes in `ApiKeysService`:

- `bindCustomer({ apikeyId, customerId, projectId })` — sets the
  `defaultCustomerId` on an existing key
- `unbindCustomer({ apikeyId, projectId })` — clears the binding
- `resolveCustomerId({ key })` — returns the bound `customerId` or null.
  This sits on the hot ingestion path so it must use the existing
  `apiKeyByHash` cache (the cached `ApiKeyExtended` shape already includes
  the key row — extend it to carry `defaultCustomerId`)

One key → zero or one default customer. No ambiguity to resolve, no
"reject ambiguous shared keys" logic needed.

### Slice 2: Resolve customers from API keys at the edge

Update ingestion routes so `customerId` is optional at the API boundary.

Requirements:

- in `rawEventSchema` (ingestEventsV1) and `syncEventSchema`
  (ingestEventsSyncV1), make `customerId` optional via `.optional()`
- if `customerId` is provided in the request body, use it (explicit wins)
- if `customerId` is omitted, resolve it from the verified key's
  `defaultCustomerId`
- if neither is available, reject with `400 Bad Request` and a clear message:
  "customerId is required when the API key has no default customer binding"
- internal contracts (`IngestionQueueMessage`, DO `apply` input) continue
  carrying a resolved `customerId` — the optionality is only at the API edge
- queue shard selection continues to use the resolved `customerId`

Important detail:

- the public API gets more flexible, but internal contracts get more
  explicit, not less
- `resolveContextProjectId` in `key.ts` must handle the case where
  `customerId` comes from the key binding rather than the request body

### Slice 3: Extend meter-facts outbox for billing lifecycle

Extend the existing `meterFactsOutboxTable` in the DO SQLite schema instead
of adding a second outbox table.

Schema changes to `apps/api/src/ingestion/entitlements/db/schema.ts`:

- add `billedAt` column — nullable integer timestamp, null means unbilled
- add `currency` column — text, the customer's billing currency at event time

The existing outbox already stores the full billing fact payload via
`buildOutboxFactPayload` which includes: `projectId`, `customerId`,
`featureSlug`, `idempotencyKey`, `eventId`, `timestamp`, `delta`,
`valueAfter`, `aggregationMethod`, `streamId`, `periodKey`.

Changes to `buildOutboxFactPayload` in `EntitlementWindowDO`:

- accept `currency` as an additional input parameter
- include `currency` in the persisted payload so downstream billing
  consumers can rate and post ledger entries without a separate lookup

Changes to `EntitlementWindowApplyInput`:

- add `currency: string` field — resolved and passed by the ingestion
  service from the customer's entitlement/grant context

Currency resolution path:

- grants already carry `featurePlanVersion` which includes pricing config
  with currency
- the `IngestionService` resolves grants via `prepareCustomerGrantContext`
  before calling the DO — extract currency from the matched grant's
  pricing config and pass it through

The alarm-driven flush to Tinybird continues working unchanged — it reads
`payload` and ignores `billedAt`. The billing consumer reads rows where
`billedAt IS NULL`.

### Slice 4: Background billing consumer via DO alarm

Add a billing consumer path to `EntitlementWindowDO.alarm()` that runs
after the existing Tinybird flush.

The alarm flow becomes:

1. flush pending outbox rows to Tinybird (existing behavior, unchanged)
2. query outbox rows where `billedAt IS NULL` (new billing step)
3. for each unbilled fact, call `reportAgentUsage` use case
4. on success, set `billedAt = Date.now()` on the outbox row
5. on failure, log the error and leave `billedAt` as null for next alarm

The use case at
`internal/services/src/use-cases/agent/report-agent-usage.ts`:

- accepts a single billing fact payload (parsed from outbox row)
- calls `RatingService.rateIncrementalUsage()` with:
  - `usageBefore` = `valueAfter - delta` (from the billing fact)
  - `usageAfter` = `valueAfter` (from the billing fact)
  - `now` or `startAt/endAt` derived from the fact's `periodKey`
  - `currency` from the billing fact
- takes the `deltaPrice` from the rating result
- posts an idempotent ledger debit via `LedgerService.postDebit()` with:
  - `sourceType: "agent_usage_v1"`
  - `sourceId: projectId:customerId:featureSlug:idempotencyKey`
  - `amountCents` from `deltaPrice.totalPrice`
  - `currency` from the billing fact
  - `featurePlanVersionId` from the billing fact's `streamId` context
  - `metadata` carrying the raw billing fact for audit

Deps type follows use-case pattern:

```ts
type ReportAgentUsageDeps = {
  services: Pick<ServiceContext, "rating" | "ledger">
  logger: Logger
}
```

Failure handling:

- the ledger's `sourceType + sourceId` idempotency ensures duplicate alarm
  runs don't create duplicate debits
- if rating fails, the outbox row stays unbilled — the next alarm retries
- if ledger posting fails, same — the outbox row stays unbilled
- metering state is never affected by billing failures
- the DO already retries alarms every 30s while outbox rows exist

The DO needs access to the `reportAgentUsage` use case. Implementation
options (decide during execution):

- RPC call from DO to a Hono internal endpoint that wraps the use case
- service binding to the main worker
- direct instantiation if deps can be constructed in DO context

### Slice 5: Full-path tests

Cover:

- API key default customer binding (bind, unbind, resolve)
- edge resolution: `customerId` provided in body takes precedence
- edge resolution: `customerId` omitted, resolved from key binding
- edge resolution: neither available, returns 400
- cache invalidation when `defaultCustomerId` is updated
- sync ingestion with API-key-only resolution
- DO outbox rows include `currency` and `billedAt` columns
- DO alarm flushes to Tinybird AND processes unbilled facts
- idempotent replay: same billing fact processed twice → one ledger debit
- duplicate logical events with different generated `event.id` but same
  `idempotencyKey` produce one ledger debit only
- rating failure leaves outbox row unbilled for retry
- ledger posting failure leaves outbox row unbilled for retry
- metering state unaffected by billing failures

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`

## Exit Criteria

- customers can be resolved from API keys without requiring `customerId` at the
  API edge when a key has a default customer binding
- synchronous ingestion persists durable billing facts (including currency) in
  the existing meter-facts outbox
- the Durable Object alarm drives background billing: rating unbilled facts
  via `rateIncrementalUsage()` and posting idempotent ledger debits
- billing failures never corrupt metering state and are retried via alarm
- backend data flow is ready for future `operationId` propagation and spend
  controls without requiring a redesign

## Out Of Scope

- public SDK additions or docs for agent provisioning
- agent customer provisioning use case (CRUD via existing services)
- RatingService internal refactoring (defer until Phase 8 needs the seam)
- synchronous authoritative pricing in `ingestSync`
- settlement routing (Phase 7)
- wallet / credit infrastructure (Phase 7)
- hard spend controls and financial guardrails (Phase 8)
- operation-level aggregation and outcome pricing (Phase 9)
