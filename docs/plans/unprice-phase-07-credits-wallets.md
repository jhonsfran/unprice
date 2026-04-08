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
  `sourceType: "credit_burn"`. The wallet balance is a projection of the ledger.
- Burn rates are versioned with `effectiveAt`/`supersededAt`. Changing a burn rate
  never modifies existing subscriptions or historical ledger entries.
- Do not introduce TypeScript `any` types.
- Keep orchestration in use cases, not adapters.

## Primary Touchpoints

- `internal/db/src/schema/wallets.ts` — new
- `internal/db/src/schema/credit-grants.ts` — new
- `internal/db/src/schema/credit-burn-rates.ts` — new
- `internal/db/src/validators/wallets.ts` — new
- `internal/services/src/wallet/service.ts` — new
- `internal/services/src/settlement/router.ts` — new
- `internal/services/src/use-cases/wallet/purchase-credits.ts` — new
- `internal/services/src/use-cases/agent/report-agent-usage.ts` — wire settlement
- `internal/services/src/context.ts` — register new services
- `apps/api/src/routes/` — new wallet endpoints
- `packages/api/src/openapi.d.ts` — SDK types
- dashboard UI: wallet page, credit purchase flow, burn rate editor

## Execution Plan

### Slice 1: Wallet schema

Create `internal/db/src/schema/wallets.ts`:

```
wallets(
  id, projectId, customerId, currency,
  balanceCents,           -- current spendable balance
  lifetimeCreditsCents,   -- total credits ever purchased
  lifetimeDebitsCents,    -- total credits ever consumed
  createdAt, updatedAt
)
-- unique: (projectId, customerId, currency)
```

Create `internal/db/src/schema/credit-grants.ts`:

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

The burn rate table is versioned: changing a rate creates a new row and
supersedes the old one. This allows price adjustments without modifying
existing subscriptions — the credit-per-unit exchange rate changes, not the
customer contract.

### Slice 2: Validators and migration

Add validators for all new tables. Export from the real schema and validator
barrels. Run migration.

### Slice 3: WalletService

Create `internal/services/src/wallet/` with:

- `service.ts` — `WalletService`
- `errors.ts` — `UnPriceWalletError`
- `index.ts` — barrel

Constructor deps: infrastructure only (`db`, `logger`, `metrics`). Leaf
service — no peer service dependencies.

Methods:

- `getOrCreateWallet(projectId, customerId, currency)` — idempotent
- `addCredits(walletId, amount, sourceType, sourceId, expiresAt?, priority?)`
  — posts a ledger credit with `sourceType: "credit_purchase"` and creates a
  `credit_grant` row
- `deductCredits(walletId, amount, sourceType, sourceId)` — atomic
  check-and-deduct. Consumes from grants in priority + expiry order (lowest
  priority first, earliest expiry first within same priority). Posts ledger
  debit with `sourceType: "credit_burn"`
- `getBalance(walletId)` — current spendable balance
- `getGrantHistory(walletId)` — credit grant timeline with remaining amounts
- `hasEnoughCredits(walletId, estimatedCost)` — fast balance check for
  guardrails (Phase 8)

Important constraint: `deductCredits` runs in a database transaction. If
balance is insufficient, the entire operation is rejected — no partial
deduction.

Register in `internal/services/src/context.ts`.

### Slice 4: SettlementRouter

Create `internal/services/src/settlement/router.ts`.

The router decides how a rated or ledger-backed charge should be settled.

Routing modes:

- `invoice` — accumulate into periodic invoice (existing BillingService flow)
- `wallet` — deduct from credit balance immediately via WalletService
- `one_time` — charge via provider immediately (uses normalized provider
  runtime, leaves room for crypto-backed collectors)

Settlement preference is configured per subscription phase or per customer
billing config. Defaults:

- subscriptions: `invoice`
- agent usage: `wallet` (falls back to `invoice` if no wallet exists)

### Slice 5: Wire wallet settlement into agent billing

Update `reportAgentUsage` (from Phase 6) to:

1. Rate the usage
2. Post ledger debit
3. Route through SettlementRouter
4. If `wallet`: call `WalletService.deductCredits()`
5. If `invoice`: accumulate for next billing cycle (existing behavior)

### Slice 6: Credit purchase flow

Create `internal/services/src/use-cases/wallet/purchase-credits.ts`.

Use case `purchaseCredits`:

- accepts a credit pack selection (amount, currency)
- creates a Stripe checkout session (or equivalent provider session) for the
  credit pack amount
- on payment success webhook, calls `WalletService.addCredits()` with
  `sourceType: "purchase"`, `sourceId: paymentIntentId`
- idempotent: same `sourceId` returns existing grant

### Slice 7: API endpoints

New routes:

- `POST /v1/wallet/balance` — check credit balance for a customer
- `POST /v1/wallet/purchase` — initiate credit purchase (returns checkout URL)
- `GET /v1/wallet/grants` — list credit grants with remaining amounts

Update `packages/api/` OpenAPI types.

DX: developers can check balance before making expensive calls, purchase
credits programmatically, and query grant history.

### Slice 8: UI

- **Wallet dashboard:** current balance display, grant history timeline showing
  purchases/burns/expirations, burn rate over time chart
- **Credit purchase flow:** select credit pack → Stripe checkout → confirmation
  callback → balance updated
- **Burn rate configuration:** per-feature credit cost editor on the plan version
  feature configuration page. Shows current rate and effective date.
- **Customer billing page:** show wallet balance alongside subscription status.
  If wallet-based, show "Credits remaining: $X" prominently.
- **Settlement preference:** per-subscription or per-customer toggle between
  invoice and wallet settlement modes

### Slice 9: Tests

Cover:

- wallet creation idempotency
- credit grant with priority and expiry
- FIFO/priority consumption order
- grant expiry (expired grants skipped)
- atomic deduction (insufficient balance rejection)
- settlement router routing logic per mode
- purchase → webhook → credit grant e2e flow
- burn rate versioning (rate change mid-period uses new rate for new events)
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
- agent usage can be settled by wallet deduction or invoice accumulation
- burn rates are versioned and can be changed without modifying subscriptions
- settlement router correctly routes charges to the configured mode
- SDK exposes wallet balance and purchase endpoints
- dashboard shows wallet state and allows credit purchases

## Out Of Scope

- wallet top-up subscriptions (recurring auto-purchase)
- credit transfer between customers
- multi-currency wallet conversion
- crypto-backed credit purchase (the `one_time` settlement mode leaves room for
  this but implementation is not in scope)
