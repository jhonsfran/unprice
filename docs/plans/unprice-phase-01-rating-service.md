# Phase 1: Rating Service Extraction

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: extract pricing orchestration into RatingService`  
Branch: `feat/rating-service`

## Mission

Extract pricing orchestration from billing into a dedicated `RatingService`
without changing pricing behavior. After this phase, subscription billing still
works the same way, but all pricing orchestration lives behind a reusable
service that later phases can call for ledger-first billing and agent billing.

## Why This Phase Exists

- The current pricing pipeline is buried inside
  [../../internal/services/src/billing/service.ts](../../internal/services/src/billing/service.ts).
- Agent billing in Phase 6 needs the same pricing math and orchestration as
  subscription billing.
- Ledger-first billing in Phase 4 must rate charges without keeping invoice
  creation as the first place pricing is materialized.

## Read First

- [../adr/ADR-0001-canonical-backend-architecture-boundaries.md](../adr/ADR-0001-canonical-backend-architecture-boundaries.md)
- [../../internal/services/src/billing/service.ts](../../internal/services/src/billing/service.ts)
- [../../internal/services/src/context.ts](../../internal/services/src/context.ts)
- [../../internal/services/src/deps.ts](../../internal/services/src/deps.ts)
- [../../internal/services/src/use-cases/index.ts](../../internal/services/src/use-cases/index.ts)
- [../../internal/db/src/validators/subscriptions/prices.ts](../../internal/db/src/validators/subscriptions/prices.ts)
- [../../internal/services/package.json](../../internal/services/package.json)

## Guardrails

- Do not change pricing math formulas. The single source of truth remains
  `@unprice/db/validators/subscriptions/prices.ts`.
- Keep invoice formatting, provider sync, and invoice reconciliation inside
  `BillingService`.
- Preserve support for pre-fetched grants and usage data so callers can avoid
  duplicate reads.
- Avoid changing public behavior in this phase. The goal is extraction first,
  new billing behavior later.

## Primary Touchpoints

- `internal/services/src/rating/` new module
- `internal/services/src/billing/service.ts`
- `internal/services/src/context.ts`
- `internal/services/package.json`
- `internal/services/src/use-cases/index.ts` only if a new use-case export
  becomes necessary

## Execution Plan

### Slice 1: Create the module shell

Create `internal/services/src/rating/` with:

- `errors.ts` defining `UnPriceRatingError`
- `types.ts` defining `RatingInput`, `RatedCharge`, and reusable result shapes
- `service.ts` defining `RatingService`
- `index.ts` exporting the public surface

Constructor dependencies should match the source plan:

- infrastructure deps: `db`, `logger`, `analytics`, `cache`, `metrics`,
  `waitUntil`
- service dep: `grantsManager`

Done when:

- The new module compiles.
- The public types are reusable by both billing-period and event-time callers.

### Slice 2: Move helper logic out of billing

Extract these helpers from `BillingService` into `RatingService`:

- `calculateBillingWindow()`
- usage-fetch orchestration currently inside `calculateUsageOfFeatures()`
- `calculateGrantProration()`

Keep the helper contracts service-oriented:

- inputs can accept preloaded grants
- inputs can accept preloaded usage data
- helper outputs stay reusable and do not depend on invoice-specific shape

Done when:

- `BillingService` no longer owns the helper implementations.
- Existing behavior remains byte-for-byte equivalent for current callers.

### Slice 3: Extract feature rating orchestration

Move the full `calculateFeaturePrice()` orchestration into `RatingService`.

Preserve the current sequence:

1. resolve grants unless provided
2. filter grants by feature slug
3. compute entitlement state
4. calculate billing window
5. fetch usage unless provided
6. compute per-grant proration
7. prepare waterfall inputs
8. call `calculateWaterfallPrice()`
9. map the result into reusable rating output

Important detail:

- Avoid leaking invoice concepts into the returned type. The output should
  describe rated charges and pricing facts, not invoice rows.

### Slice 4: Register `RatingService`

Wire the service into the composition root:

- add `rating: RatingService` to `ServiceContext`
- instantiate it in
  [../../internal/services/src/context.ts](../../internal/services/src/context.ts)
- export the new module from
  [../../internal/services/package.json](../../internal/services/package.json)

Done when:

- any service can obtain `context.rating`
- service construction order still respects leaf-first wiring

### Slice 5: Make billing delegate instead of calculate

Update `BillingService` so pricing calls route through `RatingService`:

- `_computeInvoiceItems()`
- `estimatePriceCurrentUsage()`
- any other private pricing entry point still doing orchestration

Constraints:

- keep invoice row formatting in billing
- keep provider reconciliation in billing
- delete duplicated orchestration once delegation is in place

### Slice 6: Add the reusable public API

Add two public entry points on `RatingService`:

- `rateBillingPeriod()`
- `rateIncrementalUsage()`

`rateIncrementalUsage()` should use the marginal-price approach:

1. compute price at `usageAfter`
2. compute price at `usageBefore`
3. return the delta

That keeps event-time rating aligned with the same pricing math used for
periodic billing.

### Slice 7: Lock parity with tests

Add or update tests covering:

- extraction parity for current billing behavior
- marginal rating across flat, tier, and package pricing
- missing-grants behavior
- delegation parity in `BillingService`
- pre-fetched grants path
- pre-fetched usage path

Target packages:

- `@unprice/services`
- `@unprice/db` only if shared pricing tests need updates

## Validation

- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter @unprice/services test`
- `pnpm typecheck` if the new exported surface affects other workspaces

## Exit Criteria

- `BillingService` no longer owns pricing orchestration.
- `RatingService` is the single orchestration seam for rating.
- Existing invoice behavior is unchanged.
- Incremental usage rating is available for later agent billing work.

## Out Of Scope

- ledger posting
- invoice projection changes
- provider data model changes
- API surface changes unrelated to pricing reuse
