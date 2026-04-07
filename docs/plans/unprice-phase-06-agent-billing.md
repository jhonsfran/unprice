# Phase 6: Agent Billing Foundation

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add agent billing foundation`  
Branch: `feat/agent-billing`

## Mission

Make agent usage a first-class billing path by resolving customers from API
keys, exposing billing facts from synchronous metering, rating incremental
usage, posting it into the ledger, and routing it into settlement.

## Dependencies

- Phase 1 for `RatingService`
- Phase 3 for provider-neutral runtime
- Phase 4 for ledger posting
- Phase 5 only if provider-backed settlement confirmation must be complete in
  the same delivery

## Why This Phase Exists

- today ingestion expects `customerId` at the API edge
- sync metering computes the facts needed for billing, but does not expose them
  cleanly enough
- agent usage should use the same rating and ledger pipeline as subscription
  billing

## Read First

- [../../internal/services/src/apikey/service.ts](../../internal/services/src/apikey/service.ts)
- [../../internal/db/src/schema/apikeys.ts](../../internal/db/src/schema/apikeys.ts)
- [../../apps/api/src/routes/events/ingestEventsV1.ts](../../apps/api/src/routes/events/ingestEventsV1.ts)
- [../../apps/api/src/routes/events/ingestEventsSyncV1.ts](../../apps/api/src/routes/events/ingestEventsSyncV1.ts)
- [../../apps/api/src/auth/key.ts](../../apps/api/src/auth/key.ts)
- [../../internal/services/src/ingestion/message.ts](../../internal/services/src/ingestion/message.ts)
- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
- [./unprice-phase-01-rating-service.md](./unprice-phase-01-rating-service.md)
- [./unprice-phase-04-ledger-foundation.md](./unprice-phase-04-ledger-foundation.md)

## Guardrails

- Do not invent a second metering algorithm. Reuse billing facts the
  entitlement flow already computes.
- Do not introduce TypeScript `any` types. Use concrete types or `unknown`
  with explicit narrowing where needed.
- Keep the queue contract carrying a resolved `customerId`, even if the API edge
  stops requiring it.
- Failed billing writes must not silently corrupt metering state.
- Manual grants are for entitlement and provisioning, not a replacement for
  ledger-backed billing artifacts.

## Primary Touchpoints

- `internal/db/src/schema/` new `apikey_customers` table
- `internal/db/src/validators/` matching validators
- `internal/services/src/apikey/service.ts`
- `internal/services/src/use-cases/` new agent billing use cases
- `apps/api/src/routes/events/ingestEventsV1.ts`
- `apps/api/src/routes/events/ingestEventsSyncV1.ts`
- `apps/api/src/auth/key.ts`
- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`
- `internal/services/src/ingestion/message.ts`
- new settlement routing service or module

## Execution Plan

### Slice 1: Add API key to customer mapping

Create `apikey_customers` plus service methods for:

- linking an API key to a customer
- resolving customer by API key
- exposing the first integration point through the existing API key surface

Implementation note:

- keep the mapping normalized and project-scoped
- make lookup paths explicit and efficient because they will sit on the hot
  ingestion path

### Slice 2: Add `provisionAgentCustomer`

Create a use case that coordinates:

- customer creation or lookup
- API key linkage
- manual grant creation
- initial billing configuration for the agent customer

Done when:

- a single use case can provision an agent billable identity end-to-end
- manual grants exist only for entitlement bootstrap, not for financial truth

### Slice 3: Resolve customers from API keys at the edge

Update ingestion so `customerId` is optional at the API boundary.

Requirements:

- if `customerId` is omitted, resolve it from `apikey_customers`
- update `resolveContextProjectId()` so it can work without request-body
  `customerId`
- keep the internal queue payload carrying a resolved `customerId`
- keep queue sharding and deduplication based on resolved customer id

Important detail:

- the public API gets more flexible, but internal contracts should get more
  explicit, not less

### Slice 4: Expose billing facts from synchronous metering

Extend `EntitlementWindowDO.apply()` so callers receive the billing facts it
already computes:

- `delta`
- `valueAfter`

Do not recompute these downstream if the DO already has the authoritative data.

### Slice 5: Add `reportAgentUsage`

Create a use case that:

- consumes billing facts from sync ingestion
- calls `RatingService.rateIncrementalUsage()`
- posts idempotent ledger debits with `sourceType: "agent_usage"`
- uses the event id as the deterministic source id

This is the key point where agents enter the same pricing and ledger pipeline as
subscriptions.

### Slice 6: Add `SettlementRouter`

Introduce a settlement router that decides how a charge should be settled.

Initial routing modes:

- `invoice`
- `wallet`
- `one_time`

Refinement for implementation:

- inspect whether wallet primitives already exist before implementing `wallet`
- if wallet infrastructure does not exist yet, keep the routing contract typed
  and explicit but avoid inventing speculative storage
- `one_time` should reuse the normalized provider runtime and leave room for
  later crypto-backed collectors

### Slice 7: Wire agent usage into sync ingestion

Only connect the flow after customer resolution and billing facts are both
available.

Expected path:

1. authenticate API key
2. resolve project and customer
3. run synchronous entitlement evaluation
4. receive billing facts
5. call `reportAgentUsage`
6. route settlement

Failure handling:

- do not silently swallow billing failures
- if metering succeeded but billing failed, emit enough signal to retry safely

### Slice 8: Add full-path tests

Cover:

- API key to customer resolution
- agent provisioning
- sync ingestion with API-key-only resolution
- DO billing facts
- incremental event rating
- ledger posting for agent usage
- settlement router integration

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`

## Exit Criteria

- customers can be resolved from API keys without requiring `customerId` at the
  API edge
- sync ingestion exposes billing facts needed for usage charging
- incremental agent usage is rated and posted to the ledger
- settlement routing exists for agent-generated charges

## Out Of Scope

- trace-level aggregation
- wallet top-up UX
- speculative crypto collector implementation
