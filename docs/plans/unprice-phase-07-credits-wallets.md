# Phase 7: Credits, Wallets & Settlement Router

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
PR title: `feat: add credits, wallets, and settlement router`
Branch: `feat/credits-wallets`

**Prerequisite:** [Phase 6.6 — pgledger + Dinero](./unprice-phase-06.6-new-ledger.md)
must ship first. That phase installs pgledger via `migrate:custom`, ships the
typed **`LedgerGateway`** with `Dinero<number>` end-to-end, rewrites
`LedgerService` as a thin wrapper around the gateway, deletes the hand-rolled
ledger tables, and publishes a set of **Hooks for Phase 7** — canonical
`grantAccountKey`, `seedHouseAccounts` covering credit-issuance + expired
house accounts, the `createTransfers` batch API, and `getAccountBalance`.

Phase 7 is **greenfield** on top of that foundation. The previous wallet,
credit-grant, settlement-router, and WalletDO code has been deleted from the
tree. This phase builds all of it for the first time against the gateway.

## Mission

Build the credits product end-to-end: wallet + credit-grant schema, pure
fold/decide logic over `Dinero<number>`, `WalletService` (Postgres +
`LedgerGateway`), real-time `WalletDO` at the edge with outbox-based
settlement, a **settlement router** that picks between `invoice`, `wallet`,
and `one_time` modes, and the checkout/webhook path that funds grants.

Credits decouple customer-facing pricing from volatile underlying costs —
critical for AI workloads where model costs drop an order of magnitude a year.
The WalletDO mirrors the proven `EntitlementWindowDO` pattern: local SQLite
for sub-millisecond gating, an outbox that flushes to
`WalletService.deductCredits`, which applies the **same** `decideDeduct`
plan through `LedgerGateway.createTransfers`.

## Dependencies

- **Phase 6.6** for `LedgerGateway`, `LedgerService`, `ledger/accounts.ts`
  (includes `grantAccountKey`), `ledger/money.ts`, `ledger_idempotency`
  table, pgledger install, and `seedHouseAccounts` covering
  `house:credit_issuance` + `house:expired_credits`.
- Phase 5 for settlement webhooks (credit purchase confirmation arrives as a
  webhook event).
- Phase 6 for `billMeterFact` and `EntitlementWindowDO.processBillingBatch`.
  Phase 7 wires the wallet leg into that flow.

Phases 4, 5, 6.5 wallet + settlement state that lived in earlier plan drafts:
superseded. The branch starts from a tree with **no** wallet / settlement /
WalletDO code.

## Why This Phase Exists

- Credits are the dominant billing abstraction for AI (OpenAI, Vercel,
  Anthropic, Netlify all use them).
- When model costs drop ~10× / year, the operator changes the burn rate, not
  the customer contract.
- Prepaid balance enables real-time spending enforcement (Phase 8).
- Pure usage-based billing creates "blank-check anxiety" — a real adoption
  blocker.
- Reading wallet balance from Postgres on every meter event kills the
  latency advantage of DOs; wallet state must live at the edge and flush
  asynchronously.

## Read First

- [./unprice-phase-06.6-new-ledger.md](./unprice-phase-06.6-new-ledger.md)
  — especially **The Model** (account taxonomy, burn flow, Dinero boundary)
  and **Hooks for Phase 7**.
- [../../internal/services/src/ledger/gateway.ts](../../internal/services/src/ledger/gateway.ts)
  (after 6.6) — the only path to pgledger.
- [../../internal/services/src/ledger/accounts.ts](../../internal/services/src/ledger/accounts.ts)
  (after 6.6) — imports `grantAccountKey`, `customerAccountKey`,
  `houseAccountKey`, `HOUSE_ACCOUNT_KINDS`.
- [../../internal/services/src/ledger/service.ts](../../internal/services/src/ledger/service.ts)
  (after 6.6) — the sibling service `WalletService` must **not** import.
- [../../internal/services/src/use-cases/billing/bill-meter-fact.ts](../../internal/services/src/use-cases/billing/bill-meter-fact.ts)
  (after 6.6) — takes `Dinero<number>`, still needs settlement routing.
- [../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts](../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts)
- [../../internal/services/src/payment-provider/interface.ts](../../internal/services/src/payment-provider/interface.ts)
- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
  — reference pattern for WalletDO (alarms, ready gate, drizzle SQLite,
  outbox).
- [../../apps/api/src/ingestion/entitlements/db/schema.ts](../../apps/api/src/ingestion/entitlements/db/schema.ts)
  — DO SQLite schema pattern.
- [`ricofritzsche/eventstore-typescript`](https://github.com/ricofritzsche/eventstore-typescript)
  — fold/decide/shell pattern reference.

## Two-Layer Architecture: WalletDO + WalletService

Both layers are built from scratch in this phase. They share pure fold/decide
logic and both go through `LedgerGateway` for money movement — neither
embeds pgledger SQL directly.

```
                       ┌──────────────────────────────────────┐
  meter event          │       EntitlementWindowDO             │
  ─────────────►       │  (limit check, meter state, outbox)  │
                       └──────────┬───────────────────────────┘
                                  │ alarm: processBillingBatch()
                                  │ calls billMeterFact()
                                  ▼
                       ┌──────────────────────────────────────┐
  balance check ──►    │            WalletDO                   │
  deduct request ──►   │  (balance, grants, outbox)            │
                       │  SQLite: wallet_state, credit_grants, │
                       │          wallet_outbox, idemp_keys     │
                       └──────────┬───────────────────────────┘
                                  │ alarm: flushOutbox()
                                  ▼
                       ┌──────────────────────────────────────┐
                       │     WalletService (Postgres)          │
                       │  credit_grants rows +                 │
                       │  LedgerGateway transfers / balances    │
                       └──────────────────────────────────────┘
```

| Layer | Responsibility | Storage | Latency |
|-------|---------------|---------|---------|
| **WalletDO** | Real-time balance enforcement, grant consumption plan, outbox | DO SQLite | < 1ms (co-located) |
| **WalletService** | ACID settlement: `credit_grants` rows + `LedgerGateway` transfers (no cached `balance_cents`) | Postgres + pgledger | ~5-20ms |

### Why two layers?

1. **Speed.** `EntitlementWindowDO.processBillingBatch()` calls
   `billMeterFact` which needs to check wallet balance and deduct credits.
   If that hits Postgres per event, you add 5–20 ms per deduction on the
   hot billing path — inside an alarm that processes batches of up to 1000.
   With a WalletDO, the balance check and local deduction are
   sub-millisecond DO-to-DO calls.
2. **Consistency model matches metering.** Meters already accept "DO is
   real-time truth, Postgres + pgledger is durable truth." The DO holds a
   **cache** of grant remainders for ordering and gating; the outbox
   ensures `WalletService` applies the same consumption lines to pgledger.
   Same mental model, same failure modes, same recovery strategy.
3. **Single-threaded serialization for free.** Cloudflare guarantees one
   concurrent request per DO instance. No `SELECT ... FOR UPDATE`, no
   deadlocks, no optimistic retry loops. One WalletDO per
   `(customerId, currency)` is the natural serialization boundary.

### Grant synchronization: push model

When wallet state changes in Postgres (credit purchase confirmed, grant
revoked, manual adjustment), the mutating code path pushes the update to the
WalletDO:

```
Stripe webhook → processWebhookEvent → WalletService.addCredits() (Postgres +
  LedgerGateway: issuance → grant:<id>)
                                             │
                                             ▼
                                        walletDO.sync({ grant, remaining… })
                                        (push via DO stub fetch)
```

The WalletDO exposes a `sync()` method that accepts grant additions,
revocations, or a full state snapshot. On receipt, it updates its local
SQLite tables and adjusts the cached balance. This keeps the DO fresh
without polling.

**Why push over pull:**
- Pull requires the DO to wake up periodically and query Postgres —
  wasteful when nothing changed, stale between polls.
- Push is event-driven — the DO learns about changes the moment they
  happen.
- The mutating code path already knows what changed — it has the data in
  hand.
- Matches how `EntitlementWindowDO` receives its configuration: the caller
  provides the state at call time, the DO doesn't fetch it.

**Consistency guarantee:** The DO is eventually consistent with Postgres +
pgledger. The push ensures convergence within the same request that caused
the change. If a push fails (DO unavailable), the next deduction can carry
a fallback `full_snapshot` from Postgres (grant rows + gateway balances).
The outbox flush is the checkpoint: `WalletService` recomputes or validates
consumption lines against **live grant account balances** from the gateway;
mismatch → typed error (`GRANT_FLUSH_MISMATCH`) and DO `full_snapshot`
recovery. No legacy `reconcileBalance` cache column exists to drift.

### The fold/decide pattern in the DO

Following the pattern from
[`ricofritzsche/eventstore-typescript`](https://github.com/ricofritzsche/eventstore-typescript):

```
fold:    foldWalletState(grants[]) → { balance, grantsByPriority[], expired[] }
decide:  decideDeduct(command, state) → Ok(ConsumptionPlan) | Err(InsufficientBalance)
shell:   WalletDO.deduct() — read local SQLite, fold, decide, persist + outbox
```

The pure `foldWalletState` and `decideDeduct` functions live in
`internal/services/src/wallet/core.ts`, take/return `Dinero<number>`, and
are shared between the DO (edge, against SQLite-cached grants) and
`WalletService` (Postgres, against gateway-read grant balances). Same
business logic, two execution contexts. Unit-testable without any
infrastructure.

### Deduction flow (detailed)

```
EntitlementWindowDO.processBillingBatch()
  │
  │  for each unbilled meter fact:
  │    1. billMeterFact() → rate usage → Dinero amount
  │    2. settlement router picks: invoice | wallet | one_time
  │    3. if "invoice": LedgerService.postCharge (customer → house:revenue)
  │       if "wallet":  walletDO.deduct({ amount: Dinero, sourceType, sourceId })
  │       if "one_time": provider charge path
  │
  ▼
WalletDO.deduct()
  │  (single-threaded, no locks needed)
  │
  │  1. Read grants from local SQLite
  │  2. fold: foldWalletState(grants) → state
  │  3. decide: decideDeduct(command, state) → ConsumptionPlan
  │     - FIFO by priority, then earliest expiry
  │     - Skip expired grants
  │     - Reject if insufficient balance (entire deduction fails)
  │  4. Apply ConsumptionPlan to local SQLite (cached remaining per grant)
  │  5. Write to wallet_outbox:
  │     - { type: "deduction", amount, sourceType, sourceId, grantConsumptions[] }
  │  6. Return Ok({ newBalance }) or Err(InsufficientBalance)
  │
  │  alarm (every 30s):
  ▼
WalletDO.flushOutbox()
  │
  │  for each outbox row:
  │    WalletService.deductCredits() in Postgres (ACID)
  │    - Validates grants + gateway balances; emits grant → house:revenue
  │      transfers (source_type: "credit_burn") via LedgerGateway batch
  │    - No wallets.balance_cents / credit_grants.remaining_cents columns
  │    Mark outbox row as settled
  │
  │  Cleanup: delete settled + flushed rows
  ▼
```

### Credit addition flow (push)

```
Stripe webhook (payment.succeeded for credit purchase)
  │
  ▼
processWebhookEvent()
  │
  ▼
WalletService.addCredits() — Postgres ACID transaction:
  │  1. gateway.seedHouseAccounts(projectId, currency)  // from 6.6
  │  2. Insert credit_grants row (amount numeric / Dinero at scale 6)
  │  3. gateway.createAccount(grantAccountKey(id), currency,
  │     allow_negative=false)
  │  4. gateway.createTransfer(house:credit_issuance → grant:<id>, …
  │     source_type: "credit_purchase")
  │
  ▼
walletDO.sync({ type: "grant_added", grant: { id, amount, remaining,
  priority, expiresAt } })
  │  (push via DO stub fetch; remaining = grant's initial amount)
  │
  ▼
WalletDO.sync()
  │  1. Insert/update grant in local credit_grants_local SQLite table
  │  2. Recalculate cached balance from foldWalletState(all local grants)
  │  3. Return Ok
```

## Guardrails

- `WalletService` does **not** import `LedgerService`. They are siblings;
  both use `LedgerGateway` for pgledger. No peer-domain service
  dependencies beyond the gateway and the DB.
- Credit deductions are atomic. If balance is insufficient, reject entirely
  (no partial deduction). Holds in both the DO (local SQLite transaction)
  and Postgres (one `createTransfers` batch — pgledger rolls all lines back
  on any line failure).
- `Dinero<number>` at every service and use-case boundary. The DO stores
  fixed-scale integers internally (same internal scale 6 as pgledger) for
  SQLite-side integer math, and marshals to/from Dinero at RPC boundaries.
- **pgledger is the source of truth for money in accounts.**
  `credit_grants.amount` is the original grant face value (numeric,
  scale 6); **remaining** is `gateway.getAccountBalance(grantAccountKey(id))`
  — no `remaining_cents` / `balance_cents` columns. The DO's SQLite tables
  are a performance cache for ordering and gating, rebuilt from Postgres +
  gateway on `full_snapshot`.
- `addCredits` uses `source_type: "credit_purchase"` and `deductCredits`
  uses `source_type: "credit_burn"` — both as documented in 6.6's "The
  Model". Idempotency rows live in the gateway's `ledger_idempotency`
  table. The DO keeps its own idempotency keys for **edge** dedupe only.
- `createAccount` for every `grant:*` account uses
  `allow_negative_balance=false` (per 6.6 contract). Overdraw rejects at
  the SQL boundary — we get an integrity check for free.
- Burn rates are versioned with `effectiveAt` / `supersededAt`. Changing
  a burn rate never modifies existing subscriptions or historical
  transfers.
- Use the name `CreditGrant` everywhere to avoid confusion with the
  existing `GrantsManager` (which manages entitlement grants — a different
  concept).
- No `any`. Keep orchestration in use cases, not adapters.
- The settlement router does **not** double-post. For `wallet` mode, the
  customer receivable leg is skipped — only grant → revenue transfers run
  (on DO outbox flush). For `invoice` mode, the wallet is untouched.

## Primary Touchpoints

All wallet / settlement / WalletDO paths below are **new files** in this
phase — the previous versions have been deleted from the tree.

### DB layer

- `internal/db/src/schema/wallets.ts` — new. `wallets` + `credit_grants`
  tables.
- `internal/db/src/schema/credit-burn-rates.ts` — new.
- `internal/db/src/schema/invoices.ts` — drop the legacy `creditGrants` /
  `invoiceCreditApplications` tables if they still exist at branch start
  (6.6 may have left them). Remove relations.
- `internal/db/src/validators/wallets.ts` — new. Drizzle-zod
  `createSelectSchema` / `createInsertSchema` following the existing
  validator pattern.
- `internal/db/src/validators/credit-burn-rates.ts` — new.
- `internal/db/src/utils/constants.ts` — verify `LEDGER_SETTLEMENT_TYPES`
  already includes `"invoice" | "wallet" | "one_time"` (added in Phase 6.5).
  No enum changes expected.
- Migration: create the new tables and drop the legacy ones in one step.

### Services

- `internal/services/src/wallet/core.ts` — new. Pure `foldWalletState`,
  `decideDeduct` over `Dinero<number>`. Shared between WalletDO and
  WalletService.
- `internal/services/src/wallet/types.ts` — new. Shared edge + service
  types (`WalletState`, `Grant`, `ConsumptionPlan`, `DeductCommand`,
  `DeductResult`).
- `internal/services/src/wallet/service.ts` — new. `addCredits`,
  `deductCredits`, `getActiveGrants`, `getBalance`, `revokeGrant`. Deps:
  `db`, `logger`, `metrics`, `ledgerGateway`. No import of
  `LedgerService`.
- `internal/services/src/wallet/errors.ts` — new.
  `UnPriceWalletError` codes including `INSUFFICIENT_BALANCE`,
  `GRANT_FLUSH_MISMATCH`, `GRANT_NOT_FOUND`, `WALLET_NOT_FOUND`.
- `internal/services/src/wallet/index.ts` — new.
- `internal/services/src/settlement/router.ts` — new. Thin dispatcher over
  `LedgerService`, `WalletService`, and the provider runtime.
- `internal/services/src/settlement/types.ts` — new.
- `internal/services/src/settlement/index.ts` — new.
- `internal/services/src/context.ts` — register `WalletService` and
  `SettlementRouter` alongside existing services. Both receive the shared
  `LedgerGateway` instance.

### Use cases

- `internal/services/src/use-cases/wallet/purchase-credits.ts` — new.
  Accepts `{ walletId, amount: Dinero, currency, provider }`, creates a
  provider checkout session, returns checkout URL.
- `internal/services/src/use-cases/wallet/confirm-credit-purchase.ts` —
  new. Called from the webhook handler. Calls `addCredits` + pushes
  `walletDO.sync`.
- `internal/services/src/use-cases/wallet/index.ts` — new.
- `internal/services/src/use-cases/billing/bill-meter-fact.ts` — extend to
  call `SettlementRouter.route` before any ledger write.

### Edge (apps/api)

- `apps/api/src/ingestion/wallet/WalletDO.ts` — new.
- `apps/api/src/ingestion/wallet/db/schema.ts` — new (DO SQLite schema).
- `apps/api/src/ingestion/wallet/drizzle/migrations/` — new (DO SQLite
  migrations).
- `apps/api/wrangler.jsonc` — register WalletDO binding + migration tag.
- `apps/api/src/env.ts` — add `wallet` DO namespace to `Env`.
- `apps/api/src/index.ts` — export WalletDO class.
- `apps/api/src/middleware/init.ts` — expose `WalletService` and
  `SettlementRouter` to route handlers.
- `apps/api/src/hono/env.ts` — add wallet + settlement to the HonoEnv
  services type.
- `apps/api/src/routes/wallet/*.ts` — new wallet endpoints
  (balance, purchase, grants).
- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` — extend to
  accept the wallet DO stub in its constructor and pass it through to
  `billMeterFact` so the settlement router can dispatch to wallet mode.

### SDK + UI

- `packages/api/src/openapi.d.ts` — SDK types for new routes.
- Dashboard: wallet page, credit purchase flow, burn rate editor, settlement
  preference toggle.

## Execution Plan

### Slice 1: Wallet + credit grant schema (Postgres)

Create `internal/db/src/schema/wallets.ts`:

```
wallets(
  id, projectId, customerId, currency,
  createdAt, updatedAt
)
-- unique: (projectId, customerId, currency)
```

The wallet row is **identity + scoping** for grants. No `balance_cents` /
lifetime columns — aggregate balance is
`SUM(gateway.getAccountBalance(grantAccountKey(id)))` over active grants.

Add `credit_grants`:

```
credit_grants(
  id, walletId, projectId,
  amount,                 -- numeric, Dinero at internal scale 6 (face value)
  sourceType,             -- "purchase" | "promotional" | "refund" | "manual"
  sourceId,               -- payment intent id, promo code, etc.
  expiresAt,              -- nullable, for time-limited promos
  priority,               -- consumption order (lower = consumed first)
  createdAt, revokedAt
)
-- remaining balance: pgledger account grantAccountKey(id), not a column
```

Drop the legacy `creditGrants` / `invoiceCreditApplications` tables in
`invoices.ts` if they still exist at branch start, together with their
relations.

### Slice 2: Credit burn rates schema

Create `internal/db/src/schema/credit-burn-rates.ts`:

```
credit_burn_rates(
  id, projectId, planVersionFeatureId,
  creditsPerUnit,         -- credits per 1 unit of this feature
  effectiveAt,            -- when this rate takes effect
  supersededAt,           -- when replaced by a newer rate
  createdAt
)
```

The burn rate is a post-rating conversion layer. Pricing pipeline:
`usage → RatingService.rateIncrementalUsage() → Dinero → burn rate (credits
as Dinero) → WalletDO.deduct()`. The rate converts rated money to credit
units in the wallet's currency. It does not replace rating — it sits after
it.

### Slice 3: Settlement preference schema

Add a settlement preference column on `subscriptionPhases` (or a new
`customerBillingConfig` table, chosen to match existing conventions):

```
settlementPreference  -- "invoice" | "wallet" (nullable, defaults to "invoice")
```

Defaults:

- Subscriptions: `"invoice"`.
- Meter / agent usage: `"wallet"` (falls back to `"invoice"` if no wallet
  exists for the `(customer, currency)` pair).

Run one migration covering the new tables, dropped legacy tables, and the
preference column.

### Slice 4: Validators

Add validators for every new table (`wallets`, `credit_grants`,
`credit_burn_rates`). Export from schema and validator barrels.

### Slice 5: Pure wallet logic (fold/decide)

Write `internal/services/src/wallet/core.ts` with:

- `foldWalletState(grants: Grant[]): WalletState` — ordering (priority then
  earliest expiry), expired-grant bucketing, aggregate balance as
  `Dinero<number>`.
- `decideDeduct(state, command): Result<ConsumptionPlan,
  InsufficientBalance>` — `Dinero<number>` inputs, per-grant line amounts
  as Dinero, no `bigint` cents anywhere in the public surface.
- `WalletState`, `Grant`, `ConsumptionPlan`, `DeductCommand` types in
  `wallet/types.ts`.

Property tests in `wallet/core.test.ts` cover priority, expiry skipping,
multi-grant spanning, insufficient-balance rejection (whole-or-nothing),
zero amount no-op, sub-cent amounts (e.g. 0.000001 USD), and sum-of-lines
equals request amount.

### Slice 6: WalletService (Postgres + LedgerGateway)

Write `internal/services/src/wallet/service.ts`. Constructor:
`{ db, logger, metrics, ledgerGateway }` — no `LedgerService` dep.

Methods:

- `addCredits({ walletId, amount: Dinero, sourceType, sourceId, priority,
  expiresAt, metadata })`:
  1. `ledgerGateway.seedHouseAccounts(projectId, currency)` (idempotent).
  2. Insert `credit_grants` row with `amount` as numeric Dinero at
     scale 6.
  3. `ledgerGateway.createAccount(grantAccountKey(id), currency,
     allow_negative=false)`.
  4. `ledgerGateway.createTransfer(houseAccountKey('credit_issuance', …),
     grantAccountKey(id), amount, metadata={ source_type:'credit_purchase',
     source_id, wallet_id, expires_at, priority })`.
  5. Return `{ grantId, remaining: amount }`.
- `deductCredits({ walletId, amount: Dinero, sourceType, sourceId,
  grantConsumptions? })`:
  - If `grantConsumptions` is supplied (DO flush): validate each line
    against `ledgerGateway.getAccountBalance(grantAccountKey(lineGrantId))`.
    On mismatch return `GRANT_FLUSH_MISMATCH` (typed error). On success,
    emit one `ledgerGateway.createTransfers([...])` call with all lines;
    `source_type:'credit_burn'`, `source_id: <meter fact source_id>`.
  - If `grantConsumptions` is absent (direct server-side deduction):
    load active grants + their live balances via the gateway, run
    `foldWalletState` / `decideDeduct`, then emit the batch.
- `getActiveGrants(walletId) → Grant[]` with `remaining: Dinero` populated
  from `ledgerGateway.getAccountBalance(grantAccountKey(id))`. Used by the
  DO's `full_snapshot` and dashboards.
- `getBalance(walletId) → Dinero` — sum of active grant account balances
  in the wallet's currency. Implemented via `getActiveGrants` plus an
  in-memory reduce (one round trip per grant today; optimize to a SQL
  batch helper in the gateway later if this becomes hot).
- `revokeGrant(grantId)` — mark grant revoked, emit
  `ledgerGateway.createTransfer(grantAccountKey(id) →
  houseAccountKey('expired_credits', …), remaining,
  source_type:'grant_revoke', source_id:'revoke:<id>:<now>')`.

Register `WalletService` in `context.ts`.

### Slice 7: WalletDO (edge-side, real-time enforcement)

Create `apps/api/src/ingestion/wallet/WalletDO.ts` following the
`EntitlementWindowDO` pattern.

Public RPC methods accept/return `Dinero<number>` (or a JSON-serialized
`{ amount, scale, currency }` snapshot matching gateway metadata). Inside
SQLite, store fixed-scale integers (same scale 6 as pgledger) for fast
integer math — convert only at the DO boundary.

DO SQLite schema (`apps/api/src/ingestion/wallet/db/schema.ts`):

```typescript
export const walletStateTable = sqliteTable("wallet_state", {
  key: text("key").primaryKey(),         // "balance" | "customerId" | "currency" | "walletId"
  value: text("value").notNull(),
})

export const creditGrantsLocalTable = sqliteTable("credit_grants_local", {
  id: text("id").primaryKey(),            // mirrors Postgres credit_grants.id
  amountScale6: integer("amount_scale6").notNull(),      // face value × 10^6
  remainingScale6: integer("remaining_scale6").notNull(),
  currencyCode: text("currency_code").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  expiresAt: integer("expires_at"),       // epoch ms, nullable
  priority: integer("priority").notNull(),
  revokedAt: integer("revoked_at"),       // epoch ms, nullable
  syncedAt: integer("synced_at").notNull(),
})

export const walletOutboxTable = sqliteTable("wallet_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),           // "deduction" | "expiration"
  payload: text("payload").notNull(),     // JSON: Dinero snapshot + lines
  settledAt: integer("settled_at"),       // epoch ms, null until flushed
})

export const walletIdempotencyTable = sqliteTable("wallet_idempotency", {
  key: text("key").primaryKey(),
  createdAt: integer("created_at").notNull(),
  result: text("result").notNull(),       // JSON: DeductResult
})
```

WalletDO responsibilities (mirror `EntitlementWindowDO` infra — Drizzle
SQLite, alarms, `ready` gate):

- `hasEnoughCredits(amount: Dinero)` — `foldWalletState` + compare to total
  remaining.
- `deduct({ amount: Dinero, sourceType, sourceId })` — SQLite transaction:
  idempotency check → `foldWalletState` → `decideDeduct` → apply lines to
  `remaining_scale6` → update cached aggregate → insert outbox row (payload
  includes per-grant Dinero line items for `WalletService` to replay).
- `sync(event)` — handle `grant_added` / `grant_revoked` / `full_snapshot`
  from Postgres + gateway-backed balances.
- `alarm` — drain outbox via
  `walletService.deductCredits({ …, grantConsumptions })`. On
  `GRANT_FLUSH_MISMATCH`: call `requestFullSync()` which replaces local
  rows from `walletService.getActiveGrants()` (live gateway balances).

Construct `WalletService` with `LedgerGateway` inside the worker — same
pattern as other DOs that use `@unprice/services` factories.

Wrangler registration:

```jsonc
{ "name": "wallet", "class_name": "WalletDO" }
```

Migrations:

```jsonc
{ "tag": "vN", "new_sqlite_classes": ["WalletDO"] }
```

DO identity:
`env.wallet.idFromName(`${customerId}:${currency}`)` — one WalletDO per
customer per currency. Mirrors the EntitlementWindowDO pattern where
identity is derived from the business key.

### Slice 8: SettlementRouter

Create `internal/services/src/settlement/router.ts`.

The router decides how a rated charge settles **after** rating. Inputs:

- `amount: Dinero<number>` (from `RatingService`).
- Settlement preference (from subscription phase or customer config).
- Context: `{ projectId, customerId, currency, sourceType, sourceId,
  statementKey?, subscriptionId?, subscriptionItemId?,
  featurePlanVersionId? }`.
- Access to `LedgerService`, `WalletService`, WalletDO stub, provider
  runtime.

Modes:

- `invoice` — `LedgerService.postCharge(...)`: customer → `house:revenue`,
  same statement key carried in metadata. No wallet activity.
- `wallet` — `walletDO.deduct({ amount: creditsDinero, … })` against the
  `(customer, currency)` DO. **No** `postCharge`. Credit-burn transfers
  run on outbox flush via `WalletService.deductCredits`.
- `one_time` — provider charge via normalized provider runtime; ledger
  handling per product rules (one `createTransfer` via LedgerGateway on
  success with `source_type:'one_time_payment'`).

Fallback: if `wallet` mode is selected but no wallet exists for the
`(customer, currency)` pair, or `walletDO.hasEnoughCredits` returns
`false`, the router falls back to `invoice` mode transparently.
`hasEnoughCredits` is sub-millisecond, so the fallback decision is fast.

### Slice 9: Wire wallet settlement into meter billing

Update `bill-meter-fact.ts`:

1. Rate usage — `RatingService.rateIncrementalUsage()` → `Dinero`.
2. Call `SettlementRouter.route(...)` with the rated amount and the
   preference.
3. The router dispatches to exactly one of the three handlers.
   `bill-meter-fact` itself does not write to the ledger — it delegates
   to the router.

Return type becomes `{ amount: Dinero<number>, sourceId, settlementMode:
"invoice" | "wallet" | "one_time" | "noop", state }`.

Update `BillMeterFactDeps` to include `settlement` service.
`EntitlementWindowDO.processBillingBatch()` must pass the WalletDO stub
down; extend its constructor with `env.wallet`.

### Slice 10: Credit purchase flow

Write `internal/services/src/use-cases/wallet/purchase-credits.ts`:

- Accepts `{ walletId, amount: Dinero, currency, provider }`.
- Creates a Stripe checkout session (or equivalent) for the credit pack.
- Returns `{ checkoutUrl, sessionId }`. No ledger writes yet.

Write `confirm-credit-purchase.ts`:

- Called from `processWebhookEvent` on a credit-purchase payment success.
- Calls `WalletService.addCredits({ sourceType: "purchase", sourceId:
  providerInvoiceId, … })`.
- Pushes `walletDO.sync({ type: "grant_added", grant })` with the new
  grant including `remaining` set to the initial `amount`.
- Idempotent — same `sourceId` returns the existing grant (gateway's
  `ledger_idempotency` enforces this).

Extend `processWebhookEvent` to route credit-purchase confirmations to
this use case (new outcome type alongside invoice payment flow).

### Slice 11: Grant expiry cron

Daily job finds grant accounts where `expires_at < now()` and
`gateway.getAccountBalance(grantAccountKey(id)) > 0`, emits
`ledgerGateway.createTransfer(grantAccountKey(id) →
houseAccountKey('expired_credits', …), remaining,
source_type:'grant_expiry', source_id:'expire:<id>:<expires_at>')`.

Also pushes `walletDO.sync({ type: "grant_revoked", grantId })` so the
edge drops the expired grant from its local cache within the same run.

### Slice 12: API endpoints

New routes (POST, matching existing convention):

- `POST /v1/wallet/balance` — reads from WalletDO for speed, falls back to
  `WalletService.getBalance` if the DO is unavailable.
- `POST /v1/wallet/purchase` — initiates credit purchase (returns checkout
  URL).
- `POST /v1/wallet/grants` — lists credit grants with `remaining` from
  `LedgerGateway.getAccountBalance` per grant (plus Postgres rows for
  metadata).

Register in `apps/api/src/index.ts`. Expose `WalletService` +
`SettlementRouter` via `apps/api/src/middleware/init.ts`. Update
`apps/api/src/hono/env.ts`. Update `packages/api/` OpenAPI types.

### Slice 13: UI — wallet dashboard & balance

Wallet dashboard: current balance, grant history timeline (purchases /
burns / expirations), burn rate over time chart. Customer billing page
shows wallet balance alongside subscription status — if wallet-based,
show "Credits remaining: $X" prominently.

### Slice 14: UI — credit purchase flow

Pack selection → Stripe checkout → confirmation callback → balance
updated via DO push within seconds.

### Slice 15: UI — burn rate & settlement config

Per-feature credit cost editor on the plan-version feature configuration
page. Shows current rate and effective date. Per-subscription (or
per-customer) toggle between invoice and wallet settlement modes.

### Slice 16: Tests

**Pure-function unit tests** — `wallet/core.test.ts`. Priority / expiry /
multi-grant / insufficient-balance / sub-cent Dinero cases.

**WalletService integration tests** (Postgres + pgledger):

- Wallet creation idempotency.
- Credit grant with priority + expiry; balance via gateway.
- FIFO / priority consumption order with sub-cent Dinero.
- Expired grants skipped during deduction.
- Atomic deduction (insufficient balance → full rollback; no partial
  gateway batch).
- `GRANT_FLUSH_MISMATCH` when outbox lines exceed live grant balance
  (simulated revoke in Postgres between DO plan and flush).
- `seedHouseAccounts` called from `addCredits` is safe under concurrent
  first-use.

**WalletDO tests** (miniflare / DO harness):

- Deduction idempotency (same `sourceId` → same result).
- Local aggregate tracks after sequential deductions.
- Outbox rows created per deduction.
- `sync({ grant_added })` → local remaining matches pushed Dinero.
- `sync({ grant_revoked })` → revoked grant skipped.
- `sync({ full_snapshot })` → local state matches `getActiveGrants()`
  payload.
- Alarm flush → `deductCredits` succeeds; pgledger grant balances update.
- Flush failure → `GRANT_FLUSH_MISMATCH` → `full_snapshot` recovery path.

**End-to-end tests:**

- Settlement router per mode: `invoice` posts a single customer charge,
  `wallet` posts zero customer charges and exactly-one burn batch per
  meter event, `one_time` charges via provider runtime.
- Purchase → webhook → `addCredits` → DO sync → `hasEnoughCredits` sees
  the new grant.
- `billMeterFact` + wallet mode → DO deduct → flush → gateway sums equal
  the expected per-grant drawdowns.
- Burn rate versioning: switching rates mid-period applies the new rate
  only to events timestamped after `effectiveAt`.
- Concurrent deductions serialized by DO — no double-burn.

## Execution Order

```
Slice 1 (schema) ──► Slice 2 (burn rates) ──► Slice 3 (settlement pref)
                                           │
Slice 4 (validators) ◄─────────────────────┤
                                           │
Slice 5 (pure fold/decide) ◄───────────────┤
                                           │
Slice 6 (WalletService) ◄──────────────────┤
                                           │
Slice 7 (WalletDO) ◄───────────────────────┤
                                           │
Slice 8 (SettlementRouter) ◄───────────────┤
                                           │
Slice 9 (wire meter billing) ◄─────────────┤
                                           │
Slice 10 (credit purchase + webhook) ◄─────┤
                                           │
Slice 11 (grant expiry cron) ◄─────────────┤
                                           │
Slice 12 (API endpoints) ◄─────────────────┤
                                           │
Slices 13-15 (UI) ◄────────────────────────┤
                                           │
Slice 16 (tests throughout)
```

Slices 1–5 are P0 (data + pure logic).
Slices 6–8 are P1 (the three services: wallet edge, wallet durable,
router).
Slices 9–11 are P2 (wiring into billing + purchase + expiry).
Slice 12 is P3 (API).
Slices 13–15 are P4 (UI).
Slice 16 runs throughout (tests at each slice).

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api test`
- `pnpm --filter api type-check`
- `pnpm --filter @unprice/api typecheck`

## Exit Criteria

- Customers can hold prepaid credit balances (aggregate from gateway
  balances; no cached columns).
- Credits are purchased via provider checkout and granted on payment
  confirmation (`addCredits` + DO `sync`).
- Agent / meter usage can be settled by wallet deduction or invoice
  accumulation **without** double-posting meter charges.
- Wallet deductions happen at the edge via WalletDO (sub-millisecond
  balance checks, no Postgres round-trip on the hot path).
- WalletDO and WalletService share the same pure `foldWalletState` /
  `decideDeduct` logic.
- Push-based grant synchronization: Postgres mutations push state to the
  WalletDO within the same request.
- Outbox pattern: DO deductions flush to `WalletService` →
  `LedgerGateway.createTransfers` batched transfers.
- Burn rates are versioned and can be changed without modifying existing
  subscriptions.
- Settlement router correctly routes charges to the configured mode with
  transparent fallback from `wallet` to `invoice` when balance is
  insufficient.
- No `balance_cents` / `remaining_cents` columns exist. DO cache is
  recoverable via `getActiveGrants` + `GRANT_FLUSH_MISMATCH` handling.
- Legacy `creditGrants` / `invoiceCreditApplications` tables removed (if
  still present at branch start).
- SDK exposes wallet balance and purchase endpoints.
- Dashboard shows wallet state and allows credit purchases.

## Out Of Scope

- Wallet top-up subscriptions (recurring auto-purchase).
- Credit transfer between customers.
- Multi-currency wallet conversion.
- Crypto-backed credit purchase (the `one_time` settlement mode leaves
  room for this but implementation is not in scope).
- Real-time spending caps / kill-switch at apply() time (Phase 8 — uses
  the `WalletDO.hasEnoughCredits` method introduced here, but enforcement
  policy and UX are Phase 8 scope).

## Design Decisions

### Why not keep wallets in Postgres only?

`EntitlementWindowDO.processBillingBatch()` processes up to 1000 meter
facts per alarm tick. Each fact that routes through wallet settlement
needs a balance check + deduction. At ~10 ms per Postgres round-trip,
that's 10 seconds of serial DB calls per batch — per customer per
feature. The DO eliminates this bottleneck entirely: balance check +
deduction are local SQLite operations within the same Cloudflare colo.

### Why not put wallet state inside EntitlementWindowDO?

The `EntitlementWindowDO` is scoped per `(customer, feature, window)`. A
wallet is scoped per `(customer, currency)`. If 5 features meter
concurrently, 5 `EntitlementWindowDO`s would need independent wallet state
copies — and they'd diverge immediately when any one of them deducts. A
dedicated `WalletDO` per `(customer, currency)` is the natural
serialization boundary.

### Why push over pull for grant sync?

Pull (DO polls Postgres periodically) is wasteful when nothing changed,
stale between polls, and creates unnecessary Postgres load. Push is
event-driven: the code path that mutates grants in Postgres already has
the data in hand — it just forwards it to the DO. The DO learns about
changes within the same request that caused them. If a push fails, the
next deduction can carry a fallback `full_snapshot`, and the outbox flush
serves as a consistency checkpoint.

### What if the DO and Postgres disagree?

The outbox flush is the reconciliation point. When
`WalletService.deductCredits()` validates outbox lines against live
`LedgerGateway` grant balances, a revoke or concurrent burn in Postgres
can make the DO plan stale — the service returns `GRANT_FLUSH_MISMATCH`.
The DO then runs a `full_snapshot` from `getActiveGrants()` (Postgres rows
+ gateway balances). This matches metering's model: the DO is optimistic,
Postgres + pgledger is authoritative, and flush + snapshot are the
convergence mechanisms. There is no separate `reconcileBalance` column
drift repair.

### Why not let `WalletService` import `LedgerService`?

They are sibling capabilities, not a layered stack.
`LedgerService` owns customer AR / house revenue posting.
`WalletService` owns grant lifecycle and burn waterfalls. Both need
pgledger access — they both depend on the same `LedgerGateway`. Letting
`WalletService` call `LedgerService` would couple two domain services
through a peer-service import and smuggle wallet-specific semantics into
the customer-side API. A shared gateway keeps both services honest and
independently testable. When a use case needs both in one DB transaction
(rare), orchestration lives in the use case with two gateway calls in
order.
