# Unprice Unified Billing — Implementation Plan

> This is the execution plan for moving Unprice from invoice-first billing to
> rating + ledger + settlement. The target architecture must support both human
> subscription billing and agent billing as first-class flows, and it must leave
> the payment-provider layer robust enough for the next provider and later crypto
> settlement.

## Progress Tracking

**After completing each numbered item (for example `1.1`, `1.2`), mark it as
completed by prepending `[x]` to the item title in this document and commit the
change.**

Example:
```
Before: **1.1 — Create RatingService shell**
After:  **[x] 1.1 — Create RatingService shell**
```

This plan is intended to stay current as the implementation evolves.

---

## Architecture Context

For canonical backend boundaries, use:
- [ADR-0001 Canonical Backend Architecture Boundaries](/Users/jhonsfran/repos/unprice/docs/adr/ADR-0001-canonical-backend-architecture-boundaries.md)

This plan replaces the deleted architecture roadmap as the billing-specific
execution document.

The ADR defines the guardrails:
- adapters stay thin
- orchestration lives in use cases
- reusable capabilities live in services
- composition roots own wiring

This plan applies those boundaries to billing, metering, ledger, settlement,
and payment-provider work.

---

## End State

The target architecture is:

```text
Raw Usage Event
  -> RatingService
  -> LedgerService (append-only financial entries)
  -> SettlementRouter
      -> invoice settlement
      -> wallet settlement
      -> one-time/provider-backed settlement
  -> payment provider sync + webhook reconciliation
```

Design intent:
- invoices are settlement artifacts, not the source of financial truth
- pricing math remains centralized and reusable
- payment providers are collection backends, not billing engines
- human subscriptions and agent usage both enter the same rating and ledger pipeline
- the provider layer must support Stripe now, another provider next, and crypto later

---

## Current-Code Conventions

Before starting any phase, align with the code that exists today.

**Canonical architecture boundaries:**
- [ADR-0001 Canonical Backend Architecture Boundaries](/Users/jhonsfran/repos/unprice/docs/adr/ADR-0001-canonical-backend-architecture-boundaries.md)

**Service structure:**
```text
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
Export validators from the real barrel only.

**Use-case barrel:** [internal/services/src/use-cases/index.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/index.ts)
Use cases are async functions and should be re-exported here.

**Pure pricing math:** [internal/db/src/validators/subscriptions/prices.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/subscriptions/prices.ts)
`calculateWaterfallPrice()`, `calculatePricePerFeature()`, `calculateFreeUnits()`, `calculateTierPrice()`, `calculatePackagePrice()`, and `calculateUnitPrice()` are already extracted and must remain the single source of pricing math.

**Current pricing orchestration seam:** [internal/services/src/billing/service.ts](/Users/jhonsfran/repos/unprice/internal/services/src/billing/service.ts)
`BillingService.calculateFeaturePrice()` currently owns grant resolution, billing-window calculation, usage fetching, proration, waterfall preparation, and result mapping. This is the extraction target for `RatingService`.

**Current provider seam:** [internal/services/src/payment-provider/resolver.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/resolver.ts)
This class already resolves provider config, decrypts secrets, and derives provider customer ids. It is the correct seam to evolve.

**Current provider contract:** [internal/services/src/payment-provider/interface.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/interface.ts)
The interface is partly normalized, but it still leaks Stripe via `Stripe.ProductCreateParams` and setup semantics. That contract must become truly provider-neutral before adding the next provider.

**Current provider switch layer:** [internal/services/src/payment-provider/service.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/service.ts)
The current switch-based dispatcher works for Stripe and sandbox, but it is not strong enough yet for webhook normalization and future crypto settlement.

**Current source-of-truth reminders:**
- `plan_versions.paymentProvider` is the current provider source of truth in runtime billing code.
- invoices are currently created from subscription phases and immediately materialized as invoice items.
- `customers.stripeCustomerId` is still present and has a global uniqueness constraint in [internal/db/src/schema/customers.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema/customers.ts).
- customer metadata still stores Stripe-specific fields in [internal/db/src/validators/customer.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators/customer.ts).
- sync ingestion currently requires `customerId` in the request body via [apps/api/src/routes/events/ingestEventsV1.ts](/Users/jhonsfran/repos/unprice/apps/api/src/routes/events/ingestEventsV1.ts).
- `resolveContextProjectId()` currently depends on `customerId` via [apps/api/src/auth/key.ts](/Users/jhonsfran/repos/unprice/apps/api/src/auth/key.ts).
- `EntitlementWindowDO.apply()` currently returns only `{ allowed, deniedReason, message }`, even though it already computes `delta` and `value_after` in [apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](/Users/jhonsfran/repos/unprice/apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts).

**Migration command:**
From `internal/db/`, use the package script in [internal/db/package.json](/Users/jhonsfran/repos/unprice/internal/db/package.json):
```bash
pnpm generate
```

---

## Architectural Rules For This Plan

1. The destination is ledger-first billing. Invoices are derived settlement artifacts.
2. Do not add backward-compatibility layers unless a phase cannot land safely without them.
3. Prefer replacing Stripe-specific paths over maintaining dual-read and dual-write shims.
4. Do not introduce a second pricing implementation. Reuse the pure pricing functions in `@unprice/db/validators/subscriptions/prices.ts`.
5. Keep orchestration in services and use cases, not adapters, per ADR-0001.
6. Keep payment-provider abstractions minimal but strong enough for Stripe, sandbox, the next provider, and later crypto-backed settlement.
7. Keep `LedgerService` as a leaf service. Other services may depend on it; it must not depend on peer domain services.
8. Keep new financial records append-only whenever possible.
9. Do not keep provider choice coupled to plan design longer than necessary. Move runtime provider choice closer to the subscription phase and settlement path.
10. Every phase must move the system closer to the end state, not add temporary architecture.

---

## Phase 1: Extract Pricing Orchestration Into RatingService

> **PR title:** `feat: extract pricing orchestration into RatingService`
>
> **Goal:** Extract pricing orchestration from `BillingService` into
> `RatingService` so pricing is reusable by both subscription billing and agent
> billing.
>
> **Branch:** `feat/rating-service`

### What stays where

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Pure pricing math | `@unprice/db/validators/subscriptions/prices.ts` | Tier, unit, package, free-unit, waterfall math |
| Pricing orchestration | `internal/services/src/rating/` | Grant resolution, billing window, usage fetching, proration, result mapping |
| Invoice settlement logic | `BillingService` | Invoice creation, provider sync, settlement-facing orchestration |

### Commits

**1.1 — Create rating module shell**

Create `internal/services/src/rating/` with:
- `errors.ts` — `UnPriceRatingError`
- `service.ts` — `RatingService`
- `types.ts` — `RatedCharge`, `RatingInput`, and extracted result shapes
- `index.ts` — barrel exports

Constructor deps:
- infrastructure: `db`, `logger`, `analytics`, `cache`, `metrics`, `waitUntil`
- service deps: `grantsManager: GrantsManager`

**1.2 — Extract billing-window, usage, and proration helpers**

Move these helpers out of `BillingService` into `RatingService`:
- `calculateBillingWindow()`
- usage-fetch orchestration currently inside `calculateUsageOfFeatures()`
- `calculateGrantProration()`

Important constraints:
- preserve behavior exactly
- keep support for pre-fetched grants and usage data
- keep helper ownership in the service layer, not validators

**1.3 — Extract `calculateFeaturePrice()` into `RatingService`**

Move the full orchestration pipeline into `RatingService`:
1. fetch grants unless pre-fetched
2. filter grants by feature slug
3. compute entitlement state
4. calculate billing window
5. fetch usage unless provided
6. compute per-grant proration
7. prepare waterfall inputs
8. call `calculateWaterfallPrice()`
9. map results into reusable rating output

**1.4 — Register RatingService in the service graph**

- add `rating: RatingService` to `ServiceContext`
- construct it in [internal/services/src/context.ts](/Users/jhonsfran/repos/unprice/internal/services/src/context.ts)
- export it from [internal/services/package.json](/Users/jhonsfran/repos/unprice/internal/services/package.json)

**1.5 — Make BillingService delegate to RatingService**

Update `BillingService` to call `RatingService` for:
- `_computeInvoiceItems()`
- `estimatePriceCurrentUsage()`
- any other internal pricing call site

Important constraints:
- keep invoice formatting and provider reconciliation in `BillingService`
- remove inline rating duplication from billing

**1.6 — Add `rateBillingPeriod()` and `rateIncrementalUsage()`**

Add two public methods to `RatingService`:
- `rateBillingPeriod()` for statement-period and subscription billing
- `rateIncrementalUsage()` for event-time agent billing using marginal pricing

Incremental algorithm:
- compute price at `usageAfter`
- compute price at `usageBefore`
- return the delta

Important constraints:
- use the same pure pricing math as batch rating
- do not add a second event-rating implementation

**1.7 — Add tests for extraction parity and incremental rating**

Add tests for:
- extracted orchestration parity
- marginal rating across flat, tier, and package pricing
- missing grants behavior
- BillingService delegation parity
- pre-fetched grants and usage path support

---

## Phase 2: Payment Provider Data Foundation

> **PR title:** `feat: add provider data foundation`
>
> **Goal:** Move provider identity and provider settlement data into the right
> tables so runtime billing no longer depends on Stripe-only customer fields or
> plan-version-level provider coupling, while keeping dashboard forms compatible
> with the new schema contracts.
>
> **Branch:** `feat/provider-data-foundation`

### UI Working Patterns (Phase 2/3)

When touching `apps/nextjs` for provider work, follow existing repo patterns:
- server components load data via `~/trpc/server`
- client components use `useTRPC()` + React Query for reads/mutations
- forms use `useZodForm` with `@unprice/db/validators` schemas
- mutation UX uses `toastAction(...)` and `router.refresh()` or `revalidateAppPath(...)`
- preserve slug-scoped routing via `[workspaceSlug]/[projectSlug]`

### Commits

**2.1 — Fix the legacy `stripeCustomerId` uniqueness bug**

The current `stripe_customer_unique` constraint is globally unique and breaks multi-tenancy.

Requirements:
- drop the global unique constraint
- replace it with a project-scoped constraint while legacy data still exists

**2.2 — Add `paymentProvider` to `subscription_phases`**

Move runtime provider choice closer to the billable subscription phase.

Requirements:
- add `paymentProvider` to `subscription_phases`
- treat it as the runtime source of truth for provider-backed subscription billing
- stop treating `plan_versions.paymentProvider` as the long-term runtime source

**2.3 — Add `customer_provider_ids` table**

Create a provider/customer mapping table.

Requirements:
- one row per `(projectId, customerId, provider)`
- unique lookup by `(projectId, provider, providerCustomerId)`
- composite foreign key to `customers`
- `provider` column using existing `paymentProviderEnum`
- `providerCustomerId` text column
- `metadata` JSON column for provider-specific metadata such as subscription ids and default payment method ids

**2.4 — Add provider webhook storage**

Requirements:
- add `webhookSecret` and `webhookSecretIv` to `payment_provider_config`
- add `webhook_events` for idempotent provider event processing
- store raw payload, normalized provider id, event id, status, and error payload for replay/debugging

**2.5 — Add validators and export everything from the real barrels**

Add validators for:
- `customer_provider_ids`
- `webhook_events`
- updated `payment_provider_config`
- updated `subscription_phases`

Export them from:
- [internal/db/src/schema.ts](/Users/jhonsfran/repos/unprice/internal/db/src/schema.ts)
- [internal/db/src/validators.ts](/Users/jhonsfran/repos/unprice/internal/db/src/validators.ts)

**2.6 — Keep UI and tRPC contracts compatible with Phase 2 schema changes**

Scope for this commit is compatibility only, not full UI redesign.

Requirements:
- payment provider config contracts can carry new config fields from Phase 2
  (for example webhook secrets) without breaking existing flows
- payment settings copy/components stop implying Stripe-only ownership for
  generic provider config primitives
- subscription phase create/update contracts carry phase-level `paymentProvider`
  so UI forms can submit/read it
- onboarding and customer payment-method flows keep Stripe + sandbox parity

**2.7 — Generate the migration**

Run from `internal/db/`:
```bash
pnpm generate
```

Important constraint:
- do not hand-maintain transitional dual-read notes in this phase
- this phase lays down the target data model for the runtime refactor that follows

---

## Phase 3: Payment Provider Runtime Refactor

> **PR title:** `feat: refactor payment provider runtime`
>
> **Goal:** Replace the Stripe-centric provider runtime with a provider-neutral
> runtime that can support the next provider now and crypto-backed settlement
> later, and cut over dashboard onboarding/settings flows to the same neutral
> contracts.
>
> **Branch:** `feat/provider-runtime-refactor`

### Commits

**3.1 — Make the provider contract truly provider-neutral**

Refactor [internal/services/src/payment-provider/interface.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/interface.ts).

Requirements:
- remove Stripe types from the public interface
- remove `upsertProduct()` unless a real runtime caller appears
- add webhook verification/parsing hooks to the contract
- keep the contract focused on customer setup, payment methods, invoice sync, payment collection, and webhook normalization

**3.2 — Refactor the provider dispatcher/service layer**

Refactor [internal/services/src/payment-provider/service.ts](/Users/jhonsfran/repos/unprice/internal/services/src/payment-provider/service.ts).

Requirements:
- keep a single normalized provider entry point
- support Stripe and sandbox cleanly
- leave clear extension points for the next provider and later crypto collectors
- add provider capability flags where behavior differs materially

Examples of capability differences:
- billing portal support
- saved payment methods
- invoice line-item mutation support
- synchronous vs asynchronous payment confirmation

**3.3 — Update `PaymentProviderResolver` to the new data model**

Requirements:
- resolve provider customer ids from `customer_provider_ids`
- load webhook secrets from `payment_provider_config`
- stop relying on `customers.stripeCustomerId` as the main provider source
- keep secret decryption in the resolver

**3.4 — Move provider-specific customer metadata out of customer metadata**

Current Stripe-specific fields must move out of customer metadata.

Requirements:
- define a normalized provider-customer metadata type
- store provider-specific metadata in `customer_provider_ids.metadata`
- keep generic customer metadata for customer-owned facts only

**3.5 — Replace plan-version provider reads with phase-level provider reads**

Update runtime billing to read provider from `subscription_phases.paymentProvider`.

Files to update include:
- invoice creation paths
- BillingService provider resolution
- subscription and billing flow reads that currently use `phase.planVersion.paymentProvider`

**3.6 — Replace Stripe-specific completion flows with generic provider completion flows**

Replace:
- [internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts)
- [internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts](/Users/jhonsfran/repos/unprice/internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts)

With provider-neutral use cases and routes.

Requirements:
- provider is explicit in the route and use-case input
- mapping writes go to `customer_provider_ids`
- callback/session completion stays outside adapters and inside use cases

**3.7 — Cut over dashboard and onboarding UI flows**

Requirements:
- payment settings becomes provider-neutral (not Stripe-hardcoded naming/copy)
- onboarding payment-provider step supports provider-neutral selection/setup
- subscription phase UI reads/writes phase-level `paymentProvider` instead of
  relying only on `planVersion.paymentProvider`
- customer payment-method screens keep sandbox parity and preserve
  payment-method-required behavior

**3.8 — Remove legacy Stripe-only fields after runtime cutover**

Remove after all runtime call sites are migrated:
- `customers.stripeCustomerId`
- Stripe-specific fields in customer metadata
- Stripe-only assumptions that remain in resolver or callbacks

**3.9 — Add tests for provider runtime parity and extensibility**

Add tests for:
- resolver behavior with mapping-table-backed provider ids
- provider completion flows
- phase-level provider reads
- Stripe capability behavior
- sandbox parity
- webhook secret loading
- dashboard payment-settings parity after provider-neutral cutover
- onboarding provider setup parity across Stripe and sandbox

---

## Phase 4: Ledger Foundation And Billing Decoupling

> **PR title:** `feat: add ledger foundation and decouple billing from invoices`
>
> **Goal:** Make rated charges and ledger entries the financial source of truth,
> then make invoices a projection and settlement artifact rather than the place
> where pricing is first materialized.
>
> **Branch:** `feat/ledger-foundation`

### Commits

**4.1 — Add ledger schema**

Add `ledgers` and `ledger_entries`.

Requirements:
- one ledger per `(projectId, customerId, currency)`
- append-only entries
- deterministic idempotency key via `sourceType + sourceId`
- `type` enum for `debit` and `credit`
- running balance stored transactionally
- settlement state stored on entries

**4.2 — Add ledger enums and validators**

Requirements:
- entry-type enum
- settlement-type enum
- exports through the real schema and validator barrels
- generated migration

**4.3 — Create LedgerService shell**

Create `internal/services/src/ledger/` with:
- `errors.ts`
- `service.ts`
- `index.ts`

Constructor deps:
- infrastructure only: `db`, `logger`, `metrics`

**4.4 — Implement idempotent posting and read methods**

Add:
- `postDebit()`
- `postCredit()`
- `getUnsettledEntries()`
- `getUnsettledBalance()`
- `markSettled()`

Important constraints:
- retries with the same source identity return the same ledger entry
- running balance is computed transactionally

**4.5 — Register LedgerService in the service graph**

- add `ledger: LedgerService` to `ServiceContext`
- construct it before billing
- inject it into `BillingService`

**4.6 — Have subscription billing post rated charges to the ledger first**

Change billing flow so it no longer treats invoice items as the first financial materialization.

Requirements:
- use `RatingService.rateBillingPeriod()` to produce billable charges
- convert rated charges into deterministic ledger debits
- use stable source ids tied to billing periods and subscription items

**4.7 — Rewrite invoice materialization to consume ledger entries**

Billing must create invoice items from ledger entries, not from direct inline rating.

Requirements:
- load unsettled ledger entries for the statement window
- map them into invoice items
- keep invoice/provider reconciliation logic in billing
- remove invoice-first pricing ownership

**4.8 — Settle ledger entries only after invoice linkage is safely persisted**

Requirements:
- mark invoice-backed entries settled only after invoice persistence succeeds
- settlement metadata must point back to the invoice artifact

**4.9 — Add tests for ledger-first billing**

Add tests for:
- idempotent postings
- running balance correctness
- rating-to-ledger-to-invoice flow
- retry safety in invoice finalization
- invoice projection from unsettled ledger entries

---

## Phase 5: Settlement And Webhook Pipeline

> **PR title:** `feat: add settlement and webhook pipeline`
>
> **Goal:** Add normalized provider settlement and webhook handling on top of
> the ledger-backed billing model.
>
> **Branch:** `feat/settlement-webhooks`

### Commits

**5.1 — Add generic provider webhook route**

Create a generic provider webhook route under `apps/api/src/routes/`.

Requirements:
- raw-body parsing
- header capture
- provider-aware signature verification
- provider resolution through the provider runtime

**5.2 — Persist provider events idempotently**

Requirements:
- insert/load by `(projectId, provider, providerEventId)`
- skip already processed events
- preserve payload and failure state for replay/debugging

**5.3 — Create `processWebhookEvent` use case**

This use case coordinates:
- invoice state transitions
- provider payment status reconciliation
- subscription machine notifications
- ledger settlement updates

**5.4 — Implement Stripe webhook normalization**

Requirements:
- verify Stripe signatures using stored webhook secrets
- normalize supported Stripe events into provider-neutral event types
- return normalized events to the route/use-case layer

**5.5 — Wire invoice payment outcomes into settlement**

Requirements:
- successful payment marks the correct ledger entries settled
- failed payment updates invoice/payment attempt state
- subscription machine receives payment success/failure notifications

**5.6 — Add tests for replay safety and settlement correctness**

Add tests for:
- duplicate webhook delivery
- invalid signatures
- successful settlement
- failed payment state transitions
- refund/dispute reversal handling

---

## Phase 6: Agent Billing Foundation

> **PR title:** `feat: add agent billing foundation`
>
> **Goal:** Make agents first-class billable actors by resolving customers from
> API keys, exposing billing facts from synchronous metering, rating event-time
> usage, and posting that usage into the ledger. Prepare the event schema for
> trace/session grouping and outcome-based pricing.
>
> **Branch:** `feat/agent-billing`
>
> **Detailed plan:** [docs/plans/unprice-phase-06-agent-billing.md](/Users/jhonsfran/repos/unprice/docs/plans/unprice-phase-06-agent-billing.md)

### Commits

**6.1 — Add `apikey_customers` table and service methods**

Add `apikey_customers`, implement API key to customer resolution and linking,
and keep omission of `customerId` valid only for dedicated keys with a single
active binding.

**6.2 — Add `provisionAgentCustomer` use case**

Coordinate customer creation or lookup, dedicated API key linkage, manual grant
creation from explicit `featurePlanVersionIds`, and eager entitlement
materialization.

**6.3 — Make ingestion resolve customer ids from API keys**

Make `customerId` optional at the API edge for dedicated keys. Keep internal
contracts carrying resolved `customerId`.

**6.4 — Persist durable billing facts from synchronous metering**

Extend `EntitlementWindowDO.apply()` so accepted events persist billing facts
and a Durable Object billing outbox. Do not rate in the sync path.

**6.5 — Narrow the `RatingService` seam**

Refactor `rateIncrementalUsage()` into smaller internal steps for context
resolution, single-snapshot rating, and delta calculation so future billing
modes can reuse the same building blocks.

**6.6 — Add `reportAgentUsage` use case**

Consume durable billing facts, rate incremental usage asynchronously, and post
idempotent ledger debits with `sourceType: "agent_usage_v1"`. Settlement
routing deferred to Phase 7.

**6.7 — Wire background agent billing from the Durable Object**

Connect: authenticate → resolve customer → entitlement eval → persist billing
facts → trigger background billing. Failed billing must not corrupt metering
state.

**6.8 — Keep backend ready for future grouping and spend controls**

Preserve enough metadata and billing-fact context for future `operationId`,
estimated spend, and spend-control work without expanding the SDK in this
phase.

**6.9 — Add tests for the full agent-billing path**

---

## Phase 7: Credits, Wallets & Settlement Router

> **PR title:** `feat: add credits, wallets, and settlement router`
>
> **Goal:** Add prepaid credits as the universal billing abstraction for AI
> workloads. Introduce the settlement router for invoice, wallet, and one-time
> settlement modes.
>
> **Branch:** `feat/credits-wallets`
>
> **Detailed plan:** [docs/plans/unprice-phase-07-credits-wallets.md](/Users/jhonsfran/repos/unprice/docs/plans/unprice-phase-07-credits-wallets.md)

### Commits

**7.1 — Add wallet, credit grant, and burn rate schemas**

`wallets`, `credit_grants`, `credit_burn_rates` tables with versioned burn
rates (`effectiveAt`/`supersededAt`).

**7.2 — Add validators and migration**

**7.3 — Create WalletService**

Leaf service. Methods: `getOrCreateWallet`, `addCredits`, `deductCredits`
(atomic check-and-deduct), `getBalance`, `hasEnoughCredits`.

**7.4 — Add SettlementRouter**

Routes charges to `invoice`, `wallet`, or `one_time` settlement.
Default: `invoice` for subscriptions, `wallet` for agent usage.

**7.5 — Wire wallet settlement into agent billing**

Update `reportAgentUsage` to route through SettlementRouter.

**7.6 — Add credit purchase flow**

Use case: provider checkout → payment webhook → `WalletService.addCredits()`.

**7.7 — Add API endpoints**

Wallet balance, purchase, and grant history endpoints. Update SDK types.

**7.8 — Add UI**

Wallet dashboard, credit purchase flow, burn rate configuration, settlement
preference per customer.

**7.9 — Add tests**

---

## Phase 8: Financial Guardrails & Spending Controls

> **PR title:** `feat: add financial guardrails and spending controls`
>
> **Goal:** Prevent runaway agents from generating unbounded charges with
> real-time financial enforcement, spending limits, budget alerts, and circuit
> breakers.
>
> **Branch:** `feat/financial-guardrails`
>
> **Detailed plan:** [docs/plans/unprice-phase-08-financial-guardrails.md](/Users/jhonsfran/repos/unprice/docs/plans/unprice-phase-08-financial-guardrails.md)

### Commits

**8.1 — Add spending limits schema**

`spending_limits` table with scope (customer/session/feature), period, thresholds,
and action (alert/soft_block/hard_block).

**8.2 — Create SpendingGuard service**

Methods: `checkSpendingLimit`, `recordSpend`, `getSpendingSummary`.
Uses cache for hot-path speed, reconciled against ledger.

**8.3 — Wire into sync ingestion**

After entitlement check, before billing: estimate cost → check spending limit →
enforce. Sync response gains `spendingWarning` field.

**8.4 — Add budget alert hooks**

Configurable webhook alerts at spending thresholds. Deduplicated per threshold
per period.

**8.5 — Add circuit breaker for runaway agents**

Cost velocity detection over sliding window. Auto-block on anomalous spend rate.

**8.6 — Add API endpoints and SDK updates**

Spending summary, limit management. SDK types.

**8.7 — Add UI**

Spending limits editor, budget dashboard, alert history, circuit breaker status.

**8.8 — Add tests**

---

## Phase 9: Outcome-Based Pricing & Trace Aggregation

> **PR title:** `feat: add outcome-based pricing and trace aggregation`
>
> **Goal:** Support billing for outcomes rather than raw usage. Branch the
> ingestion path so outcome-based meters aggregate events in a dedicated DO,
> then create billable facts only when the outcome is confirmed or times out.
>
> **Branch:** `feat/outcome-pricing`
>
> **Detailed plan:** [docs/plans/unprice-phase-09-outcome-pricing.md](/Users/jhonsfran/repos/unprice/docs/plans/unprice-phase-09-outcome-pricing.md)

### Commits

**9.1 — Extend meter config for outcome-based meters**

Add `meterType` (usage/outcome), `outcomeConfig` with success condition,
timeout, timeout action, and outcome aggregation method.

**9.2 — Add `groupId` to ingestion schema**

**9.3 — Create `OutcomeAggregationDO`**

Follows EntitlementWindowDO patterns. Aggregates events per group. On success
report or timeout, creates facts that enter the normal rating pipeline.

**9.4 — Branch ingestion routing**

Route outcome-metered or grouped events to OutcomeAggregationDO. Audit path
unchanged (individual events always audited).

**9.5 — Add outcome reporting endpoint**

`POST /v1/outcomes/report` with `groupId` and outcome (success/failure/partial).

**9.6 — Add property-match auto-resolution**

Auto-resolve when event property matches configured success condition.

**9.7 — Add SDK and API**

Event grouping, outcome reporting, status querying. SDK types.

**9.8 — Add UI**

Outcome meter config, trace/session viewer, outcome analytics dashboard.

**9.9 — Add tests**

---

## Phase 10: Compound Metering & Cost Attribution

> **PR title:** `feat: add compound metering and cost attribution`
>
> **Goal:** Support multi-dimensional metering (one event → multiple billing
> facts) and track cost-to-serve for margin analysis.
>
> **Branch:** `feat/compound-metering`
>
> **Detailed plan:** [docs/plans/unprice-phase-10-compound-metering.md](/Users/jhonsfran/repos/unprice/docs/plans/unprice-phase-10-compound-metering.md)

### Commits

**10.1 — Extend meter config for compound meters**

Add `compoundMeters` array with per-dimension aggregation and burn rate
multipliers.

**10.2 — Add compound fan-out in EntitlementWindowDO**

One event → one fact per dimension. Separate aggregation state per dimension.

**10.3 — Add per-dimension rating**

Each dimension rated independently. Total charge = sum of dimension charges.

**10.4 — Add cost table schema**

`cost_tables` with per-feature/dimension cost rates, versioned with
`effectiveAt`/`supersededAt`.

**10.5 — Add cost metadata on meter facts**

Optional `cost_cents` and `cost_source` on facts for margin tracking.

**10.6 — Add margin analytics**

Per-customer and per-feature margin calculation from ledger + cost data.

**10.7 — Add API endpoints and SDK updates**

Margin queries, cost table management. SDK types.

**10.8 — Add UI**

Compound meter config, cost table editor, margin dashboard.

**10.9 — Add tests**

---

## Phase Summary

```text
Phase 1: Rating Foundation
  Extract pricing orchestration from BillingService into RatingService and add
  reusable billing-period and event-time rating.

Phase 2: Payment Provider Data Foundation
  Add the schema needed for provider-neutral runtime billing: phase-level
  provider choice, provider/customer mappings, webhook secrets, and webhook
  event storage, plus compatibility updates so dashboard forms keep working.

Phase 3: Payment Provider Runtime Refactor
  Replace Stripe-centric runtime assumptions with a provider-neutral runtime
  that can support the next provider now and crypto-backed collectors later,
  and cut over dashboard/onboarding provider UX to the same contracts.

Phase 4: Ledger Foundation And Billing Decoupling
  Make ledger entries the financial source of truth and make invoices a
  projection and settlement artifact.

Phase 5: Settlement And Webhook Pipeline
  Add provider settlement reconciliation and normalized webhook handling.

Phase 6: Agent Billing Foundation
  Make agents first-class billable actors that flow through rating and ledger.
  Prepare event schema for trace grouping and outcome pricing.

Phase 7: Credits, Wallets & Settlement Router
  Add prepaid credits as the universal AI billing abstraction. Introduce the
  settlement router for invoice, wallet, and one-time settlement modes.

Phase 8: Financial Guardrails & Spending Controls
  Prevent runaway agents with real-time financial enforcement, spending limits,
  budget alerts, and circuit breakers.

Phase 9: Outcome-Based Pricing & Trace Aggregation
  Support billing for outcomes rather than raw usage via OutcomeAggregationDO.
  Group events by task, bill on success or timeout.

Phase 10: Compound Metering & Cost Attribution
  Support multi-dimensional metering and track cost-to-serve for margin
  analysis.
```

## Dependencies And Parallel Tracks

```text
Track A (Core Billing):
  Phase 1 -> Phase 4

Track B (Provider):
  Phase 2 -> Phase 3 -> Phase 5

Track C (Agent Billing):
  Phase 6 depends on Phases 1, 3, 4
  Phase 7 depends on Phases 4, 5

Track D (Advanced Billing):
  Phase 8 depends on Phases 6, 7
  Phase 9 depends on Phases 6, 7
  Phase 10 depends on Phases 6, 7
```

Explicit dependency list:
1. Phase 1 is required before Phase 4 and Phase 6.
2. Phase 2 is required before Phase 3 and Phase 5.
3. Phase 3 is required before Phase 5 and before provider-backed settlement in Phase 6.
4. Phase 4 is required before Phase 5, Phase 6, and Phase 7.
5. Phase 5 is required before Phase 7 (credit purchase needs webhook confirmation).
6. Phase 6 depends on Phases 1, 3, and 4.
7. Phase 7 depends on Phases 4 and 5.
8. Phases 8, 9, and 10 each depend on Phases 6 and 7.
9. Phases 6 and 7 can run in parallel (no dependency between them).
10. Phases 8, 9, and 10 can run in parallel after both 6 and 7 complete.

Sequential execution order: 6 → 7 → 8 → 9 → 10

## Related Documents

- [AI Billing Trends 2024-2026](docs/ai-billing-trends-2024-2026.md) — industry
  trend analysis that informed phases 6-10
- [ADR-0001 Canonical Backend Architecture Boundaries](docs/adr/ADR-0001-canonical-backend-architecture-boundaries.md)

## Non-Goals For The First Pass

- building a second pricing engine outside `@unprice/db/validators/subscriptions/prices.ts`
- keeping long-lived dual-read or dual-write migration layers for Stripe-specific storage
- treating invoices as the long-term source of financial truth
- adding provider abstractions that solve imaginary providers instead of the next real provider plus future crypto requirements
- moving orchestration into adapters instead of services and use cases
- nested outcomes (outcome groups within outcome groups)
- ML-based cost prediction or anomaly detection
- crypto-backed credit purchase (the settlement router leaves room for it)
