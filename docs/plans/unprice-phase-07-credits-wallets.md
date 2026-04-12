# Phase 7: Credits, Wallets & Settlement Router

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add credits, wallets, and settlement router`  
Branch: `feat/credits-wallets`

## Mission

Add prepaid credits as the universal billing abstraction for AI workloads.
Credits decouple customer-facing pricing from volatile underlying costs. Introduce
the settlement router that decides how rated charges are collected: via invoice,
wallet deduction, or one-time provider charge.

## Dependencies

- Phase 4 for `LedgerService`
- Phase 5 for settlement webhooks (credit purchase confirmation)
- Phase 6 for `billMeterFact` use case (agent/meter billing)

## Why This Phase Exists

- credits are the dominant billing abstraction for AI (OpenAI, Vercel, Anthropic,
  Netlify all use them)
- when model costs drop ~10x/year, you change the burn rate, not the customer
  contract
- prepaid balance enables real-time spending enforcement (Phase 8)
- pure usage-based billing creates "blank check anxiety" — a real adoption blocker
- the settlement router was originally in Phase 6 but depends on wallet
  infrastructure to be useful beyond invoice-only routing
- versioned burn rates allow price adjustments without modifying subscriptions

## Read First

- [../../internal/services/src/ledger/service.ts](../../internal/services/src/ledger/service.ts)
- [../../internal/db/src/schema/ledger.ts](../../internal/db/src/schema/ledger.ts)
- [../../internal/db/src/schema/invoices.ts](../../internal/db/src/schema/invoices.ts) — existing `creditGrants` and `invoiceCreditApplications` tables (to be replaced)
- [../../internal/services/src/use-cases/billing/bill-meter-fact.ts](../../internal/services/src/use-cases/billing/bill-meter-fact.ts)
- [../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts](../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts)
- [../../internal/services/src/payment-provider/interface.ts](../../internal/services/src/payment-provider/interface.ts)
- [./unprice-phase-04-ledger-foundation.md](./unprice-phase-04-ledger-foundation.md)
- [./unprice-phase-05-settlement-webhooks.md](./unprice-phase-05-settlement-webhooks.md)
- [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md)

## Guardrails

- `WalletService` is a leaf service like `LedgerService` — no peer domain service
  dependencies.
- Credit deductions must be transactional — if balance insufficient, reject
  entirely (no partial deduction).
- Credits are ledger entries. `addCredits` posts a ledger credit with
  `sourceType: "credit_purchase"`. `deductCredits` posts a ledger debit with
  `sourceType: "credit_burn"`. **The ledger is the source of truth.** The wallet
  table's `balanceCents` is a denormalized cache updated atomically within the
  same DB transaction as ledger posts (same pattern as `ledgers.unsettledBalanceCents`).
- Burn rates are versioned with `effectiveAt`/`supersededAt`. Changing a burn rate
  never modifies existing subscriptions or historical ledger entries.
- Use `CreditGrant` naming everywhere to avoid confusion with the existing
  `GrantsManager` (which manages entitlement grants, a different concept).
- Do not introduce TypeScript `any` types.
- Keep orchestration in use cases, not adapters.

## Primary Touchpoints

- `internal/db/src/schema/wallets.ts` — new
- `internal/db/src/schema/invoices.ts` — replace existing `creditGrants` and `invoiceCreditApplications` tables
- `internal/db/src/schema/credit-burn-rates.ts` — new
- `internal/db/src/utils/constants.ts` — extend `LEDGER_SETTLEMENT_TYPES` with `"wallet"`
- `internal/db/src/validators/wallets.ts` — new
- `internal/services/src/wallet/service.ts` — new
- `internal/services/src/settlement/router.ts` — new
- `internal/services/src/use-cases/wallet/purchase-credits.ts` — new
- `internal/services/src/use-cases/billing/bill-meter-fact.ts` — wire settlement router
- `internal/services/src/context.ts` — register WalletService
- `apps/api/src/middleware/init.ts` — expose WalletService to route handlers
- `apps/api/src/hono/env.ts` — add wallet to HonoEnv services type
- `apps/api/src/routes/` — new wallet endpoints
- `packages/api/src/openapi.d.ts` — SDK types
- dashboard UI: wallet page, credit purchase flow, burn rate editor

## Execution Plan

### Slice 1: Wallet & credit grant schema

Create `internal/db/src/schema/wallets.ts`:

```
wallets(
  id, projectId, customerId, currency,
  balanceCents,           -- denormalized cache of ledger balance (updated atomically with ledger posts)
  lifetimeCreditsCents,   -- total credits ever purchased
  lifetimeDebitsCents,    -- total credits ever consumed
  createdAt, updatedAt
)
-- unique: (projectId, customerId, currency)
```

The `balanceCents` column is a **denormalized cache**, not the source of truth.
It follows the same pattern as `ledgers.unsettledBalanceCents` — updated within
the same DB transaction as the corresponding ledger entry. If drift is ever
suspected, the ledger can be replayed to recompute the correct balance.

Add `credit_grants` to the wallets schema (replaces the existing `creditGrants`
table in `invoices.ts`):

```
credit_grants(
  id, walletId, projectId,
  amountCents,            -- original grant amount
  remainingCents,         -- unconsumed balance
  sourceType,             -- "purchase" | "promotional" | "refund" | "manual"
  sourceId,               -- payment intent id, promo code, etc.
  expiresAt,              -- nullable, for time-limited promos
  priority,               -- consumption order (lower = consumed first)
  createdAt, revokedAt
)
```

**Migration note:** Remove the old `creditGrants` and `invoiceCreditApplications`
tables from `internal/db/src/schema/invoices.ts`. Remove their relations. No
backward compatibility needed — drop and replace. Update the schema barrel
export to include the new wallets schema.

Create `internal/db/src/schema/credit-burn-rates.ts`:

```
credit_burn_rates(
  id, projectId, planVersionFeatureId,
  creditsPerUnit,         -- how many credits 1 unit of this feature costs
  effectiveAt,            -- when this rate takes effect
  supersededAt,           -- when replaced by a newer rate
  createdAt
)
```

The burn rate is a **post-rating conversion layer**. The pricing pipeline is:
`usage → RatingService.rateIncrementalUsage() (cents) → burn rate (credits) → WalletService.deductCredits()`.
The burn rate converts rated cents to credits. It does not replace the rating
service — it sits after it.

### Slice 2: Settlement type enum + settlement preference schema

Extend `LEDGER_SETTLEMENT_TYPES` in `internal/db/src/utils/constants.ts`:

```typescript
export const LEDGER_SETTLEMENT_TYPES = ["invoice", "manual", "wallet"] as const
```

Add settlement preference to subscription phases (or customer billing config).
This column does not exist today — it must be created:

```
-- on subscription_phases or a new customer_billing_config table:
settlementPreference  -- "invoice" | "wallet" (nullable, defaults to "invoice")
```

Defaults:
- subscriptions: `"invoice"`
- meter/agent usage: `"wallet"` (falls back to `"invoice"` if no wallet exists)

Run migration for both the new tables, dropped tables, and enum extension.

### Slice 3: Validators

Add validators for all new tables (`wallets`, `credit_grants`,
`credit_burn_rates`). Export from the schema and validator barrels.

Use `drizzle-zod` `createSelectSchema` / `createInsertSchema` following the
existing pattern in `internal/db/src/validators/ledger.ts`.

### Slice 4: WalletService

Create `internal/services/src/wallet/` with:

- `service.ts` — `WalletService`
- `errors.ts` — `UnPriceWalletError`
- `index.ts` — barrel

Constructor deps: infrastructure only (`db`, `logger`, `metrics`). Leaf
service — no peer service dependencies.

Methods:

- `getOrCreateWallet(projectId, customerId, currency)` — idempotent
- `addCredits(walletId, amount, sourceType, sourceId, expiresAt?, priority?)`
  — runs in a **single DB transaction** that:
  1. Creates a `credit_grant` row
  2. Posts a ledger credit via `LedgerService.postCredit()` with
     `sourceType: "credit_purchase"`
  3. Increments wallet `balanceCents` and `lifetimeCreditsCents`
- `deductCredits(walletId, amount, sourceType, sourceId)` — runs in a
  **single DB transaction** that:
  1. Checks wallet `balanceCents >= amount` (fast rejection)
  2. Consumes from grants in priority + expiry order (lowest priority first,
     earliest expiry first within same priority, **skipping expired grants**)
  3. Decrements `remainingCents` on each consumed grant
  4. Posts a ledger debit with `sourceType: "credit_burn"`
  5. Decrements wallet `balanceCents` and increments `lifetimeDebitsCents`
  If balance is insufficient, the **entire transaction rolls back** — no
  partial deduction.
- `getBalance(walletId)` — returns cached `balanceCents` from wallet table
- `getGrantHistory(walletId)` — credit grant timeline with remaining amounts
- `hasEnoughCredits(walletId, estimatedCost)` — fast balance check for
  guardrails (Phase 8)

**Important:** `addCredits` and `deductCredits` both accept an optional `db`
parameter for caller-provided transaction context (same pattern as
`LedgerService.postEntry`). The WalletService needs access to `LedgerService`
for posting entries — pass it as a constructor dep alongside the infra deps.
This makes WalletService a near-leaf service (depends only on LedgerService,
which is itself a leaf).

Register in `internal/services/src/context.ts`. Construct after `LedgerService`,
pass `ledgerService` as a constructor dep.

### Slice 5: SettlementRouter

Create `internal/services/src/settlement/router.ts`.

The router decides how a rated or ledger-backed charge should be settled.

Routing modes:

- `invoice` — accumulate into periodic invoice (existing BillingService flow)
- `wallet` — deduct from credit balance immediately via WalletService
- `one_time` — charge via provider immediately (uses normalized provider
  runtime, leaves room for crypto-backed collectors)

The router takes:
- the settlement preference (from subscription phase or customer config)
- the charge amount and context
- and dispatches to the appropriate handler

If `wallet` mode is selected but no wallet exists or balance is insufficient,
fall back to `invoice` mode.

### Slice 6: Wire wallet settlement into meter billing

Update `billMeterFact` (`internal/services/src/use-cases/billing/bill-meter-fact.ts`)
to:

1. Rate the usage (existing — `RatingService.rateIncrementalUsage()`)
2. Post ledger debit (existing — `LedgerService.postDebit()`)
3. Route through SettlementRouter
4. If `wallet`: convert cents to credits via burn rate, call
   `WalletService.deductCredits()`
5. If `invoice`: accumulate for next billing cycle (existing behavior)

Update `BillMeterFactDeps` to include `Pick<ServiceContext, "rating" | "ledger" | "wallet">`.

### Slice 7: Credit purchase flow

Create `internal/services/src/use-cases/wallet/purchase-credits.ts`.

Use case `purchaseCredits`:

- accepts a credit pack selection (amount, currency)
- creates a Stripe checkout session (or equivalent provider session) for the
  credit pack amount
- on payment success webhook, calls `WalletService.addCredits()` with
  `sourceType: "purchase"`, `sourceId: paymentIntentId`
- idempotent: same `sourceId` returns existing grant

Update `processWebhookEvent` to handle credit purchase confirmation events
(new outcome type alongside existing invoice payment flow).

### Slice 8: API endpoints

New routes (all POST, matching existing convention):

- `POST /v1/wallet/balance` — check credit balance for a customer
- `POST /v1/wallet/purchase` — initiate credit purchase (returns checkout URL)
- `POST /v1/wallet/grants` — list credit grants with remaining amounts

Register routes in `apps/api/src/index.ts`.

Add WalletService to `apps/api/src/middleware/init.ts` service exposure
(alongside existing `subscription`, `entitlement`, `customer`, etc.) and
update `apps/api/src/hono/env.ts` services type.

Update `packages/api/` OpenAPI types.

### Slice 9: UI — wallet dashboard & balance

- **Wallet dashboard:** current balance display, grant history timeline showing
  purchases/burns/expirations, burn rate over time chart
- **Customer billing page:** show wallet balance alongside subscription status.
  If wallet-based, show "Credits remaining: $X" prominently.

### Slice 10: UI — credit purchase flow

- **Credit purchase flow:** select credit pack → Stripe checkout → confirmation
  callback → balance updated

### Slice 11: UI — burn rate & settlement config

- **Burn rate configuration:** per-feature credit cost editor on the plan version
  feature configuration page. Shows current rate and effective date.
- **Settlement preference:** per-subscription or per-customer toggle between
  invoice and wallet settlement modes

### Slice 12: Tests

Cover:

- wallet creation idempotency
- credit grant with priority and expiry
- FIFO/priority consumption order
- expired grants skipped during deduction
- atomic deduction (insufficient balance rejection, full rollback)
- wallet `balanceCents` stays in sync with ledger after add/deduct
- settlement router routing logic per mode (wallet, invoice, fallback)
- purchase → webhook → credit grant e2e flow
- burn rate versioning (rate change mid-period uses new rate for new events)
- pricing pipeline: `rateIncrementalUsage → burn rate → deductCredits`
- `billMeterFact` with wallet settlement mode
- wallet balance consistency under concurrent deductions

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`
- `pnpm --filter @unprice/api typecheck`

## Exit Criteria

- customers can hold prepaid credit balances
- credits are purchased via provider checkout and granted on payment confirmation
- agent/meter usage can be settled by wallet deduction or invoice accumulation
- burn rates are versioned and can be changed without modifying subscriptions
- settlement router correctly routes charges to the configured mode
- wallet `balanceCents` is a denormalized cache of ledger state, not independent
- existing `creditGrants` and `invoiceCreditApplications` tables are removed
- SDK exposes wallet balance and purchase endpoints
- dashboard shows wallet state and allows credit purchases

## Out Of Scope

- wallet top-up subscriptions (recurring auto-purchase)
- credit transfer between customers
- multi-currency wallet conversion
- crypto-backed credit purchase (the `one_time` settlement mode leaves room for
  this but implementation is not in scope)
