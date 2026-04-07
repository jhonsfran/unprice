# Phase 4: Ledger Foundation And Billing Decoupling

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add ledger foundation and decouple billing from invoices`  
Branch: `feat/ledger-foundation`

## Mission

Introduce ledger storage and `LedgerService`, then make rated charges flow into
the ledger before invoice materialization. After this phase, invoices become a
projection and settlement artifact rather than the first place charges are
materialized.

## Dependencies

- Phase 1 must be complete first.

## Why This Phase Exists

- current billing still materializes prices directly into invoice items
- later settlement work needs a durable, append-only financial source of truth
- agent billing in Phase 6 must be able to post charges outside the subscription
  invoice path

## Read First

- [../../internal/services/src/billing/service.ts](../../internal/services/src/billing/service.ts)
- [../../internal/services/src/subscriptions/invokes.ts](../../internal/services/src/subscriptions/invokes.ts)
- [../../internal/services/src/subscriptions/machine.ts](../../internal/services/src/subscriptions/machine.ts)
- [../../internal/services/src/context.ts](../../internal/services/src/context.ts)
- [../../internal/db/src/schema/invoices.ts](../../internal/db/src/schema/invoices.ts)
- [../../internal/db/src/schema/billingPeriods.ts](../../internal/db/src/schema/billingPeriods.ts)
- [../../internal/services/src/entitlements/grants.ts](../../internal/services/src/entitlements/grants.ts) if credit behavior needs context
- [./unprice-phase-01-rating-service.md](./unprice-phase-01-rating-service.md)

## Guardrails

- `LedgerService` should be a leaf service. Other services may depend on it; it
  should not depend on peer domain services.
- Do not introduce TypeScript `any` types. Use concrete types or `unknown`
  with explicit narrowing where needed.
- Keep ledger entries append-only.
- Idempotency is mandatory. Retries must not create duplicate debits or credits.
- Invoice/provider logic stays in billing. Ledger tracks financial facts; it
  does not become a payment-provider adapter.

## Primary Touchpoints

- `internal/db/src/schema/` new ledger tables
- `internal/db/src/validators/` new ledger validators
- `internal/services/src/ledger/` new service
- `internal/services/src/context.ts`
- `internal/services/src/billing/service.ts`
- `internal/services/src/subscriptions/invokes.ts`
- `internal/services/package.json` if the service is exported

## Execution Plan

### Slice 1: Add ledger schema

Create `ledgers` and `ledger_entries` with:

- one ledger per `(projectId, customerId, currency)`
- append-only entries
- deterministic idempotency key using `sourceType + sourceId`
- entry type enum for `debit` and `credit`
- settlement metadata on each entry
- transactional running balance support

Design note:

- store enough source identity to rebuild why an entry exists without reading
  invoices first

### Slice 2: Add validators, enums, and migration

Add:

- ledger entry type enum
- settlement type enum
- validators and barrel exports
- generated migration

Done when:

- schema and validator barrels expose the full ledger model
- migration artifacts are checked in and deterministic

### Slice 3: Create `LedgerService`

Create `internal/services/src/ledger/` with:

- `errors.ts`
- `service.ts`
- `index.ts`

Constructor deps should stay minimal:

- `db`
- `logger`
- `metrics`

### Slice 4: Implement idempotent posting and reads

Add these methods:

- `postDebit()`
- `postCredit()`
- `getUnsettledEntries()`
- `getUnsettledBalance()`
- `markSettled()`

Critical behavior:

- repeated writes with the same source identity must return the same logical
  entry
- running balance must be updated transactionally
- settlement updates must link back to the artifact that settled the entry

### Slice 5: Register the service

Wire `ledger: LedgerService` into
[../../internal/services/src/context.ts](../../internal/services/src/context.ts)
before services that depend on it, then inject it into billing.

### Slice 6: Post subscription charges to the ledger first

Change subscription billing so rated charges become ledger debits before invoice
creation.

Requirements:

- call `RatingService.rateBillingPeriod()`
- convert each rated charge into a deterministic ledger debit
- use stable source ids tied to billing period and subscription item identity

Important detail:

- decide the source identity format once and keep it stable. Later retries and
  settlement reconciliation will depend on it.

### Slice 7: Project invoices from unsettled ledger entries

Rewrite invoice materialization so it consumes unsettled ledger entries instead
of inline pricing output.

Likely hotspots:

- billing item computation in `BillingService`
- invoice materialization in `subscriptions/invokes.ts`

The resulting flow should be:

1. rate the billing period
2. post ledger debits
3. load unsettled ledger entries for the statement window
4. convert them into invoice items
5. continue provider sync/finalization

### Slice 8: Settle only after invoice linkage is durable

Do not mark invoice-backed entries settled until invoice persistence and
artifact linkage succeed.

Settlement metadata should make it possible to answer:

- which invoice settled this entry
- when settlement happened
- whether the entry is still pending provider confirmation

### Slice 9: Add ledger-first billing tests

Cover:

- idempotent posting
- running-balance correctness
- rating -> ledger -> invoice flow
- retry safety around invoice finalization
- invoice projection from unsettled ledger entries

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/db typecheck`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter @unprice/services test`

## Exit Criteria

- ledger tables and service exist
- subscription billing posts ledger entries before invoice projection
- invoice items are derived from ledger entries
- invoice-backed ledger settlement happens only after safe invoice linkage

## Out Of Scope

- provider webhooks
- generic settlement router
- agent usage posting
