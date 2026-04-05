# Unprice Unified Billing — Refined Implementation Plan

> This plan is designed to be executed by an agent, one phase per PR, one
> commit per todo item when practical. If a commit fails hooks or tests, fix it
> before moving on. If the plan conflicts with what the code actually does,
> update the plan before continuing.

## Progress Tracking

**After completing each numbered item (for example `1.1`, `1.2`), mark it as
completed by prepending `[x]` to the item title in this document and commit the
change.**

Example:
```
Before: **1.1 — Create RatingService shell**
After:  **[x] 1.1 — Create RatingService shell**
```

This keeps the plan usable as a living handoff document.

---

## Current-Code Conventions

Before starting any phase, align with the code that exists today.

**Service structure:**
```
internal/services/src/[service-name]/
  ├── service.ts
  ├── errors.ts
  ├── index.ts
  └── *.test.ts
```

**Composition root:** [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts)
Build services in dependency order inside `createServiceContext(deps)`.

**Shared infrastructure deps:** [internal/services/src/deps.ts](/Users/jhonsfran/repos/unprice/internal/services/src/deps.ts)
The current shared contract is `ServiceDeps = { db, logger, analytics, waitUntil, cache, metrics }`.
Use that shape as the baseline for new services.

**DB schema barrel:** [internal/db/src/schema.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema.ts)
Tables live under `internal/db/src/schema/` and are re-exported from `schema.ts`.

**DB validator barrel:** [internal/db/src/validators.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators.ts)
Do not export from a non-existent `internal/db/src/validators/index.ts`.

**Use-case barrel:** [internal/services/src/use-cases/index.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/index.ts)
Use cases are async functions and should be re-exported here.

**Current pricing seam:** [internal/services/src/billing/service.ts](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts)
`BillingService.calculateFeaturePrice()` already encapsulates most of the pricing logic that should be extracted and reused. Do not create a second pricing algorithm unless behavior intentionally changes.

**Current provider seam:** [internal/services/src/payment-provider/resolver.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts)
This class already resolves provider config, decrypts provider secrets, and derives the provider customer id. Prefer evolving this seam instead of bypassing it.

**Current source-of-truth reminders:**
- `plan_versions.paymentProvider` is the current provider source of truth.
- `customers.stripeCustomerId` is still actively read and written.
- sync ingestion currently requires `customerId` in the request body.
- `EntitlementWindowDO.apply()` currently returns only `{ allowed, deniedReason, message }`.

**Migration command:**
From `internal/db/`, use the package script in [internal/db/package.json](/Users/jhonsfran/repos/unprice/internal/db/package.json):
```bash
pnpm generate
```

---

## Architectural Rules For This Plan

1. Extract shared logic before adding new behavior.
2. Prefer dual-read and dual-write migrations over big-bang replacements.
3. Do not mark ledger entries settled until some existing runtime path can actually consume that settlement state.
4. Do not introduce a second pricing implementation for incremental usage.
5. Keep new types near the service layer unless they are truly DB-facing types.
6. Preserve existing Stripe callback routes until generic provider flows reach parity.

---

## Phase 1: Extract Pricing Core And RatingService

> **PR title:** `feat: extract pricing core into RatingService`
>
> **Goal:** Move shared pricing logic out of `BillingService` so invoice pricing
> and future incremental usage pricing both rely on the same implementation.
>
> **Branch:** `feat/rating-service`

### Commits

**1.1 — Create rating module shell**

Create `internal/services/src/rating/` with:
- `errors.ts` — `UnPriceRatingError`
- `service.ts` — `RatingService`
- `types.ts` — service-layer types such as `RatedCharge`
- `index.ts` — barrel exports

Notes:
- Keep `RatedCharge` in the service layer, not in `@unprice/db/validators`.
- Match the current error pattern from [internal/services/src/billing/errors.ts](/Users/jhonsfran/repos/unprice/internal/services/src/billing/errors.ts).

Files to read first:
- [internal/services/src/billing/errors.ts](/Users/jhonsfran/repos/unprice/internal/services/src/billing/errors.ts)
- [internal/services/src/deps.ts](/Users/jhonsfran/repos/unprice/internal/services/src/deps.ts)

**1.2 — Extract shared pricing helpers from BillingService**

Move the reusable pricing helpers out of `BillingService` into `RatingService`
or a rating-local helper module.

Target logic to extract first:
- billing window calculation
- usage resolution helpers
- grant proration helpers
- waterfall attribution inputs
- the body of `calculateFeaturePrice()`

Important constraint:
- This step must preserve existing behavior exactly.
- `BillingService` should delegate to the extracted logic rather than maintain a fork.

Files to read first:
- [internal/services/src/billing/service.ts#L2363](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L2363)
- [internal/services/src/entitlements/grants.ts#L464](/Users/jhonsfran/repos/unprice/internal/services/src/entitlements/grants.ts#L464)
- [internal/db/src/validators/subscriptions/prices.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/subscriptions/prices.ts)

**1.3 — Register RatingService in the service graph**

- Add `rating: RatingService` to `ServiceContext`
- Construct it in [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts)
- Export it from [internal/services/package.json](/Users/jhonsfran/repos/unprice/internal/services/package.json)

**1.4 — Make BillingService delegate pricing to RatingService**

Update `BillingService` to call the extracted pricing core for:
- `_computeInvoiceItems`
- `estimatePriceCurrentUsage`
- any other direct `calculateFeaturePrice()` call sites

Important constraint:
- Keep the invoice-item update logic in `BillingService`.
- This step is about extracting computation, not changing the invoice persistence flow.

Files to read first:
- [internal/services/src/billing/service.ts#L1034](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L1034)
- [internal/services/src/billing/service.ts#L2778](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L2778)

**1.5 — Add `rateBillingPeriod()` as a thin wrapper over the extracted pricing core**

Implement `rateBillingPeriod()` only after the shared pricing core exists.

Requirements:
- It must reuse the same extracted logic already used by `BillingService`.
- It should return a service-layer `RatedCharge[]` projection.
- It must not introduce a second usage-fetching or grant-resolution algorithm.

**1.6 — Add `rateIncrementalUsage()` using the same pricing core**

Implement incremental usage rating only after extraction is complete.

Requirements:
- Resolve grants through `GrantsManager`
- Reuse the extracted pricing behavior for usage-based features
- Do not implement this as a standalone "new total minus old total" shortcut unless it matches the extracted pricing logic for all supported configurations
- Explicitly validate behavior for tiered, package, and proration-sensitive cases

**1.7 — Write unit tests for RatingService and delegated BillingService behavior**

Add tests for:
- extracted pricing parity with current invoice behavior
- incremental flat pricing
- incremental tier boundary behavior
- package pricing
- missing grants / empty-grant behavior
- `BillingService` continuing to produce the same invoice item totals through delegation

Files to read first:
- [internal/services/src/plans/plans.test.ts](/Users/jhonsfran/repos/unprice/internal/services/src/plans/plans.test.ts)
- [internal/db/src/validators/subscriptions/prices.test.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/subscriptions/prices.test.ts)

---

## Phase 2: Provider Mapping Foundation

> **PR title:** `feat: add provider mapping foundation`
>
> **Goal:** Introduce provider-agnostic storage without breaking the current
> Stripe-backed customer and callback flows.
>
> **Branch:** `feat/provider-mapping-foundation`

### Commits

**2.1 — Add `customer_provider_ids` table**

Create a provider mapping table for external customer ids.

Requirements:
- one row per `(projectId, customerId, provider)`
- unique lookup by `(projectId, provider, providerCustomerId)`
- foreign key back to `customers`
- export from [internal/db/src/schema.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema.ts)

**2.2 — Add `apikey_customers` table**

Create a mapping table between API keys and customers.

Requirements:
- unique lookup by `(projectId, apikeyId)`
- foreign keys to `apikeys` and `customers`
- export from the schema barrel

**2.3 — Add webhook event storage**

Create `webhook_events` for idempotent provider webhook processing.

Requirements:
- unique lookup by `(projectId, provider, providerEventId)`
- `status` enum with at least `pending`, `processed`, `failed`
- payload and error storage for replay/debugging

**2.4 — Extend payment provider config for webhook verification**

Current provider config stores only the encrypted API key.
Before the webhook phase, add storage for webhook verification secrets.

Important constraint:
- Keep encryption handling aligned with the existing provider secret flow.
- If a second encrypted secret is added, document exactly how it is read and decrypted.

Files to read first:
- [internal/db/src/schema/paymentConfig.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema/paymentConfig.ts)
- [internal/db/src/validators/paymentConfig.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/paymentConfig.ts)

**2.5 — Add validators and export them from the real barrel**

Add validators for:
- `customer_provider_ids`
- `apikey_customers`
- `webhook_events`

Export from:
- [internal/db/src/validators.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators.ts)

**2.6 — Add `paymentProvider` snapshot to `subscription_phases` as additive state**

If this denormalized column is needed, add it as a snapshot field only.

Important constraint:
- Do not switch all readers immediately.
- `plan_versions.paymentProvider` remains the source of truth until all runtime readers are migrated.

Files to read first:
- [internal/db/src/schema/planVersions.ts#L73](/Users/jhonsfran/repos/unprice/internal/db/src/schema/planVersions.ts#L73)
- [internal/db/src/schema/subscriptions.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema/subscriptions.ts)

**2.7 — Generate migration with the project script**

From `internal/db/`, run:
```bash
pnpm generate
```

Do not edit the generated SQL by hand unless there is a repo-specific migration policy requiring it.

**2.8 — Add dual-read and dual-write migration notes to the plan implementation**

This phase is not complete until the rollout strategy is explicit:
- continue reading `customers.stripeCustomerId` during transition
- write to both legacy Stripe fields and `customer_provider_ids`
- backfill existing Stripe customer ids into the new mapping table
- only remove legacy reads after all callbacks and resolver paths are migrated

Files to read first:
- [internal/services/src/payment-provider/resolver.ts#L106](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts#L106)
- [internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts#L160](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts#L160)
- [internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts#L132](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts#L132)

---

## Phase 3: Payment Collector Transition

> **PR title:** `feat: normalize payment collection interface`
>
> **Goal:** Introduce a provider-agnostic collector abstraction while preserving
> the current resolver responsibilities and Stripe routes until parity is proven.
>
> **Branch:** `feat/payment-collector`

### Commits

**3.1 — Define collector interface and normalized types**

Create a provider-agnostic collector contract under `internal/services/src/payment-provider/`.

Requirements:
- no Stripe-specific types in the public collector interface
- normalized invoice, payment method, and webhook event types
- clear capability flags where provider behavior differs

Files to read first:
- [internal/services/src/payment-provider/interface.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/interface.ts)

**3.2 — Implement Stripe and Sandbox collectors as adapters**

Adapt the existing provider implementations instead of rewriting behavior from scratch.

Files to read first:
- [internal/services/src/payment-provider/stripe.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/stripe.ts)
- [internal/services/src/payment-provider/sandbox.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/sandbox.ts)

**3.3 — Evolve `PaymentProviderResolver` instead of bypassing it**

Keep the resolver responsible for:
- loading provider config
- decrypting secrets
- resolving provider customer ids
- returning the normalized collector implementation

Important constraint:
- Do not move secret decryption or config lookup into random call sites.

Files to read first:
- [internal/services/src/payment-provider/resolver.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts)

**3.4 — Update CustomerService to return the normalized collector**

Migrate `CustomerService.getPaymentProvider()` toward a normalized collector API.

Requirements:
- dual-read provider customer ids from the new mapping table and the legacy Stripe field during rollout
- keep current call sites working while the migration is in progress

Files to read first:
- [internal/services/src/customers/service.ts#L1127](/Users/jhonsfran/repos/unprice/internal/services/src/customers/service.ts#L1127)

**3.5 — Migrate BillingService provider calls without shrinking behavior prematurely**

Move BillingService to the new collector abstraction while preserving the current provider invoice reconciliation flow.

Important constraint:
- Do not force everything into a single `createInvoice(items)` call if that would remove the existing `getInvoice` / `addInvoiceItem` / `updateInvoiceItem` reconciliation path.
- Preserve current invoice verification behavior.

Files to read first:
- [internal/services/src/billing/service.ts#L1428](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L1428)

**3.6 — Add generic provider callback use case without deleting Stripe routes yet**

Create a provider-agnostic callback completion use case.

Requirements:
- reuse the normalized collector
- write provider mappings through `customer_provider_ids`
- continue dual-writing any legacy Stripe fields during transition
- keep existing Stripe routes alive until the generic route has test parity

Files to read first:
- [internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts)
- [internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts)
- [apps/api/src/routes/paymentProvider/stripeSignUpV1.ts](/Users/jhonsfran/repos/unprice/apps/api/src/routes/paymentProvider/stripeSignUpV1.ts)
- [apps/api/src/routes/paymentProvider/stripeSetupV1.ts](/Users/jhonsfran/repos/unprice/apps/api/src/routes/paymentProvider/stripeSetupV1.ts)

**3.7 — Write tests for resolver, collectors, and generic callback parity**

Add tests for:
- resolver dual-read behavior
- Stripe collector invoice and payment method calls
- Sandbox collector behavior
- generic callback idempotency
- migration parity with current Stripe callback behavior

---

## Phase 4: Add Idempotent Ledger Foundation

> **PR title:** `feat: add idempotent ledger foundation`
>
> **Goal:** Introduce append-only ledger storage that is safe under retries and
> can serve as the accounting layer between rating and settlement.
>
> **Branch:** `feat/ledger-foundation`

### Commits

**4.1 — Add ledger schema**

Add `ledgers` and `ledger_entries` tables.

Requirements:
- one ledger per `(projectId, customerId, currency)`
- append-only entries
- settlement metadata
- source identity metadata for idempotency

Important constraint:
- The schema must support deterministic deduplication of retried postings.
- Do not rely on callers to "just not retry".

**4.2 — Add ledger enums and validators**

Add enums and validator exports for ledger rows.

Export through the real schema and validator barrels.

**4.3 — Create LedgerService shell**

Create `internal/services/src/ledger/` with:
- `errors.ts`
- `service.ts`
- `index.ts`
- tests

**4.4 — Implement idempotent `postDebit()` and `postCredit()`**

Requirements:
- deterministic source identity, for example a `sourceType + sourceId` pair
- retries must not create duplicate financial entries
- running balance must be derived in a transaction

Important constraint:
- Billing currently retries invoice finalization in failure scenarios, so ledger posting must tolerate repeated attempts.

Files to read first:
- [internal/services/src/billing/service.ts#L1632](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L1632)

**4.5 — Implement `getUnsettledBalance()` and `markSettled()`**

Add read and state-transition methods for unsettled ledger entries.

Important constraint:
- `markSettled()` should be reserved for flows that already have a real downstream consumer or confirmed payment result.

**4.6 — Register LedgerService in the service graph**

- add it to `ServiceContext`
- construct it in [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts)
- export it from [internal/services/package.json](/Users/jhonsfran/repos/unprice/internal/services/package.json)

**4.7 — Post invoice-backed debits from BillingService using deterministic source ids**

When wiring the ledger into billing:
- use stable source ids, tied to invoice and item identity
- avoid duplicate posting on retries
- skip zero-value debits unless there is a strong accounting reason to persist them

Important constraint:
- This phase only writes debits that correspond to known internal billing artifacts.

**4.8 — Write unit tests for retry safety and running balances**

Add tests for:
- sequential balances
- idempotent reposting with the same source identity
- unsettled balance reads
- settlement marking
- auto-creation of missing ledgers

---

## Phase 5: Make Billing Consume Ledger Entries Before General Settlement

> **PR title:** `feat: consume unsettled ledger charges in billing`
>
> **Goal:** Add the missing bridge between ledger debits and actual invoice or
> collection behavior. Without this phase, a settlement router would create a
> dead end.
>
> **Branch:** `feat/ledger-consumption`

### Commits

**5.1 — Define how subscription-backed ledger debits become invoice lines**

Introduce a clear mapping from unsettled ledger entries to invoice items.

Requirements:
- deterministic linkage between ledger entries and invoice lines
- ability to trace an invoice line back to the ledger source
- no duplicate attachment across retries

**5.2 — Teach BillingService to include unsettled subscription-backed ledger debits**

Before any generic settlement router is added, BillingService must be able to:
- discover eligible unsettled ledger entries
- turn them into invoiceable items
- persist linkage metadata

Important constraint:
- Entries should only be marked settled after the invoice linkage is safely persisted.

**5.3 — Define one-time collection state without prematurely settling entries**

For one-time charges:
- create a pending collection record or equivalent linkage state
- do not mark ledger entries settled before payment success exists

**5.4 — Add wallet settlement only if it is immediate and reversible**

Wallet-backed settlement is the only path that can safely post a balancing credit and mark entries settled in one phase, because it is an internal funding source.

If wallet infrastructure does not exist yet, keep wallet support behind an explicit later dependency.

**5.5 — Only now add a SettlementService / SettlementRouter**

After billing consumption exists, add the settlement orchestration layer.

Routing rules:
- `wallet`: immediate internal credit + settlement marking
- `subscription`: leave entries billable by the subscription invoice flow until consumed
- `one_time`: leave entries pending collection until payment succeeds
- `threshold_invoice`: design only, no implementation required

Important constraint:
- Do not implement subscription and one-time settlement as "just mark entries settled".

**5.6 — Write tests around consumption and settlement semantics**

Add tests for:
- unsettled debits appearing on the next invoice exactly once
- wallet-backed settlement posting a balancing credit
- one-time flows remaining pending before payment success
- subscription flows remaining consumable by billing before final settlement

---

## Phase 6: Webhook Pipeline

> **PR title:** `feat: add provider webhook pipeline`
>
> **Goal:** Add provider webhook handling only after provider mapping, webhook
> secret storage, ledger, and settlement semantics are in place.
>
> **Branch:** `feat/webhook-pipeline`

### Commits

**6.1 — Add generic webhook route skeleton**

Create a generic provider webhook route under `apps/api/src/routes/`.

Requirements:
- parse raw body and headers
- resolve the normalized collector through the existing provider resolver seam
- verify signatures using stored webhook secrets

**6.2 — Implement idempotent event persistence with `webhook_events`**

For each normalized event:
- insert or load by `(projectId, provider, providerEventId)`
- skip already processed events
- preserve payload and failure context for replay/debugging

**6.3 — Create `processWebhookEvent` use case**

Use a dedicated use case for invoice, ledger, and subscription-machine coordination.

Requirements:
- `payment.succeeded` updates invoice state and settles the right ledger entries
- `payment.failed` updates invoice/payment attempt state and reports machine failure
- dispute/refund paths use reversal-style ledger entries when appropriate

Files to read first:
- [internal/services/src/billing/service.ts#L340](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts#L340)
- [internal/services/src/subscriptions/machine.ts](/Users/jhonsfran/repos/unprice/internal/services/src/subscriptions/machine.ts)

**6.4 — Implement Stripe webhook parsing in the collector**

Requirements:
- verify signatures correctly
- normalize supported Stripe event types
- return provider-agnostic webhook events to the route/use-case layer

**6.5 — Register the route after parity tests pass**

Wire the route into [apps/api/src/index.ts](/Users/jhonsfran/repos/unprice/apps/api/src/index.ts) only after:
- signature verification works
- idempotency is covered by tests
- success/failure invoice transitions are covered by tests

**6.6 — Write tests for replay safety and ledger reconciliation**

Add tests for:
- duplicate webhook delivery
- successful payment settling ledger entries
- failed payment updating invoice attempts / state transitions
- invalid signatures being rejected

---

## Phase 7: Agent Billing Contract And Runtime Flow

> **PR title:** `feat: add agent billing flow`
>
> **Goal:** Support API-key-backed customer billing, but only after the API and
> ingestion contracts are extended to make that possible.
>
> **Branch:** `feat/agent-billing`

### Commits

**7.1 — Add `apikey_customers` service methods and tRPC mutation**

Implement:
- API key to customer resolution
- API key to customer linking

Use the existing tRPC apikey router surface as the first integration point.

Files to read first:
- `internal/trpc/src/router/lambda/apikeys/`
- [internal/services/src/apikey/service.ts](/Users/jhonsfran/repos/unprice/internal/services/src/apikey/service.ts)

**7.2 — Keep manual grants as a verification step, not a speculative refactor**

The current `GrantsManager.createGrant()` already supports `type: "manual"`.
This step should verify and test agent provisioning scenarios instead of assuming a subscription dependency that does not currently exist.

Files to read first:
- [internal/services/src/entitlements/grants.ts#L837](/Users/jhonsfran/repos/unprice/internal/services/src/entitlements/grants.ts#L837)

**7.3 — Extend the sync ingestion API contract to support API-key-only resolution**

Before wiring agent billing into ingestion:
- make `customerId` optional for the sync ingestion route if API-key-backed resolution is intended
- resolve the customer from `apikey_customers` when the request omits `customerId`
- update `resolveContextProjectId()` and request validation accordingly

Important constraint:
- This is an API contract change, not just an internal service tweak.

Files to read first:
- [apps/api/src/routes/events/ingestEventsSyncV1.ts](/Users/jhonsfran/repos/unprice/apps/api/src/routes/events/ingestEventsSyncV1.ts)
- [apps/api/src/auth/key.ts#L191](/Users/jhonsfran/repos/unprice/apps/api/src/auth/key.ts#L191)
- [apps/api/src/routes/events/ingestEventsV1.ts#L26](/Users/jhonsfran/repos/unprice/apps/api/src/routes/events/ingestEventsV1.ts#L26)

**7.4 — Extend the entitlement-window contract to expose billing facts if needed**

`reportAgentUsage()` cannot be wired as originally proposed until the DO/service path exposes enough information, such as `delta` and `valueAfter`.

Requirements:
- decide whether that data should come from `EntitlementWindowDO.apply()` directly or from another stable interface
- update the service contract and tests first
- only then wire downstream rating and ledger posting

Files to read first:
- [apps/api/src/ingestion/EntitlementWindowDO.ts#L121](/Users/jhonsfran/repos/unprice/apps/api/src/ingestion/EntitlementWindowDO.ts#L121)
- [internal/services/src/ingestion/service.ts#L768](/Users/jhonsfran/repos/unprice/internal/services/src/ingestion/service.ts#L768)

**7.5 — Add `reportAgentUsage` use case after the contract exists**

Once the ingestion contract provides enough facts:
- rate the incremental usage through `RatingService`
- post idempotent ledger debits
- resolve funding strategy
- settle only through the semantics established in Phase 5

Important constraint:
- this use case is downstream of the ingestion contract change, not a prerequisite for it

**7.6 — Wire `reportAgentUsage` into the sync ingestion path**

Only after `customerId` resolution and metering-fact output are both available.

Important constraint:
- do not insert speculative calls into the ingestion path before the data contract is real

**7.7 — Add `provisionAgentCustomer` use case**

Coordinate:
- customer creation or lookup
- api key linking
- manual grant creation
- optional wallet top-up, if wallet infrastructure exists by then

**7.8 — Write tests for the full agent-billing path**

Add tests for:
- API key to customer resolution
- provisioning with manual grants
- sync ingestion with API-key-only customer resolution
- incremental rating and ledger posting after metering facts are available

---

## Phase 8: Trace Aggregation DO (Optional Extension)

> **PR title:** `feat: add trace aggregation durable object`
>
> **Goal:** Aggregate trace-scoped usage events before billing them. This is a
> useful extension, but it is not required to land the pricing, provider,
> ledger, and agent-billing foundations above.
>
> **Branch:** `feat/trace-aggregation`

### Commits

**8.1 — Create TraceAggregationDO skeleton**

Follow the Durable Object and SQLite patterns used by [apps/api/src/ingestion/EntitlementWindowDO.ts](/Users/jhonsfran/repos/unprice/apps/api/src/ingestion/EntitlementWindowDO.ts).

**8.2 — Add trace routing in ingestion**

Requirements:
- detect trace-scoped events
- buffer them under a stable trace key
- complete explicitly or on timeout
- re-emit aggregated results through the normal ingestion path

**8.3 — Add alarm-based timeout and cleanup**

Mirror the existing alarm and self-destruction patterns where appropriate.

**8.4 — Add integration tests**

Add tests for:
- explicit completion
- timeout completion
- multi-feature aggregation
- duplicate event handling

---

## Phase Summary

```
Phase 1: Extract Pricing Core And RatingService
  First remove duplication risk. Make BillingService and incremental usage rating
  share one pricing implementation.

Phase 2: Provider Mapping Foundation
  Add provider/customer mapping, API-key/customer mapping, webhook event storage,
  and webhook-secret support with dual-read and dual-write migration rules.

Phase 3: Payment Collector Transition
  Normalize the payment interface by evolving the existing resolver seam instead
  of bypassing it. Keep Stripe callback routes until parity is proven.

Phase 4: Add Idempotent Ledger Foundation
  Add retry-safe ledger storage and deterministic posting semantics.

Phase 5: Make Billing Consume Ledger Entries Before General Settlement
  Add the missing runtime path that turns ledger debits into invoiceable or
  collectable work. Only then introduce a generic settlement router.

Phase 6: Webhook Pipeline
  Add signature verification, event idempotency, invoice transitions, and ledger
  reconciliation.

Phase 7: Agent Billing Contract And Runtime Flow
  Extend the API and ingestion contracts first, then wire agent usage into
  rating, ledger, and settlement.

Phase 8: Trace Aggregation DO (Optional Extension)
  Add trace-scoped aggregation after the main billing foundations are stable.
```

## Dependencies

1. Phase 1 is a prerequisite for safe incremental usage rating.
2. Phase 2 is a prerequisite for Phases 3 and 6.
3. Phase 3 depends on Phase 2.
4. Phase 4 depends on Phase 1.
5. Phase 5 depends on Phase 4.
6. Phase 6 depends on Phases 2, 3, 4, and 5.
7. Phase 7 depends on Phases 1, 2, 4, and 5, and partially on Phase 6 if one-time settlement is provider-backed.
8. Phase 8 depends on Phase 7 only if trace aggregation is part of the agent-billing path.

## Non-Goals For The First Pass

- removing `customers.stripeCustomerId` in the same PR that introduces provider mappings
- deleting Stripe callback routes before generic-provider parity exists
- marking subscription-backed or one-time ledger entries settled before there is a consumer for them
- introducing a second standalone pricing algorithm for incremental usage
