# Unprice Unified Billing — Implementation Plan

> This plan is designed to be executed by an agent, one phase per PR, one commit
> per todo item. Commit hooks handle validation and linting. If a commit fails
> hooks or tests, fix it before moving on. If the plan conflicts with what the
> code actually does, stop and ask for clarification.

## Progress Tracking

**After completing each numbered item (e.g., 1.1, 1.2, ...), mark it as done
by prepending `[x]` to the item title in this document and commit it.**

Example:
```
Before: **1.1 — Create RatingService skeleton with error class**
After:  **[x] 1.1 — Create RatingService skeleton with error class**
```

This makes the plan a living document. The next agent (or you) can pick up
exactly where work stopped.

---

## Conventions

Before starting any phase, internalize these patterns from the codebase:

**Service structure:**
```
internal/services/src/[service-name]/
  ├── service.ts      — class with constructor({ deps }) and Result<T, E> methods
  ├── errors.ts       — class extending BaseError from @unprice/error
  ├── index.ts        — re-exports: export * from "./errors"; export * from "./service"
  └── [name].test.ts  — vitest tests
```

**Composition root:** `internal/services/src/context.ts` — `createServiceContext(deps)`.
All services are created here in dependency order. Leaf services first, then services
that depend on them.

**Infrastructure deps:** `internal/services/src/deps.ts` — `ServiceDeps` interface.
Every service receives `{ db, logger, ... }` from this.

**Result pattern:** All public methods return `Promise<Result<T, CustomError>>`.
Use `Ok(val)` and `Err(new CustomError({ message }))` from `@unprice/error`.

**Schema pattern:** Tables in `internal/db/src/schema/[table].ts`, use `pgTableProject()`,
export from `internal/db/src/schema.ts`. Validators in `internal/db/src/validators/`.

**Test pattern:** vitest with `vi.fn()` mocks. Tests live next to implementation.
Name: `[service].test.ts`. Use `describe/it/expect`.

**Use-case pattern:** When an operation coordinates multiple services (e.g.,
sign-up creates a customer then a subscription then provisions grants), it lives
as an **async function** in `internal/services/src/use-cases/[domain]/[name].ts`.

Use-case function signature:
```typescript
export async function useCaseName(
  deps: {
    services: Pick<ServiceContext, "service1" | "service2">
    db: Database
    logger: Logger
    analytics: Analytics
    waitUntil: (promise: Promise<any>) => void
  },
  input: InputType,
): Promise<Result<OutputType, ErrorType>>
```

Key rules for use cases:
- **Use `Pick<ServiceContext, ...>`** to declare only the services needed
- **Pass `db: tx`** to service calls when atomicity is required (transaction)
- **Use `waitUntil()`** for background/fire-and-forget operations (analytics, cache)
- **Barrel-export** from `internal/services/src/use-cases/index.ts`
- **Never create services inside a use case** — receive them via deps

Reference files:
- `internal/services/src/use-cases/customer/sign-up.ts` (complex multi-service orchestration)
- `internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts` (payment flow completion)
- `internal/services/src/use-cases/index.ts` (barrel exports)

---

## Phase 1: Extract RatingService

> **PR title:** `feat: extract RatingService from BillingService`
>
> **Goal:** Create a standalone `RatingService` that can rate usage events
> without requiring an invoice or subscription. This decouples rating from
> billing and enables all downstream phases.
>
> **Branch:** `feat/rating-service`

### Commits

**1.1 — Create RatingService skeleton with error class**

Create `internal/services/src/rating/` directory with:

- `errors.ts` — `UnPriceRatingError` extending `BaseError<{ context?: Record<string, unknown> }>`.
  Follow the exact pattern from `internal/services/src/billing/errors.ts`.

- `service.ts` — `RatingService` class with constructor taking:
  ```typescript
  constructor({
    db,
    logger,
    analytics,
    grantsManager,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    grantsManager: GrantsManager
  })
  ```
  No methods yet, just the class shell.

- `index.ts` — barrel exports for errors and service.

Files to read first:
- `internal/services/src/billing/errors.ts` (error pattern)
- `internal/services/src/deps.ts` (ServiceDeps type)

**1.2 — Define RatedCharge type**

In `internal/db/src/validators/`, create `rating.ts` with:

```typescript
export interface RatedCharge {
  sourceType: "usage_event" | "billing_period" | "one_time"
  sourceId: string
  customerId: string
  projectId: string
  featureSlug: string
  quantity: number
  usage: number
  amountAtomic: number       // cents
  currency: string
  unitAmountAtomic: number
  prorate: number            // 0-1
  grantId?: string | null
  included: number
  limit: number | null
  isTrial: boolean
  cycleStartAt: number
  cycleEndAt: number
  traceId?: string
  metadata?: Record<string, unknown>
}
```

Export from `internal/db/src/validators/index.ts`.

Files to read first:
- `internal/db/src/validators/shared.ts` (see how types are exported)
- `internal/db/src/validators/index.ts` (barrel exports)

**1.3 — Implement `rateIncrementalUsage` method**

This method rates a single usage event using the DO's running total to compute
marginal cost. It does NOT query Tinybird — it uses `currentUsage` passed from
the DO.

Add to `RatingService`:

```typescript
async rateIncrementalUsage(input: {
  customerId: string
  projectId: string
  featureSlug: string
  quantity: number         // delta from DO Fact
  currentUsage: number     // value_after - delta from DO
  timestamp: number
  traceId?: string
  metadata?: Record<string, unknown>
}): Promise<Result<RatedCharge, UnPriceRatingError>>
```

Implementation:
1. Call `this.grantsManager.getGrantsForCustomer({ customerId, projectId, now: timestamp })`
2. Filter grants for the feature slug
3. Call `this.grantsManager.computeEntitlementState({ grants, customerId, projectId })`
4. Compute marginal price: `calculatePricePerFeature(config, featureType, currentUsage + quantity)` minus `calculatePricePerFeature(config, featureType, currentUsage)`
5. Return `Ok(ratedCharge)` with the marginal cost

Files to read first:
- `internal/services/src/billing/service.ts` lines 1034-1233 (`_computeInvoiceItems` — the logic to extract)
- `internal/services/src/entitlements/grants.ts` lines 464-609 (`getGrantsForCustomer`)
- `internal/db/src/validators/subscriptions/prices.ts` (`calculatePricePerFeature`, `calculateTierPrice`)

**1.4 — Implement `rateBillingPeriod` method**

This method rates a batch of features for a subscription billing period. It
queries Tinybird for the authoritative total usage.

Add to `RatingService`:

```typescript
async rateBillingPeriod(input: {
  customerId: string
  projectId: string
  features: Array<{
    featureSlug: string
    featureType: FeatureType
    config: z.infer<typeof configFeatureSchema>
    subscriptionItemId: string
    cycleStartAt: number
    cycleEndAt: number
    prorate: number
  }>
  now: number
}): Promise<Result<RatedCharge[], UnPriceRatingError>>
```

Implementation: Extract the core logic from `BillingService._computeInvoiceItems`
(lines 1034-1233) and `BillingService.calculateFeaturePrice`. The key steps:

1. Call `grantsManager.getGrantsForCustomer()`
2. Group grants by feature slug
3. For each feature, compute entitlement state
4. Batch fetch usage from `this.analytics.getUsageBillingFeatures()`
5. Call `calculateWaterfallPrice` or `calculatePricePerFeature` per feature
6. Return `RatedCharge[]`

This is extraction, not new logic. The computation must produce identical
results to the current `_computeInvoiceItems`.

Files to read first:
- `internal/services/src/billing/service.ts` lines 1034-1300 (the full `_computeInvoiceItems`)
- `internal/services/src/billing/service.ts` lines 2363-2605 (`calculateFeaturePrice`)
- `internal/analytics/src/analytics.ts` lines 296-378 (`getUsageBillingFeatures`)

**1.5 — Register RatingService in context.ts**

- Add `RatingService` to the `ServiceContext` interface as `rating: RatingService`
- Create it in `createServiceContext()` at the leaf level (depends on grantsManager + analytics)
- Add export to `internal/services/package.json` exports map: `"./rating": "./src/rating/index.ts"`

Files to modify:
- `internal/services/src/context.ts`
- `internal/services/package.json`

**1.6 — Write unit tests for RatingService**

Create `internal/services/src/rating/rating.test.ts`:

- Test `rateIncrementalUsage` with flat pricing (simplest case)
- Test `rateIncrementalUsage` with graduated tiered pricing, verifying marginal
  cost is correct when crossing a tier boundary
- Test `rateIncrementalUsage` with volume tiered pricing, verifying the tier
  repricing delta
- Test `rateIncrementalUsage` with package pricing
- Test `rateIncrementalUsage` when grants are missing (should return error)
- Test `rateBillingPeriod` with mocked analytics returning usage data

Mock `grantsManager` and `analytics` using `vi.fn()`. Follow the pattern in
`internal/services/src/plans/plans.test.ts`.

For tiered pricing tests, use concrete tier configs from
`internal/db/src/validators/subscriptions/prices.test.ts` as reference — those
tests already validate `calculateTierPrice` behavior.

Files to read first:
- `internal/services/src/plans/plans.test.ts` (test pattern)
- `internal/db/src/validators/subscriptions/prices.test.ts` (pricing test data)

**1.7 — Wire BillingService to use RatingService for `_finalizeInvoice`**

- Add `ratingService: RatingService` to `BillingService` constructor deps
- Update `createServiceContext()` — pass `rating` to `billing`
- In `_finalizeInvoice`, replace the inline `_computeInvoiceItems` call with
  `this.ratingService.rateBillingPeriod()` and map the `RatedCharge[]` results
  to update invoice items

The invoice item update logic stays in BillingService. Only the computation
moves to RatingService. Verify that existing billing tests still pass.

Files to modify:
- `internal/services/src/billing/service.ts`
- `internal/services/src/context.ts`

---

## Phase 2: Add Ledger

> **PR title:** `feat: add ledger service with append-only entries`
>
> **Goal:** Create `ledger_entries` table and `LedgerService` as an
> append-only financial log between rating and settlement.
>
> **Branch:** `feat/ledger-service`

### Commits

**2.1 — Create ledger schema tables**

Add `internal/db/src/schema/ledger.ts`:

- `ledgers` table: `{ id, projectId, customerId, currency, ...timestamps }`
  with unique constraint on `(projectId, customerId, currency)`
- `ledger_entries` table: `{ id, projectId, ledgerId, entryType, sourceType, sourceId, amountAtomic, currency, balanceAfter, featureSlug, customerId, description, settlementId, settledAt, metadata, createdAt }`
  with index on unsettled entries (`WHERE settlement_id IS NULL`)
- Define relations: `ledger → entries`, `ledger → customer`
- Export from `internal/db/src/schema.ts`

Use `pgTableProject()`, `cuid()`, `timestamps`, `projectID` helpers following
the pattern in `internal/db/src/schema/invoices.ts`.

`entryType` should be a new pgEnum: `ledger_entry_type` with values
`['debit', 'credit', 'reversal', 'settlement']`.
`sourceType` should be a new pgEnum: `ledger_source_type` with values
`['usage_event', 'billing_period', 'manual', 'wallet_topup', 'refund', 'adjustment']`.

Add them in `internal/db/src/schema/enums.ts`.

Files to read first:
- `internal/db/src/schema/invoices.ts` (table pattern)
- `internal/db/src/schema/enums.ts` (enum pattern)
- `internal/db/src/schema.ts` (export barrel)

**2.2 — Generate Drizzle migration**

Run `pnpm drizzle-kit generate` (or the project's migration command) from
`internal/db/`. Verify the generated SQL creates the correct tables and
indexes. Do NOT edit migrations by hand.

Read the project's `package.json` scripts to find the exact migration command.

Files to read first:
- `internal/db/package.json` (scripts section)

**2.3 — Create ledger validators**

Add `internal/db/src/validators/ledger.ts`:

- `ledgerSelectSchema` using `createSelectSchema(schema.ledgers)`
- `ledgerEntrySelectSchema` using `createSelectSchema(schema.ledgerEntries)`
- `ledgerEntryInsertSchema` using `createInsertSchema(schema.ledgerEntries)`
- Export types: `LedgerEntry`, `Ledger`

Export from `internal/db/src/validators/index.ts`.

Files to read first:
- `internal/db/src/validators/customer.ts` (validator pattern)

**2.4 — Create LedgerService skeleton with error class**

Create `internal/services/src/ledger/`:

- `errors.ts` — `UnPriceLedgerError`
- `service.ts` — `LedgerService` class with constructor:
  ```typescript
  constructor({ db, logger }: { db: Database; logger: Logger })
  ```
- `index.ts` — barrel exports

**2.5 — Implement `postDebit` method**

```typescript
async postDebit(charge: RatedCharge): Promise<Result<LedgerEntry, UnPriceLedgerError>>
```

Implementation:
1. Wrap in `this.db.transaction()`
2. Ensure ledger exists for `(projectId, customerId, currency)` — upsert with `onConflictDoNothing`
3. Get current balance: query last entry by `ledgerId` ordered by `createdAt DESC`
4. Insert new entry: `{ entryType: "debit", amountAtomic: charge.amountAtomic, balanceAfter: currentBalance + charge.amountAtomic, ... }`
5. Return `Ok(entry)`

Files to read first:
- `internal/services/src/billing/service.ts` lines 894-1029 (transaction pattern)

**2.6 — Implement `postCredit` method**

```typescript
async postCredit(input: {
  projectId: string
  customerId: string
  amountAtomic: number
  currency: string
  sourceType: string
  sourceId: string
  description: string
}): Promise<Result<LedgerEntry, UnPriceLedgerError>>
```

Same pattern as postDebit but `entryType: "credit"` and amount stored as
negative (credits reduce balance).

**2.7 — Implement `getUnsettledBalance` and `markSettled` methods**

```typescript
async getUnsettledBalance(input: {
  projectId: string
  customerId: string
}): Promise<Result<{ balance: number; entries: LedgerEntry[] }, UnPriceLedgerError>>

async markSettled(input: {
  entryIds: string[]
  settlementId: string
}): Promise<Result<void, UnPriceLedgerError>>
```

`getUnsettledBalance`: query entries where `settlementId IS NULL`, sum `amountAtomic`.
`markSettled`: update entries, set `settlementId` and `settledAt: Date.now()`.

**2.8 — Register LedgerService in context.ts**

- Add to `ServiceContext` interface as `ledger: LedgerService`
- Create at leaf level (depends only on `db`, `logger`)
- Add export to `internal/services/package.json`

**2.9 — Write unit tests for LedgerService**

Create `internal/services/src/ledger/ledger.test.ts`:

- Test `postDebit` creates entry with correct balance
- Test `postDebit` sequential entries maintain running balance
- Test `postCredit` creates negative amount entry, reduces balance
- Test `getUnsettledBalance` returns only entries with no settlementId
- Test `markSettled` sets settlementId and settledAt on entries
- Test `postDebit` with no existing ledger auto-creates one

Mock `db` with `vi.fn()` for queries. Follow existing test patterns.

**2.10 — Wire BillingService to post ledger entries after rating**

In `BillingService._finalizeInvoice`, after calling `ratingService.rateBillingPeriod()`
and updating invoice items, add:

```typescript
for (const charge of ratedCharges) {
  await this.ledgerService.postDebit(charge)
}
```

Add `ledgerService: LedgerService` to BillingService constructor. Update
`createServiceContext()`.

This is additive — the existing invoice flow continues working. The ledger
entries are written alongside the invoice items.

---

## Phase 3: Provider Schema Changes

> **PR title:** `feat: provider-agnostic schema (customer_provider_ids, apikey_customers)`
>
> **Goal:** Decouple customer records from Stripe-specific fields. Add tables
> for multi-provider customer mapping and API-key-to-customer linking.
>
> **Branch:** `feat/provider-schema`

### Commits

**3.1 — Create `customer_provider_ids` table**

Add to `internal/db/src/schema/customers.ts` (or new file `providerMapping.ts`):

```typescript
export const customerProviderIds = pgTableProject("customer_provider_ids", {
  ...projectID,
  ...timestamps,
  customerId: cuid("customer_id").notNull(),
  provider: paymentProviderEnum("provider").notNull(),
  providerCustomerId: text("provider_customer_id").notNull(),
}, (table) => ({
  primary: primaryKey({ columns: [table.id, table.projectId], name: "customer_provider_ids_pkey" }),
  uniqueCustomerProvider: uniqueIndex("cpid_customer_provider_idx")
    .on(table.projectId, table.customerId, table.provider),
  uniqueProviderCustomer: uniqueIndex("cpid_provider_customer_idx")
    .on(table.projectId, table.provider, table.providerCustomerId),
  customerfk: foreignKey({
    columns: [table.customerId, table.projectId],
    foreignColumns: [customers.id, customers.projectId],
    name: "cpid_customer_fkey",
  }).onDelete("cascade"),
}))
```

Export from schema barrel. Add relations.

**3.2 — Create `apikey_customers` table**

Add `internal/db/src/schema/apikeyCustomers.ts`:

```typescript
export const apikeyCustomers = pgTableProject("apikey_customers", {
  ...projectID,
  ...timestamps,
  apikeyId: cuid("apikey_id").notNull(),
  customerId: cuid("customer_id").notNull(),
}, (table) => ({
  primary: primaryKey({ columns: [table.id, table.projectId], name: "apikey_customers_pkey" }),
  uniqueApikey: uniqueIndex("akc_apikey_idx").on(table.projectId, table.apikeyId),
  apikeyfk: foreignKey({
    columns: [table.apikeyId, table.projectId],
    foreignColumns: [apikeys.id, apikeys.projectId],
    name: "akc_apikey_fkey",
  }).onDelete("cascade"),
  customerfk: foreignKey({
    columns: [table.customerId, table.projectId],
    foreignColumns: [customers.id, customers.projectId],
    name: "akc_customer_fkey",
  }).onDelete("cascade"),
}))
```

Export from schema barrel. Add relations to apikeys and customers.

**3.3 — Add `paymentProvider` to `subscription_phases`**

Add column:
```typescript
paymentProvider: paymentProviderEnum("payment_provider").notNull().default("stripe"),
```

to the `subscriptionPhases` table in `internal/db/src/schema/subscriptions.ts`.

**3.4 — Generate migration**

Run migration generation. The migration should:
- CREATE `customer_provider_ids` table
- CREATE `apikey_customers` table
- ALTER `subscription_phases` ADD COLUMN `payment_provider`

**3.5 — Create validators for new tables**

- `internal/db/src/validators/providerMapping.ts` — select/insert schemas
  for `customerProviderIds`
- `internal/db/src/validators/apikeyCustomers.ts` — select/insert schemas
  for `apikeyCustomers`
- Export from validators barrel

**3.6 — Add `webhook_events` table**

Add `internal/db/src/schema/webhookEvents.ts`:

Table: `{ id, projectId, provider, providerEventId, eventType, status, payload, error, createdAt, processedAt }`
Unique constraint on `(projectId, provider, providerEventId)`.
Status enum: `['pending', 'processed', 'failed']`.

Export from schema barrel. Generate migration.

**3.7 — Write tests validating schema constraints**

Create `internal/db/src/validators/providerMapping.test.ts`:

- Test `customerProviderIdsInsertSchema` validates required fields
- Test `apikeyCustomersInsertSchema` validates required fields
- Test that validators reject invalid data

---

## Phase 4: PaymentCollector Interface

> **PR title:** `feat: replace PaymentProviderInterface with PaymentCollector`
>
> **Goal:** Create a smaller, provider-agnostic payment collection interface.
> Rewrite StripePaymentProvider as StripeCollector. Delete the old switch router.
>
> **Branch:** `feat/payment-collector`

### Commits

**4.1 — Define PaymentCollector interface and normalized types**

Create `internal/services/src/payment-provider/collector.ts`:

- `PaymentCollector` interface with 8 methods: `ensureCustomer`, `setupPaymentMethod`,
  `listPaymentMethods`, `createInvoice`, `collectPayment`, `getPaymentStatus`,
  `parseWebhook`, and `capabilities` property
- Normalized types: `SetupResult`, `NormalizedPaymentMethod`,
  `NormalizedPaymentResult`, `NormalizedWebhookEvent`, `ProviderCapabilities`
- `CollectorError` extending BaseError

No Stripe types anywhere in this file. All types are provider-agnostic.

Files to read first:
- `internal/services/src/payment-provider/interface.ts` (current interface — note what to simplify)

**4.2 — Implement StripeCollector**

Create `internal/services/src/payment-provider/stripe-collector.ts`:

Implements `PaymentCollector`. Constructor takes `{ token, providerCustomerId, logger }`.

Map existing `StripePaymentProvider` methods to the new interface:
- `ensureCustomer` — new (creates Stripe customer if not exists)
- `setupPaymentMethod` — wraps current `createSession` in setup mode
- `listPaymentMethods` — wraps current `listPaymentMethods`
- `createInvoice` — wraps current `createInvoice` + `addInvoiceItem` (single call with all items)
- `collectPayment` — wraps current `collectPayment`
- `getPaymentStatus` — wraps current `getStatusInvoice`
- `parseWebhook` — new (Stripe signature verification + event normalization)
- `capabilities` — `{ supportsAutoCharge: true, supportsSendInvoice: true, supportsRefunds: true, supportsWebhooks: true, supportedCurrencies: ["USD", "EUR", ...], settlementType: "fiat" }`

Files to read first:
- `internal/services/src/payment-provider/stripe.ts` (existing implementation to wrap)

**4.3 — Implement SandboxCollector**

Create `internal/services/src/payment-provider/sandbox-collector.ts`:

Thin implementation returning mock data. Follow the pattern from
`internal/services/src/payment-provider/sandbox.ts`.

**4.4 — Create `resolveCollector` factory function**

Create `internal/services/src/payment-provider/resolve.ts`:

```typescript
export function resolveCollector(
  provider: PaymentProvider,
  token: string,
  providerCustomerId: string | undefined,
  logger: Logger,
): PaymentCollector {
  switch (provider) {
    case "stripe":
      return new StripeCollector({ token, providerCustomerId, logger })
    case "sandbox":
      return new SandboxCollector({ providerCustomerId, logger })
    default:
      throw new Error(`Unknown payment provider: ${provider}`)
  }
}
```

**4.5 — Update CustomerService to use `customer_provider_ids` table**

In `CustomerService`, add method:

```typescript
async getPaymentCollector(input: {
  customerId?: string
  projectId: string
  provider: PaymentProvider
}): Promise<Result<PaymentCollector, ...>>
```

This method:
1. Queries `paymentProviderConfig` for the API key (existing logic)
2. Queries `customerProviderIds` for the provider customer mapping (new table)
3. Calls `resolveCollector()` with the resolved data

Files to modify:
- `internal/services/src/customers/service.ts`

**4.6 — Update BillingService._upsertPaymentProviderInvoice to use PaymentCollector**

Replace the current provider calls in `_upsertPaymentProviderInvoice`
(billing/service.ts:1372+) to use the new `PaymentCollector.createInvoice()`
with all items in a single call.

Files to modify:
- `internal/services/src/billing/service.ts`

**4.7 — Create `completeProviderSetup` use case (replaces Stripe-specific callbacks)**

Create `internal/services/src/use-cases/payment-provider/complete-provider-setup.ts`:

This replaces the Stripe-specific `completeStripeSignUp` and `completeStripeSetup`
use cases with a generic provider-agnostic version.

```typescript
type CompleteProviderSetupDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions">
  db: Database
  logger: Logger
  analytics: Analytics
  waitUntil: (promise: Promise<any>) => void
}

type CompleteProviderSetupInput = {
  projectId: string
  provider: PaymentProvider
  providerSessionData: Record<string, string>  // query params from callback
  customerSessionId: string
}

export async function completeProviderSetup(
  deps: CompleteProviderSetupDeps,
  input: CompleteProviderSetupInput,
): Promise<Result<{ customerId: string; subscriptionId: string }, ...>>
```

Coordination:
1. Resolve collector via `resolveCollector(provider, ...)`
2. Call collector-specific session retrieval (each collector knows its callback format)
3. Insert into `customer_provider_ids` (store the provider customer mapping)
4. Find the pending customer session in DB
5. If subscription was pending: activate it via `deps.services.subscriptions`
6. Fire analytics event via `deps.waitUntil()`

This is used by a new generic callback route: `GET /v1/checkout/complete/:provider`
that replaces the existing `/v1/paymentProvider/stripe/signUp/...` and
`/v1/paymentProvider/stripe/setup/...` routes.

Export from `internal/services/src/use-cases/index.ts`.

Files to read first:
- `internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts` (current implementation to generalize)
- `internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts`

**4.8 — Write tests for StripeCollector, SandboxCollector, and completeProviderSetup**

Create `internal/services/src/payment-provider/collector.test.ts`:

- Test SandboxCollector returns expected mock values for all methods
- Test `resolveCollector` returns correct implementation per provider
- Test StripeCollector.createInvoice builds correct Stripe API call shape
  (mock the Stripe SDK client)

Create `internal/services/src/use-cases/payment-provider/complete-provider-setup.test.ts`:

- Test with sandbox provider: resolves session, stores mapping, activates subscription
- Test with missing customer session: returns error
- Test idempotency: calling twice with same session doesn't duplicate

---

## Phase 5: Settlement Router

> **PR title:** `feat: add settlement router (wallet, subscription, one_time)`
>
> **Goal:** Create a thin dispatch layer that settles ledger entries via one
> of three funding sources. Design the type for `threshold_invoice` but don't
> implement it.
>
> **Branch:** `feat/settlement-router`

### Commits

**5.1 — Define FundingSource and SettlementResult types**

Create `internal/services/src/settlement/types.ts`:

```typescript
export type FundingSource =
  | { kind: "wallet"; walletId: string }
  | { kind: "subscription"; subscriptionId: string; phaseId: string }
  | { kind: "one_time" }
  | { kind: "threshold_invoice"; thresholdCents: number }  // designed, not implemented

export interface SettlementResult {
  settled: boolean
  amount: number
  remainder?: number
  reason?: string
}
```

**5.2 — Create SettlementRouter skeleton with error class**

Create `internal/services/src/settlement/`:

- `errors.ts` — `UnPriceSettlementError`
- `service.ts` — `SettlementRouter` class with constructor:
  ```typescript
  constructor({
    db,
    logger,
    ledger,
  }: {
    db: Database
    logger: Logger
    ledger: LedgerService
  })
  ```
- `index.ts` — barrel exports

**5.3 — Implement `settle` dispatch method**

```typescript
async settle(input: {
  projectId: string
  customerId: string
  funding: FundingSource
}): Promise<Result<SettlementResult, UnPriceSettlementError>>
```

Implementation:
1. Call `this.ledger.getUnsettledBalance()` — if balance <= 0, return settled
2. Switch on `input.funding.kind`:
   - `"wallet"` → call `this.settleFromWallet()`
   - `"subscription"` → call `this.attachToSubscription()`
   - `"one_time"` → call `this.settleOneTime()`
   - `"threshold_invoice"` → throw "not implemented"

**5.4 — Implement `settleFromWallet` (wallet debit via ledger credit)**

For now, this posts a credit entry to the ledger to offset the debits. The
actual WalletDO integration comes in Phase 7. The ledger-based settlement
is sufficient for the accounting side.

```typescript
private async settleFromWallet(
  unsettled: { balance: number; entries: LedgerEntry[] },
  funding: Extract<FundingSource, { kind: "wallet" }>,
): Promise<Result<SettlementResult, UnPriceSettlementError>>
```

1. Post a credit entry: `this.ledger.postCredit({ sourceType: "wallet_debit", ... })`
2. Mark original entries as settled: `this.ledger.markSettled({ entryIds, settlementId })`
3. Return `{ settled: true, amount }`

**5.5 — Implement `attachToSubscription`**

This attaches unsettled charges to the next subscription invoice. It marks
them as settled with a reference to the subscription.

```typescript
private async attachToSubscription(
  unsettled: { balance: number; entries: LedgerEntry[] },
  funding: Extract<FundingSource, { kind: "subscription" }>,
): Promise<Result<SettlementResult, UnPriceSettlementError>>
```

1. Mark entries as settled with `settlementId` referencing the subscription
2. The entries will be picked up at next invoice finalization
3. Return `{ settled: true, amount }`

**5.6 — Implement `settleOneTime`**

This creates a one-time charge. For now, it just marks entries as settled —
the actual provider collection will be wired when the webhook pipeline exists.

**5.7 — Implement `resolveFundingSource` helper**

```typescript
async resolveFundingSource(
  customerId: string,
  projectId: string,
): Promise<FundingSource>
```

1. Check for active subscription → return `{ kind: "subscription" }`
2. Default to `{ kind: "one_time" }`
   (Wallet check added in Phase 7 when WalletDO exists)

**5.8 — Register in context.ts**

- Add `settlement: SettlementRouter` to ServiceContext
- Create after `ledger` (depends on LedgerService)
- Add export to package.json

**5.9 — Write tests for SettlementRouter**

Create `internal/services/src/settlement/settlement.test.ts`:

- Test `settle` with wallet funding posts credit and marks settled
- Test `settle` with subscription funding marks settled with subscription ref
- Test `settle` with one_time funding marks settled
- Test `settle` with zero balance returns immediately
- Test `settle` with threshold_invoice throws not implemented
- Test `resolveFundingSource` returns subscription when active, one_time otherwise

---

## Phase 6: Webhook Pipeline

> **PR title:** `feat: add webhook pipeline with normalized event processing`
>
> **Goal:** Add a generic webhook endpoint that parses provider-specific
> events and writes results to the ledger.
>
> **Branch:** `feat/webhook-pipeline`

### Commits

**6.1 — Add webhook route skeleton**

Create `apps/api/src/routes/webhooks/providerWebhookV1.ts`:

- Route: `POST /v1/webhooks/:provider/:projectId`
- Parse raw body and headers
- Resolve collector for the provider
- Call `collector.parseWebhook()`

Files to read first:
- `apps/api/src/routes/events/ingestEventsV1.ts` (route pattern)
- `apps/api/src/hono/env.ts` (env bindings)

**6.2 — Implement idempotent event processing loop**

In the webhook route handler:

1. For each normalized event from `parseWebhook()`:
   - Check `webhookEvents` table for existing `(projectId, provider, providerEventId)`
   - If `status === "processed"`, skip
   - Process event based on type
   - Insert into `webhookEvents` with `status: "processed"`

**6.3 — Create `processWebhookEvent` use case**

Create `internal/services/src/use-cases/webhook/process-event.ts`:

This use case coordinates multiple services when processing a webhook event.
It is a use case (not inline route logic) because it touches invoices, the
ledger, and optionally the subscription machine.

```typescript
type ProcessWebhookEventDeps = {
  services: Pick<ServiceContext, "billing" | "subscriptions" | "ledger">
  db: Database
  logger: Logger
}

type ProcessWebhookEventInput = {
  event: NormalizedWebhookEvent
  projectId: string
}

export async function processWebhookEvent(
  deps: ProcessWebhookEventDeps,
  input: ProcessWebhookEventInput,
): Promise<Result<{ processed: boolean }, UnPriceWebhookError>>
```

Dispatches on `event.type`:

- `"payment.succeeded"`: find invoice → update status to `"paid"` →
  `deps.services.ledger.postCredit()` (settlement confirmation entry) →
  if subscription-backed, call subscription machine `reportInvoiceSuccess`
- `"payment.failed"`: update invoice payment attempts →
  if subscription-backed, call subscription machine `reportPaymentFailure`
- `"payment_method.expired"`: log warning, optionally notify
- `"dispute.created"`: flag invoice, post reversal to ledger

Export from `internal/services/src/use-cases/index.ts`.

Files to read first:
- `internal/services/src/use-cases/customer/sign-up.ts` (use-case pattern)
- `internal/services/src/billing/service.ts` lines 308-356 (`billingInvoice` — how it calls the machine)

**6.4 — Implement `payment.succeeded` inside the use case**

In `processWebhookEvent`:

1. Find invoice by `providerInvoiceId` in `invoices` table
2. Update invoice: `status: "paid"`, `paidAt: event.data.paidAt`
3. Post ledger settlement entry: `ledgerService.postCredit({ sourceType: "settlement", ... })`
4. Mark related ledger entries as settled: `ledgerService.markSettled()`
5. If invoice has `subscriptionId`, report success to subscription machine

**6.5 — Implement `payment.failed` inside the use case**

Update invoice payment attempts. If subscription-backed, call
`SubscriptionMachine.reportPaymentFailure` to trigger state transition.

**6.6 — Implement Stripe webhook parsing in StripeCollector**

Implement `parseWebhook()` in StripeCollector:

1. Verify signature using `stripe.webhooks.constructEvent(body, sig, secret)`
2. Map Stripe event types to normalized types:
   - `invoice.payment_succeeded` → `payment.succeeded`
   - `invoice.payment_failed` → `payment.failed`
   - `customer.source.expiring` → `payment_method.expired`
   - `charge.dispute.created` → `dispute.created`
3. Return `NormalizedWebhookEvent[]`

**6.7 — Register webhook route and wire the use case**

Add route to the Hono app router. The route handler:
1. Parses raw body + headers
2. Resolves collector
3. Calls `collector.parseWebhook()`
4. For each event, checks idempotency in `webhook_events` table
5. Calls `processWebhookEvent(deps, { event, projectId })`
6. Marks event as processed in `webhook_events`

Wire provider config lookup for webhook signing secrets.

Files to read first:
- `apps/api/src/routes/` (how routes are registered)

**6.8 — Write tests for webhook processing and processWebhookEvent use case**

- Test idempotency: same event processed twice, second is skipped
- Test `payment.succeeded` updates invoice and posts ledger entry
- Test `payment.failed` updates invoice attempts
- Test StripeCollector.parseWebhook with valid Stripe payload
- Test StripeCollector.parseWebhook rejects invalid signature

---

## Phase 7: Agent Billing Flow

> **PR title:** `feat: agent billing via API key with wallet support`
>
> **Goal:** Wire the complete agent billing flow: API key → customer resolution,
> manual grants, wallet-based settlement, and the TraceAggregationDO.
>
> **Branch:** `feat/agent-billing`

### Commits

**7.1 — Add customer resolution from API key**

In `ApiKeysService` (or `CustomerService`), add:

```typescript
async resolveCustomerFromApiKey(input: {
  apikeyId: string
  projectId: string
}): Promise<Result<{ customerId: string }, ...>>
```

Queries `apikeyCustomers` table. Returns the linked customer ID.

Files to modify:
- `internal/services/src/apikey/service.ts` or `internal/services/src/customers/service.ts`

**7.2 — Add API key → customer linking endpoint**

If tRPC routes exist for apikeys, add a `linkCustomer` mutation that inserts
into `apikey_customers`. If not, add the method to `ApiKeysService`.

Files to read first:
- `internal/trpc/src/router/` (existing tRPC route patterns)

**7.3 — Add manual grant creation for agents**

Verify that the existing `GrantsManager.createGrant()` supports:
- `subjectType: "customer"` with no subscription
- `type: "manual"`
- A `featurePlanVersionId` for pricing/meter config

If the current implementation requires a subscription context, remove that
requirement for manual grants. The grant should only need `subjectType`,
`subjectId`, `featurePlanVersionId`, `limit`, `effectiveAt`, `expiresAt`.

Files to read first:
- `internal/services/src/entitlements/grants.ts` (`createGrant` method)

**7.4 — Update IngestionService sync path to support API key → customer**

In the sync ingestion endpoint, before calling `ingestFeatureSync`, resolve
the customer from the API key if no `customerId` is provided directly.

The existing auth middleware already resolves the API key. Add customer
resolution as an optional step when the caller is an API key (agent) rather
than a direct customer.

Files to read first:
- `apps/api/src/routes/events/ingestEventsSyncV1.ts`
- `apps/api/src/middleware/` (auth middleware)

**7.5 — Create `reportAgentUsage` use case**

Create `internal/services/src/use-cases/agent/report-usage.ts`:

This is the main cross-service coordination for agent billing. It touches
rating, ledger, and settlement after the DO meter update succeeds.

```typescript
type ReportAgentUsageDeps = {
  services: Pick<ServiceContext, "rating" | "ledger" | "settlement">
  logger: Logger
}

type ReportAgentUsageInput = {
  customerId: string
  projectId: string
  featureSlug: string
  delta: number           // from DO Fact.delta
  valueAfter: number      // from DO Fact.valueAfter
  timestamp: number
  traceId?: string
  metadata?: Record<string, unknown>
}

export async function reportAgentUsage(
  deps: ReportAgentUsageDeps,
  input: ReportAgentUsageInput,
): Promise<Result<{
  charged: number
  currency: string
  settled: boolean
  fundingKind: string
}, UnPriceAgentUsageError>>
```

Coordination:
1. Rate: `deps.services.rating.rateIncrementalUsage({ quantity: input.delta, currentUsage: input.valueAfter - input.delta, ... })`
2. Ledger: `deps.services.ledger.postDebit(charge)`
3. Settle: `deps.services.settlement.resolveFundingSource(customerId, projectId)` then `deps.services.settlement.settle({ funding })`
4. Return charged amount, settlement status

No transaction needed — each step is independent and idempotent (the DO already
committed the meter update, and the ledger is append-only).

Export from `internal/services/src/use-cases/index.ts`.

Files to read first:
- `internal/services/src/use-cases/customer/sign-up.ts` (use-case deps pattern)

**7.6 — Wire `reportAgentUsage` into sync ingestion path**

In the sync ingestion path (`apps/api/src/ingestion/service.ts`), after the
EntitlementWindowDO returns a successful `apply()` with `{ delta, valueAfter }`:

```typescript
// After DO apply succeeds and returns facts:
const fact = facts[0]
if (fact) {
  await reportAgentUsage(
    { services: { rating, ledger, settlement }, logger },
    {
      customerId,
      projectId,
      featureSlug,
      delta: fact.delta,
      valueAfter: fact.valueAfter,
      timestamp,
    },
  )
}
```

The use case handles all the cross-service coordination. The ingestion service
just calls it after the meter update.

This is additive — the existing sync path continues working. The use case call
happens after the successful meter update.

Files to modify:
- `apps/api/src/ingestion/service.ts` (sync processing path)

**7.7 — Create `provisionAgentCustomer` use case**

Create `internal/services/src/use-cases/agent/provision-customer.ts`:

This use case coordinates the setup of an agent customer: links API key to
customer, creates manual grants, and optionally tops up a wallet.

```typescript
type ProvisionAgentCustomerDeps = {
  services: Pick<ServiceContext, "apikeys" | "customers" | "grantsManager" | "ledger">
  db: Database
  logger: Logger
}

type ProvisionAgentCustomerInput = {
  projectId: string
  apikeyId: string
  customer: { email: string; name: string }
  grants: Array<{
    featurePlanVersionId: string
    limit: number
    expiresInDays: number
  }>
  walletTopUpCents?: number
  currency?: string
}

export async function provisionAgentCustomer(
  deps: ProvisionAgentCustomerDeps,
  input: ProvisionAgentCustomerInput,
): Promise<Result<{ customerId: string }, ...>>
```

Coordination (inside transaction for atomicity):
1. Create or find customer via `deps.db` insert/upsert
2. Link API key → customer in `apikey_customers`
3. For each grant config, call `deps.services.grantsManager.createGrant({
   subjectType: "customer", subjectId: customerId, type: "manual", ... })`
4. If `walletTopUpCents`, call `deps.services.ledger.postCredit({
   sourceType: "wallet_topup", ... })`

Export from `internal/services/src/use-cases/index.ts`.

This is the admin/dashboard use case for setting up agent customers.

**7.8 — Create TraceAggregationDO skeleton**

Create `apps/api/src/ingestion/TraceAggregationDO.ts`:

- Durable Object with SQLite storage (same pattern as EntitlementWindowDO)
- Tables: `trace_events` (collected events), `trace_state` (running totals per feature)
- `apply(event)` method: stores event, updates running total for its feature slug
- `complete()` method: aggregates all events by feature slug, returns aggregated events

Files to read first:
- `apps/api/src/ingestion/EntitlementWindowDO.ts` (DO pattern to follow exactly)
- `apps/api/src/ingestion/db/schema.ts` (DO SQLite schema pattern)

**7.9 — Add trace routing in IngestionService**

In the ingestion service, before the normal processing path:

1. Check if event has `traceId` in properties
2. If yes and event slug is NOT `__trace_complete`:
   - Route to TraceAggregationDO keyed by `trace:{appEnv}:{projectId}:{customerId}:{traceId}`
   - DO accumulates the event, returns `{ accepted: true }`
   - Skip normal EntitlementWindowDO processing for this event
3. If yes and event slug IS `__trace_complete`:
   - Call TraceAggregationDO.complete()
   - For each aggregated result, emit back through `ingestFeatureSync()`
4. If no traceId, proceed with normal path

**7.10 — Add alarm-based timeout for TraceAggregationDO**

Set an alarm (e.g., 5 minutes) on first event. If `__trace_complete` hasn't
arrived by alarm time, trigger `complete()` automatically and emit aggregated
events. Then self-destruct (delete all storage).

Follow the alarm pattern from EntitlementWindowDO (lines 294-374).

**7.11 — Write tests for use cases and integration**

Create `internal/services/src/use-cases/agent/report-usage.test.ts`:

- Test: `reportAgentUsage` rates, posts debit, and settles
- Test: `reportAgentUsage` with zero-cost event (within free tier) posts $0 debit
- Test: `reportAgentUsage` propagates rating error when no grants found

Create `internal/services/src/use-cases/agent/provision-customer.test.ts`:

- Test: `provisionAgentCustomer` creates customer, links apikey, creates grants
- Test: `provisionAgentCustomer` with wallet top-up posts credit to ledger
- Test: `provisionAgentCustomer` rolls back on grant creation failure (transaction)

Create `apps/api/src/ingestion/trace-aggregation.test.ts`:

- Test: TraceAggregationDO collects events and emits aggregated result on complete
- Test: TraceAggregationDO fires on timeout when no complete signal
- Test: TraceAggregationDO aggregates multiple features from same trace
- Test: duplicate events (same idempotency key) are deduplicated

---

## Phase Summary

```
Phase 1: Extract RatingService ──��───── (7 commits, 1 PR)
  Decouples rating from billing. Pure extraction + new incremental method.
  Tests: unit tests for flat/tiered/volume/package pricing.

Phase 2: Add Ledger ─────────────────── (10 commits, 1 PR)
  Append-only financial log in Postgres. Wired to billing.
  Tests: unit tests for debit/credit/balance/settlement.

Phase 3: Provider Schema Changes ────── (7 commits, 1 PR)
  New tables: customer_provider_ids, apikey_customers, webhook_events.
  paymentProvider moves to subscription_phases.
  Tests: validator tests.

Phase 4: PaymentCollector Interface ──── (8 commits, 1 PR)
  New interface replaces old. StripeCollector + SandboxCollector.
  BillingService uses new interface.
  Use case: completeProviderSetup (generic checkout callback).
  Tests: collector + use case tests.

Phase 5: Settlement Router ──────────── (9 commits, 1 PR)
  Dispatches to wallet/subscription/one_time.
  threshold_invoice designed, not implemented.
  Tests: settlement unit tests.

Phase 6: Webhook Pipeline ──────────── (8 commits, 1 PR)
  Generic webhook endpoint with idempotent processing.
  Use case: processWebhookEvent (coordinates invoice + ledger + sub machine).
  Stripe webhook parsing. Ledger reconciliation.
  Tests: idempotency + use case + event processing tests.

Phase 7: Agent Billing Flow ─���───────── (11 commits, 1 PR)
  API key → customer, manual grants, TraceAggregationDO.
  Use cases: reportAgentUsage (rating + ledger + settlement),
             provisionAgentCustomer (setup apikey + grants + wallet).
  Rating + ledger + settlement wired to sync ingestion.
  Tests: use case unit tests + DO integration tests.
```

**Parallel tracks:** Phases 1-2 can run in parallel with Phase 3.
Phase 4 depends on Phase 3. Phases 5 and 6 depend on 2+4.
Phase 7 depends on all previous phases.

**Total: ~60 commits across 7 PRs.**

---

## Use Cases Summary

These are the cross-service coordination points implemented as use-case
functions (not service methods) following the `use-cases/` pattern:

| Use Case | Phase | Coordinates | Location |
|----------|-------|-------------|----------|
| `completeProviderSetup` | 4 | collector + customers + subscriptions | `use-cases/payment-provider/complete-provider-setup.ts` |
| `processWebhookEvent` | 6 | billing + ledger + subscriptions | `use-cases/webhook/process-event.ts` |
| `reportAgentUsage` | 7 | rating + ledger + settlement | `use-cases/agent/report-usage.ts` |
| `provisionAgentCustomer` | 7 | apikeys + customers + grants + ledger | `use-cases/agent/provision-customer.ts` |

Each use case:
- Takes `deps: { services: Pick<ServiceContext, ...>, db, logger, ... }`
- Returns `Promise<Result<T, E>>`
- Is barrel-exported from `use-cases/index.ts`
- Has its own test file

---

## Validation Checkpoints

After each phase, verify:

1. `pnpm typecheck` passes (or the project's type-checking command)
2. `pnpm test` passes for the affected packages
3. Existing billing tests still pass (regression check)
4. New tests pass
5. No circular dependencies in service graph

If any check fails, fix before proceeding to the next phase.

If the plan describes code that doesn't match reality (e.g., a method doesn't
exist, a table has different columns, a pattern is different), **stop and ask
for clarification** before improvising.
