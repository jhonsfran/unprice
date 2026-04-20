# Phase 7: Wallets & Reservations (pgledger-native)

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
Chart of accounts: [../pgledger-ai-wallet-coa.md](../pgledger-ai-wallet-coa.md)
PR title: `feat: wallets and reservations on pgledger`
Branch: `feat/wallets-reservations`

**Prerequisite:** [Phase 6.6](./unprice-phase-06.6-new-ledger.md) and
[Phase 6.7](./unprice-phase-06.7-agent-billing-simplification.md) both
green, including 6.7.10's load-validation experiment.

## Mission

Make pgledger the single source of truth for customer balance. The
"wallet" is not a Drizzle table — it is the `customer.{customerId}.available`
account in pgledger. A reservation is a pre-funded chunk of that balance
moved into `customer.{customerId}.reserved` so the DO can consume against
it locally without phoning home per event. At period end, the consumed
portion is captured to `customer.{customerId}.consumed` and any unused
portion returned to `available`.

Account naming drops two redundant fields from the earlier draft:

- **No currency in the name.** Pgledger tracks currency as a column on
  each account. Phase 7 is single-currency-per-customer (one `available`
  account per customer, in that customer's currency). Multi-currency is
  Phase 8+ and adds a currency suffix *then*, not now.
- **No `projectId` in customer account names.** Customer IDs are
  `cus_*` nanoids, already globally unique — scoping them is what the
  prefix gives you. `platform.*` keeps `{projectId}` because the
  platform-side pool *is* per-tenant and there's no globally-unique
  tenant ID in the key otherwise.

Ledger writes per customer per period: **3–7** (reservation create +
refills + reconcile). Not per-event. The DO holds the hot path; pgledger
holds the money.

This phase rips out the legacy wallet + credit-grant apparatus completely
and replaces it with the strict-reservation chart of accounts defined in
`../pgledger-ai-wallet-coa.md`. No dual-write. No parallel grant system.
No separate DO for funding serialization. No postpaid path (deferred to
Phase 8 — explicit non-goal below).

## Outcome

- One new Drizzle table: `entitlement_reservations` (state machine for the DO).
  No `wallets` table, no `credit_grants` table, no `credit_burn_rates` table,
  no `reservation_refills` table.
- **One** `platform.{projectId}.adjustments` account seeded per project.
  Top-ups, promos, and corrections all issue from here with
  `metadata.source` distinguishing them. `funding_clearing`,
  `refund_clearing`, `writeoff`, and `revenue` are deferred to Phase 8
  (funding_clearing needs payout reconciliation; the others need their
  Phase 8 flows).
- Three `customer.{customerId}.*` accounts created lazily on first
  customer event: `available`, `reserved`, `consumed`. Currency is an
  account property, not part of the key. `receivable` is deferred to
  Phase 8, where postpaid flow writes to it.
- `WalletService` exposes six methods: `recharge`, `createReservation`,
  `refillReservation`, `captureReservation`, `adjust`, `chargeSubscriptionFee`.
  Everything else from CoA §7.6 (release/refund/settle/writeoff) either folds
  into these or lands in Phase 8.
- `EntitlementWindowDO` gains `reservation_id`, `allocation_cents`,
  `allocation_remaining_cents`, `consumed_cents`, `refill_*` columns on the
  existing singleton `meter_window` row — no second SQLite table. Hot path
  denies `LIMIT_EXCEEDED | SPEND_CAP_EXCEEDED | WALLET_EMPTY`.
- Refill serialization via `pg_advisory_xact_lock(hashtext(customer_id))` inside the refill transaction. No second Durable Object.
- Legacy `credit_grants`, `invoice_items`, `invoice_credit_applications` tables deleted. Invoice lines are a SQL projection over `pgledger_entries_view` keyed by `statement_key`.
- All `house:*` account builders renamed to the `platform.*` / `customer.*` dot convention.

## Dependencies

- Phase 6.6 — pgledger install, `LedgerService.createTransfers`, `Dinero<number>` at service boundaries.
- Phase 6.7 — DO with no Postgres client, no ledger imports, snapshotted rate card, analytics-only outbox, per-meter spend caps.

## Read first

- `../pgledger-ai-wallet-coa.md` — the chart of accounts this phase implements. If anything here contradicts the CoA, the CoA wins.
- `internal/services/src/ledger/gateway.ts` — only path into pgledger.
- `internal/services/src/ledger/accounts.ts` — account key builders (renamed in 7.1).
- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` — extended in 7.4.
- `internal/services/src/use-cases/payment-provider/process-webhook-event.ts` — top-up entry point.
- `internal/db/src/schema/invoices.ts` — legacy tables deleted in 7.8.

## The reservation primitive

The whole phase turns on one idea. A reservation is a chunk of funded
money the DO is authorized to consume locally without touching the ledger
per event.

**Create** (one pgledger transaction):

```
customer.{cid}.available → customer.{cid}.reserved : R
  metadata: { flow: "reserve", reservation_id, entitlement_id, idempotency_key }
```

If `customer.{cid}.available < R`, create at whatever is available; the
DO denies `WALLET_EMPTY` once that chunk is consumed. Reservation row
records `allocation_cents` = what was actually moved.

**Consume** (DO SQLite only, no ledger write):

```
DO.apply(event)
  ├─ compute priced fact (rate card snapshotted in 6.7.2)
  ├─ allocation_remaining_cents -= amount_cents
  ├─ consumed_cents             += amount_cents
  └─ insert priced fact into outbox → Tinybird
                                      ← no ledger write
```

**Refill** (when `allocation_remaining < refill_threshold × allocation`):

```
DO → /internal/refill HTTP RPC (behind advisory lock on customer_id) →
  WalletService.refillReservation:
    customer.{cid}.available → customer.{cid}.reserved : refill_chunk
    metadata: { flow: "refill", reservation_id, request_seq, idempotency_key }
  returns new allocation_remaining_cents to DO
```

`pg_advisory_xact_lock(hashtext(customer_id))` serializes refills for a
single customer across all their meter DOs. Two meters racing for the
last dollar: second request sees the updated balance, partial-fills or
denies. Idempotency is the (reservation_id, request_seq) pair encoded in
the metadata + `unprice_ledger_idempotency` row.

**Reconcile** (period-end cron, one pgledger transaction per reservation):

```
customer.{cid}.reserved → customer.{cid}.consumed : consumed_cents      # recognize usage
customer.{cid}.reserved → customer.{cid}.available : allocation - consumed  # refund unused
  metadata: { flow: "capture", reservation_id, statement_key, invoice_item_kind: "usage" }
```

Skip the second leg if `consumed_cents == allocation_cents`.

**Ledger writes per customer per period:** 1 (reserve) + N refills (typically 2–5)
+ 1 (capture). Total 3–7 transfers. The DO absorbs N-thousand events
without touching Postgres.

**Overdraft bound:** `refill_chunk × concurrent_meters_per_customer`. A
customer with 3 hot meters and a $1 refill chunk can overrun by at most
$3 while refills race. Tune `refill_chunk_cents` per meter velocity.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │    EntitlementWindowDO (per cust+meter) │
  event ───────────►│  apply():                               │
                    │    ├─ priced fact (snapshotted)         │
                    │    ├─ allocation_remaining -= amt       │
                    │    ├─ consumed_cents += amt             │
                    │    ├─ if remaining < threshold &&       │
                    │    │       !refillInFlight:             │
                    │    │     ctx.waitUntil(requestRefill()) │
                    │    └─ priced fact → outbox → Tinybird   │
                    └─────────┬────────────────┬──────────────┘
                              │ HTTP RPC       │ alarm flush
                              ▼                ▼
                   ┌──────────────────────┐   ┌──────────────┐
                   │  POST /internal/     │   │  Tinybird    │
                   │  refill              │   │  meter_fact  │
                   │  pg_advisory_xact_   │   └──────────────┘
                   │  lock(customer_id)   │
                   │  → WalletService     │
                   └──────────┬───────────┘
                              ▼
                   ┌──────────────────────────────────────┐
                   │  WalletService (6 methods)           │
                   │  recharge / createReservation /      │
                   │  refillReservation / captureReservation /
                   │  adjust / chargeSubscriptionFee      │
                   └──────────┬───────────────────────────┘
                              │ LedgerService.createTransfers
                              ▼
                   ┌──────────────────────────────────────┐
                   │  pgledger (Phase 7 subset of CoA §1) │
                   │  customer.{cid}.available            │
                   │  customer.{cid}.reserved             │
                   │  customer.{cid}.consumed             │
                   │  platform.{pid}.adjustments          │
                   │  (currency is an account property)   │
                   │  (funding_clearing, receivable,      │
                   │   refund_clearing, writeoff, revenue │
                   │   → Phase 8)                         │
                   └──────────────────────────────────────┘
```

No per-event ledger write anywhere. No second DO. No grants subsystem.

## Guardrails

- The CoA is law. Account names use the dot form (`platform.{projectId}.adjustments`, `customer.{customerId}.available`). The colon form from repo legacy is **renamed** in slice 7.1, not kept in parallel. Currency is an account property (tracked by pgledger as a column), not part of the key.
- Strict reservation only. No soft-overage paths. Capture clamps at `reserved`; any `actualCents > allocationCents` is an upstream bug, not a ledger event. See §Reservation sizing and overrun SLO below for the sizing rule and the alert contract.
- Phase 7 seeds **one** platform account (`platform.{projectId}.adjustments`) and **three** customer accounts (`available`, `reserved`, `consumed`). `funding_clearing`, `refund_clearing`, `writeoff`, `revenue`, and `customer.receivable` are Phase 8 — no Phase 7 flow writes to them, so seeding them is dead weight. Phase 8 adds them as part of postpaid / refund-escrow / payout-reconciliation work.
- **Zero ledger writes per priced event.** Phase 6.7 guarantees this; 7.4's allocation path must not regress it.
- No cached `balance_cents` / `remaining_cents` columns anywhere outside the DO's own SQLite. Balance reads go through `LedgerService.getAccountBalance`.
- No `wallets` Drizzle table. No `credit_grants` Drizzle table. No `credit_burn_rates` Drizzle table. Grants are `platform.adjustments → customer.available` transfers with metadata; their "balance" is the sum of those transfers. Burn-rate tuning is a safety margin knob on the entitlement, not a versioned table.
- Platform-wide revenue is `Σ customer.*.consumed` via SQL. No `platform.revenue` sink account in Phase 7.
- `WalletService` does not depend on `LedgerService`. Both sit on `LedgerService`.
- No `CustomerFundingDO`. Refill serialization is `pg_advisory_xact_lock(hashtext(customer_id))` inside the refill transaction.
- No postpaid path in Phase 7. Postpaid (`platform.adjustments`-seeded allowance + `customer.receivable` on shortfall) is Phase 8.
- Refunds in Phase 7 are **wallet-credit only**: negative `adjust` with `metadata.source = "refund"`. Two-step refund-back-to-card (which would need `platform.refund_clearing`) is Phase 8.

## Reservation sizing and overrun SLO

Strict reservation means period-end capture will fail if the DO
somehow consumed more than was ever allocated. We trade a correctness
knob (partial capture / receivable top-up) for job failure as a loud
signal. That only works if (a) reservations are sized conservatively
by default and (b) the rare overrun case is visible and pageable.

**Default sizing rule (applied in `activateEntitlement`, not in the
wallet):**

```
initial_allocation_cents = max(
  refill_chunk_cents,
  last_24h_peak_hour_cost_cents * 2,
  minimum_floor_cents           // per-project config, e.g. $5
)
```

Where `last_24h_peak_hour_cost_cents` is sourced from the Tinybird
`meter_fact` aggregate for the prior period (zero for new customers —
the `minimum_floor_cents` carries them). The `* 2` is the safety
margin; operators can override per-entitlement. New AI entitlements
(no prior history) use `minimum_floor_cents` only.

**Refill threshold and chunk defaults:**

- `refill_threshold_bps = 2000` (20%) for slow meters, `5000` (50%)
  for high-velocity meters (RPS ≥ 50 sustained).
- `refill_chunk_cents = initial_allocation_cents / 4` (four refills
  expected per period under the default sizing rule).

Both live on the entitlement config, snapshot into `entitlement_reservations`
at create, and are **immutable for the life of the reservation**.
Operator updates take effect at the next period boundary.

**Overrun SLO (the pageable signal).** At capture time, the reconcile
cron checks:

```ts
if (actualCents > allocationCents) {
  logger.error("reservation_overrun", { reservationId, actualCents, allocationCents, delta: actualCents - allocationCents })
  metrics.increment("wallet.reservation_overrun", { projectId })
  // Clamp capture to allocationCents. Emit the delta as an explicit
  // adjustment with source = "overrun_correction" so the ledger
  // identity still balances and we can audit later.
  walletService.adjust({
    signedAmountCents: actualCents - allocationCents,
    actorId: "system:reconcile",
    source: "manual",
    reason: `reservation_overrun reservation_id=${reservationId}`,
    idempotencyKey: `overrun:${reservationId}`,
  })
}
```

The `wallet.reservation_overrun` metric is an SLO: target 0/day.
Non-zero pages the on-call. A standing non-zero rate is a bug in the
DO hot path (allocation_remaining not decremented under some race) or
in sizing (default rule too tight) — never "just how it is."

Why not clamp silently: silent clamping hides sizing regressions and
DO bugs. Phase 8's `customer.receivable` path will absorb overruns as
debt once postpaid exists, but in Phase 7 we want the loud version.

## Non-goals

- **Postpaid / invoice-collected plans.** Deferred to Phase 8. All Phase 7 customers are prepaid-wallet-funded. The CoA has the seams (`platform.adjustments`, `customer.receivable`) — Phase 8 wires them.
- **Grants as a subsystem.** Grants are `platform.adjustments → customer.available` transfers with `{source: "promo" | "purchased" | "plan_included" | "manual", grant_id, expires_at?, priority?}` in metadata. Expiry is a scheduled reverse adjustment. There is no `credit_grants` Drizzle table, no `credit_burn_rates` table, no `GrantsManager` class, no `/v1/wallet/grants` endpoint backed by a table.
- **Burn-rate multipliers.** If AI costs shift, adjust the reservation-sizing margin on the entitlement (one config field). Do not build a scope/effective_at/superseded_at versioned table for a knob a use case can own.
- **ML-based refill chunk sizing.** Static per-meter config. Iterate from data later.
- **Cross-currency wallets.** One account holds one currency (pgledger enforces this on the currency column). A customer operating in multiple currencies would need one `customer.{cid}.available` per currency, disambiguated by a currency suffix — not needed in Phase 7 because every customer today is single-currency. Cross-currency requires FX accounts and is future work.
- **Cross-meter spend caps.** Phase 6.7 ships per-meter spend caps; cross-meter aggregation is Phase 8.
- **Best-effort overdraft prevention via distributed locks.** Refill chunk is the overdraft bound. Document it; do not try to eliminate it.

## Cleanup triggered by this rewrite

This is a rip-and-replace; nothing is preserved for backward compatibility.
Slice 7.1 performs the teardown as a single migration. The list below is
the complete expected diff surface.

### Tables deleted

- `credit_grants` (legacy, in `internal/db/src/schema/invoices.ts`).
- `invoice_items` (replaced by `invoice_lines_v1` view — slice 7.8).
- `invoice_credit_applications` (replaced by ledger transfers with metadata — slice 7.8).
- Any `wallets` / `wallet_*` tables if present in earlier scaffolding (search `rg "wallets" internal/db/src/schema/` before starting).

### Tables created

- `entitlement_reservations` (slice 7.2).

### Code deleted

- `internal/services/src/ledger/accounts.ts`:
  - `houseAccountKey` and all `house:*` builders → replaced by `platformAccountKey` (dot form).
  - `grantAccountKey` and `grant:*` references → gone. Grants are metadata, not accounts.
  - `customerAccountKey` single-account form (the one ensuring `customer:<id>:<currency>`) → replaced by `customerAccountKeys` (plural) returning the four-account bundle per CoA §7.3.
- `internal/services/src/ledger/gateway.ts`:
  - `seedHouseAccounts` → renamed `seedPlatformAccounts`.
  - `ensureCustomerAccount` → renamed `ensureCustomerAccounts` (plural, four-account bundle).
  - `postCharge` → deleted. Callers switch to the `WalletService` primitives.
  - `postRefund` → deleted. Callers switch to `WalletService.adjust({ signedAmountCents: -N, source: "refund" })` in Phase 7; external-refund flow returns in Phase 8 via `platform.refund_clearing`.
- `internal/services/src/billing/service.ts`:
  - Any code reading grant balance from the legacy `credit_grants` table → deleted. Grant balance is `Σ platform.adjustments → customer.available` transfers where metadata.source matches.
- `internal/services/src/subscriptions/invokes.ts` (the `invoiceSubscription` flow):
  - `projectedInvoiceItems` construction + `txBillingRepo.createInvoiceItemsBatch` → deleted (slice 7.8).
  - `LedgerService.postCharge` loop → replaced with `WalletService.chargeSubscriptionFee` (a single `customer.available → customer.consumed` transfer for flat periodic fees; see slice 7.3).
- `internal/db/src/schema/invoices.ts`:
  - `invoiceItems`, `invoiceCreditApplications`, `creditGrants` table defs and their relations → deleted.
  - `invoices.amountCreditUsed`, `invoices.subtotalCents`, `invoices.paymentAttempts` → dropped (derive from ledger / provider webhooks on demand).
  - `invoices.totalCents` stays as-is. Set once at finalization from the sum of `invoice_lines_v1` rows for the statement key. A rename to `totalCentsFrozen` is pure ceremony; the finalization contract is behavioral, not schema-level.
- `internal/db/src/validators/invoices.ts`:
  - `invoiceItems` validator, `creditGrants` validator → deleted.
- `DrizzleBillingRepository`:
  - `createInvoiceItemsBatch`, `listInvoiceItemsByInvoice` → deleted.
  - New method: `findInvoiceLinesByStatementKey(projectId, statementKey)` that reads `invoice_lines_v1`.
- SDK types: `InvoiceItem` → replaced by `InvoiceLine` projected from the view.

### Code renamed (no behavior change)

- Every `house:*` string literal → `platform.*` with the dot convention. Single `rg "house:" internal/ apps/` pass; no stragglers.
- `formatAmountForLedger`, `ledgerAmountToCents` in `@unprice/db/utils` → already deleted in 6.6 per its own guardrails. Verify empty before starting 7.1.

### Documentation synced

- `../pgledger-ai-wallet-coa.md` §7.2 mandates the colon form — **this phase overrides that with the dot form**. Update the CoA doc in the same PR.
- `docs/adr/ADR-0001-canonical-backend-architecture-boundaries.md` — check for references to `WalletService`, `SettlementRouter`, or grant accounting; update or delete.

## Execution slices

### 7.1 — Account rename and legacy teardown

Intent: one migration, one code sweep. The tree ends this slice with no
`house:*` strings, no legacy `credit_grants` table, no grant-account
builders, no `invoice_items` table, no `invoice_credit_applications`
table, and the two `platform.*` + three `customer.*` account key
builders in place (see "Outcome" for why the CoA's full set is not
seeded here).

Migration (single Drizzle migration):

```sql
-- Drop legacy tables (pre-production cleanup; no data preserved).
DROP TABLE IF EXISTS invoice_items            CASCADE;
DROP TABLE IF EXISTS invoice_credit_applications CASCADE;
DROP TABLE IF EXISTS credit_grants            CASCADE;

-- Slim invoices to a header + collection state. `total_cents` stays —
-- it's re-contracted (set once at finalization) rather than renamed.
ALTER TABLE invoices DROP COLUMN IF EXISTS amount_credit_used;
ALTER TABLE invoices DROP COLUMN IF EXISTS subtotal_cents;
ALTER TABLE invoices DROP COLUMN IF EXISTS payment_attempts;

-- Deactivate legacy pgledger accounts from Phase 6.6:
--   house:revenue:*, house:credit_issuance:*, house:expired_credits:*, house:refunds:*
-- and any single-account customer:<id>:<currency> accounts. Use the
-- deactivation function exposed by pgledger; do not physically delete.
-- New account keys are created on first use.
```

Code (`internal/services/src/ledger/accounts.ts`):

```ts
// Phase 7 builders cover the accounts Phase 7 actually writes to.
// The full CoA vocabulary ("funding_clearing" | "refund_clearing" |
// "writeoff" | "revenue", "receivable") lands in Phase 8; widen the
// union there, not here. Currency is pgledger's account-level column,
// passed at creation time — it does not appear in the key.
export const platformAccountKey = (
  kind: "adjustments",
  projectId: string,
): string => `platform.${projectId}.${kind}`

export const customerAccountKeys = (
  customerId: string,
): {
  available: string
  reserved: string
  consumed: string
} => ({
  available: `customer.${customerId}.available`,
  reserved:  `customer.${customerId}.reserved`,
  consumed:  `customer.${customerId}.consumed`,
})
```

Normal balance (set at creation in the gateway; pgledger does not permit changing it later):

- Credit-normal: `customer.available`, `customer.reserved`, `customer.consumed`, `platform.adjustments`.
- Debit-normal: *(none in Phase 7; `platform.funding_clearing` would be debit-normal when added in Phase 8.)*

Non-negativity enforced on: `customer.available`, `customer.reserved`,
`customer.consumed`. At the pgledger account level if the version
supports it; otherwise at the service layer inside the same transaction
as the transfer, guarded by the advisory lock.

Seeding:

- `LedgerService.seedPlatformAccounts(projectId, currency)` creates the single `platform.{projectId}.adjustments` account with the project's default currency. Called on project creation; idempotent.
- `LedgerService.ensureCustomerAccounts(customerId, currency)` creates the three `customer.{customerId}.*` accounts in one pgledger transaction. Called lazily on first customer-touching operation. `currency` comes from the customer's configured currency; mismatch at later calls is an upstream error.

Completion check:

```
rg "house:|house\\." internal/ apps/                  # → empty
rg "grantAccountKey|grant:" internal/services/        # → empty
rg "credit_grants|invoiceItems|invoiceCreditApplications" internal/db/  # → empty
```

### 7.2 — `entitlement_reservations` schema

One table. That's all the Drizzle this phase adds.

```sql
CREATE TYPE reservation_status AS ENUM ('active', 'exhausted', 'reconciled');

CREATE TABLE entitlement_reservations (
  id                      text PRIMARY KEY,
  project_id              text NOT NULL,
  customer_id             text NOT NULL,
  entitlement_id          text NOT NULL,
  currency                text NOT NULL,
  allocation_cents        bigint NOT NULL,  -- total ever moved into reserved for this reservation
  consumed_cents          bigint NOT NULL DEFAULT 0,  -- authoritative; DO syncs via cron
  status                  reservation_status NOT NULL DEFAULT 'active',
  refill_threshold_bps    integer NOT NULL DEFAULT 2000,
  refill_chunk_cents      bigint NOT NULL,
  period_start_at         timestamptz NOT NULL,
  period_end_at           timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  reconciled_at           timestamptz,
  UNIQUE (entitlement_id, period_start_at)
);
```

Why no `funding_strategy` enum: Phase 7 is prepaid-only. An enum with
one value is just ceremony; Phase 8 adds the column when it gains the
`'postpaid'` variant.

Why no `refill_request_seq` column: the monotonic sequence lives in the
DO's SQLite (see slice 7.4) and is passed as metadata on each refill
RPC. Server-side idempotency is already enforced by
`unprice_ledger_idempotency` on `(source_type='refill', source_id=reservation_id:seq)`.
Two idempotency layers for one idea is dead weight.

Why no `reservation_refills` table: each refill is a pgledger transfer
with `metadata.reservation_id` and `metadata.request_seq`. History
queries are SQL over `pgledger_entries_view` filtered by metadata —
same pattern as invoice lines.

### 7.3 — `WalletService` primitives

File: `internal/services/src/wallet/service.ts`.

Six methods. The CoA §7.6 vocabulary (release / refund-to-wallet /
refund-external / settle-receivable / writeoff-receivable) is expressed
either as a degenerate case of these six or is deferred to Phase 8 where
the supporting accounts come online. Collapsing them now saves ~40% of
the service surface without losing any Phase 7 capability.

Every method wraps its transfers in one pgledger transaction and inserts
one `unprice_ledger_idempotency` row.

```ts
export type WalletDeps = {
  services: Pick<ServiceContext, "ledgerGateway">
  db: Database
  logger: AppLogger
}

export class WalletService {
  constructor(private deps: WalletDeps) {}

  // External funds enter the wallet (after Stripe/ACH webhook). In
  // Phase 7 there is no payout reconciliation, so no funding_clearing
  // escrow: recharge is ONE transfer `platform.{projectId}.adjustments
  // → customer.{customerId}.available` with metadata.source = "topup"
  // and metadata.external_ref = provider_event_id. Phase 8 introduces
  // `platform.{projectId}.funding_clearing` as a true escrow and the
  // recharge path grows a second leg for payout settlement.
  // After commit, loops pending reservations and calls /internal/refill.
  recharge(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    amountCents: number; externalRef: string; idempotencyKey: string
  }): Promise<Result<void, WalletError>>

  // Open a reservation: insert entitlement_reservations row +
  // customer.available → customer.reserved. Partial fulfillment if
  // available < requested; allocation_cents records what actually moved.
  createReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    entitlementId: string; requestedCents: number
    refillThresholdBps: number; refillChunkCents: number
    periodStartAt: Date; periodEndAt: Date
    idempotencyKey: string
  }): Promise<Result<{ reservationId: string; allocationCents: number }, WalletError>>

  // Atomic `available → reserved : refill_chunk` under advisory lock.
  // Partial fulfilment when available < requested. Idempotent on
  // (reservationId, requestSeq) via unprice_ledger_idempotency.
  refillReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    reservationId: string; requestSeq: number; requestedCents: number
  }): Promise<Result<{ grantedCents: number }, WalletError>>

  // Period-end capture. Atomic in one pgledger transaction:
  //   reserved → consumed : actualCents            (recognize usage)
  //   reserved → available : allocation − actual   (refund unused; skipped if 0)
  // actualCents == 0 handles the release-reservation case (TTL expiry,
  // user cancel, reservation where nothing was consumed).
  captureReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    reservationId: string; allocationCents: number; actualCents: number
    statementKey: string; idempotencyKey: string
  }): Promise<Result<void, WalletError>>

  // Operator adjustment (signed). Covers promos, corrections, and
  // wallet-credit refunds (metadata.source distinguishes them).
  // Positive: platform.{projectId}.adjustments → customer.{customerId}.available.
  // Negative: customer.{customerId}.available → platform.{projectId}.adjustments.
  //
  // Negative-adjust clamping (the A > available edge case):
  //   - If |signedAmountCents| > current customer.available, clamp
  //     the actual transfer to `available` and return
  //     { clampedCents: N, unclampedRemainderCents: M > 0 } in
  //     WalletResult. The caller decides what to do with the remainder:
  //       * "refund" source → Phase 8 refundExternal (not available in
  //         Phase 7; caller surfaces an operator task).
  //       * "manual" / "promo_expiry" / "overrun_correction" → accept
  //         the clamp as the full outcome; the ledger stays non-negative.
  //   - This is ALWAYS a service-layer check under the advisory lock
  //     (same tx as the transfer), not just a pgledger constraint, so
  //     callers get a typed result instead of a blind error.
  //
  // If expiresAt is set, enqueues a scheduled reverse-adjust that at
  // expiry moves MIN(original, current customer.available) back. The
  // scheduled job is idempotent on idempotencyKey = "expire:{grantId}"
  // and uses this same clamp path — so running the expiry twice, or
  // running it after the customer has spent the grant, both converge
  // to "take what's there, never push available negative."
  adjust(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    signedAmountCents: number; actorId: string; reason: string
    source: "promo" | "purchased" | "plan_included" | "manual" | "refund" | "promo_expiry"
    idempotencyKey: string
    expiresAt?: Date
  }): Promise<Result<{ clampedCents: number; unclampedRemainderCents: number }, WalletError>>

  // Flat subscription fee. ONE transfer: customer.available → customer.consumed.
  // The reservation step is pure ceremony for a known amount — skip it.
  // Invoice projection differentiates this from usage via
  // metadata.invoice_item_kind = "subscription". Replaces the deleted
  // LedgerService.postCharge loop in invoiceSubscription.
  chargeSubscriptionFee(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    amountCents: number; statementKey: string; billingPeriodId: string
    idempotencyKey: string
  }): Promise<Result<void, WalletError>>
}
```

**What the other CoA primitives map to:**

| CoA §7.6 name               | Phase 7 call                                     | Phase |
|-----------------------------|--------------------------------------------------|-------|
| `transferAvailableToReserved` | folded into `createReservation` and `refillReservation` | 7     |
| `releaseReservation`        | `captureReservation({ actualCents: 0 })`         | 7     |
| `refundToWallet`            | `adjust({ signedAmountCents: -N, source: "refund" })` | 7     |
| `refundExternal`            | *(requires `platform.refund_clearing`)*          | 8     |
| `settleReceivable`          | *(requires `customer.receivable`)*               | 8     |
| `writeOffReceivable`        | *(requires `customer.receivable` + `platform.writeoff`)* | 8     |

Serialization: every `refillReservation`, `createReservation`, and
`chargeSubscriptionFee` call opens its transaction with:

```sql
SELECT pg_advisory_xact_lock(hashtext('customer:' || :customer_id));
```

This serializes balance-changing operations per customer across the app,
without a DO. Lock scope is the transaction — released on commit/rollback.

**No `LedgerService` import.** `WalletService` and `LedgerService` are
siblings over `LedgerService`. The existing `LedgerService.postCharge` is
deleted in 7.1; anything that called it now calls `WalletService`.

### 7.4 — DO allocation-aware hot path

The DO already has a singleton `meter_window` row (see
`apps/api/src/ingestion/entitlements/db/schema.ts`). A second SQLite
table just for allocation state is ceremony — one meter has exactly one
active reservation at a time. Add columns to the existing row instead:

```ts
// Columns added to meterWindowTable in this slice's DO migration:
//   reservation_id               text NULL      -- active reservation, null pre-funding
//   allocation_cents             integer NOT NULL DEFAULT 0
//   allocation_remaining_cents   integer NOT NULL DEFAULT 0
//   consumed_cents               integer NOT NULL DEFAULT 0
//   refill_threshold_bps         integer NOT NULL DEFAULT 2000
//   refill_chunk_cents           integer NOT NULL DEFAULT 0
//   refill_in_flight             integer NOT NULL DEFAULT 0  -- bool
//   refill_request_seq           integer NOT NULL DEFAULT 0
```

The `refill_request_seq` here is the canonical counter the refill RPC
uses as its idempotency key — there is no corresponding column in the
Postgres `entitlement_reservations` table (see slice 7.2).

`applyEventSync`'s `beforePersist` hook extension (runs after 6.7's
priced-fact computation; all fields live on the `meter_window` row):

```ts
if (window.allocationRemainingCents < pricedFact.amountCents) {
  throw new EntitlementWindowWalletEmptyError({
    eventId: event.id,
    reservationId: window.reservationId,
  })
}

// Local decrement (no ledger write).
window.allocationRemainingCents -= pricedFact.amountCents
window.consumedCents            += pricedFact.amountCents

// Refill trigger.
const threshold = Math.ceil(
  window.allocationCents * window.refillThresholdBps / 10000,
)
if (
  window.allocationRemainingCents < threshold &&
  !window.refillInFlight
) {
  window.refillInFlight   = true
  window.refillRequestSeq += 1
  ctx.waitUntil(this.requestRefill(window.refillRequestSeq))
}
```

`requestRefill` is an HTTP POST to `/internal/refill` on the worker that
hosts `WalletService`. Request body carries `{projectId, customerId,
currency, reservationId, requestSeq, requestedCents}`. Response carries
`{grantedCents}` or a denial reason. The worker handler opens a DB
transaction, takes `pg_advisory_xact_lock`, calls
`WalletService.refillReservation`, commits, returns.

Denial enum on the DO path: `LIMIT_EXCEEDED | SPEND_CAP_EXCEEDED |
WALLET_EMPTY`. `WALLET_EMPTY` is the Phase 7 addition; 6.7 reserved the
slot.

### 7.5 — Refill endpoint (no `CustomerFundingDO`)

File: `apps/api/src/routes/internal/refill.ts`.

```ts
app.post("/internal/refill", async (c) => {
  const body = await c.req.json<RefillRequest>()

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${body.customerId}`}))`
    )
    return walletService.refillReservation({ ...body, tx })
  })

  return c.json(result)
})
```

That's the refill path. Postgres serializes per-customer; pgledger's
account non-negativity catches over-draw; `unprice_ledger_idempotency`
catches duplicate request_seq. No new Durable Object. No new CF binding.

Top-up drain (called from `recharge` after a successful wallet credit):

```ts
// After a recharge commits, find reservations in WAITING_FOR_FUNDS state
// and send them a refill request. Same endpoint, same lock.
for (const resv of pendingReservations) {
  await fetch(`${env.API_URL}/internal/refill`, { ... })
}
```

The DO learns about the new funds on its next `apply()` (if in flight) or
on its next period boundary. No mid-flight push to the DO is required —
the DO's `refillInFlight` flag clears on RPC response, and the next
threshold breach drives the next refill naturally.

### 7.6 — Top-ups and promo grants (via adjustments)

**Top-ups** (provider webhook, depends on Phase 5):

```
provider webhook
  ↓
processWebhookEvent
  ↓
if event.type == "checkout.completed" && metadata.kind == "wallet_topup":
  WalletService.recharge({
    projectId, customerId, currency,
    amountCents: event.amount,
    externalRef: event.id,
    idempotencyKey: event.id,
  })
  ↓
one pgledger transfer:
  platform.{projectId}.adjustments → customer.{customerId}.available
  metadata: { flow: "recharge", source: "topup", external_ref: event.id }
  ↓
drain pending refills (HTTP loop to /internal/refill)
```

We are treating `platform.{projectId}.adjustments` as a **placeholder
for the payout boundary account** in Phase 7. Because we are BYO
provider (Stripe/Polar) and do not yet reconcile payouts against our
bank, the account will drift negative as money flows out to customers
— that is expected. Phase 8 introduces `platform.{projectId}.funding_clearing`
as the real escrow, and migrates existing top-up entries (matched by
`metadata.source = "topup"`) into the proper two-leg flow. Code
comments in `WalletService.recharge` must call this out.

Checkout initiation: new use case `initiateWalletTopUp` that calls the
provider's `createCheckoutSession` with `metadata = {kind:
"wallet_topup", customerId, currency}`.

**Promo grants** are `adjust(signedAmountCents: +N, actorId: "operator:<id>",
reason, source: "promo", expiresAt?)`. That produces:

```
platform.{projectId}.adjustments → customer.{customerId}.available
  metadata: { flow: "adjust", source: "promo", grant_id, expires_at, priority }
```

If `expiresAt` is set, the `adjust` call also enqueues a scheduled job
that, at `expiresAt`, reverses any unconsumed portion:

```
customer.{customerId}.available → platform.{projectId}.adjustments
  amount = MIN(original_grant_amount, current_available_balance)
  metadata: { flow: "adjust", source: "promo_expiry", grant_id, reverses: <original_transfer_id> }
```

"Unconsumed portion" is best-effort: if the customer has already spent
the grant, their current `customer.available` balance is below the grant
amount and the reversal takes only what's there. This mirrors the CoA's
strict-mode intent (no negative `available`). Precise "did this specific
dollar come from that specific grant" is unanswerable without per-grant
accounts — and per-grant accounts are explicitly out of scope.

**Grants as a read path:** when the UI or API wants to show "active
credits," query the ledger:

```sql
SELECT
  e.metadata->>'grant_id'                          AS grant_id,
  e.metadata->>'source'                            AS source,
  (e.metadata->>'expires_at')::timestamptz         AS expires_at,
  e.amount                                         AS issued_amount,
  e.created_at                                     AS issued_at
FROM pgledger_entries_view e
WHERE e.account_kind = 'customer_available'
  AND e.direction    = 'credit'
  AND e.metadata->>'flow'   = 'adjust'
  AND e.metadata->>'source' IN ('promo', 'purchased', 'plan_included', 'manual')
  AND e.metadata->>'grant_id' IS NOT NULL;
```

No `credit_grants` table required.

### 7.7 — Period-end reconciliation

Cron job `reconcile-reservations`, runs hourly:

```sql
SELECT * FROM entitlement_reservations
WHERE status = 'active'
  AND period_end_at < now();
```

For each:

1. Read `consumed_cents` from the meter DO via RPC. **DO SQLite is the
   source of truth for in-period consumption** — not the raw Tinybird
   fact stream, to avoid full recompute at capture time.
2. If the RPC fails or returns "state lost" (see recovery below), skip
   this reservation and retry next cron tick. Do not proceed with a
   guess. The DO's `periodEndAt` guard keeps new events out; the
   reservation stays `active` until we can read an authoritative number.
3. `WalletService.captureReservation({reservationId, allocationCents, actualCents: consumedCents, statementKey, idempotencyKey})`.
   - Posts `customer.reserved → customer.consumed : consumedCents` **and** `customer.reserved → customer.available : allocation − consumed` in one pgledger transaction.
   - Skips the second leg if `consumed == allocation`.
   - Idempotent on `idempotencyKey = capture:{reservationId}` — retries
     are safe via `unprice_ledger_idempotency`.
4. Update the reservation row: `status = 'reconciled'`, `reconciled_at = now()`, `consumed_cents = consumedCents`.
5. If `actualCents > allocationCents`, follow the overrun path from
   §Reservation sizing and overrun SLO (log, page, emit correction
   adjustment). Do not silently clamp.
6. If an invoice cycle closes at this same boundary, create the `invoices` header row (no lines — they project from the ledger; see 7.8). `total_cents` is set once here, from the sum of captured amounts for that statement key, and is never recomputed afterward.

Tight SLO is not required: the DO stops accepting events for the closed
period via its existing `periodEndAt` guard. Reconciliation latency of
up to an hour is fine.

**DO state recovery path.** DO SQLite survives eviction, but not
catastrophic storage loss (new DO instance, empty SQLite). If a DO
comes up empty and receives a new event, it will happily start from
`usage = 0` — which would lose in-period consumption history. Two
defenses:

- On DO init, after `migrate()`, check whether the `meter_window` row
  is missing AND the period is still open AND the streamId has facts
  in Tinybird for the current period. If so, mark the window
  `recovery_required = true` and reject new `apply()` calls with
  `RECOVERY_REQUIRED` until the `resyncFromFacts()` RPC completes.
- `DO.resyncFromFacts(streamId, periodKey)`: queries Tinybird
  `meter_fact` aggregated by `(stream_id, period_key)`, sums
  `value_after` / `amount` to rebuild `usage` and `consumed_cents`,
  writes the row, clears the flag. Called by the reconcile cron
  *before* calling the DO's consumed-cents RPC, on-demand, whenever
  `RECOVERY_REQUIRED` is returned.

This keeps Tinybird as a **fallback source of truth**, not the primary
— the primary stays the DO so capture is a cheap read. Recovery is
best-effort: if Tinybird has also lost data for the period, the
operator resolves manually (single `adjust` transfer with
`source: "manual"` and a runbook pointer).

### 7.8 — Invoice schema cleanup

Intent: ledger is the single source of truth for invoice lines. The
`invoice_items` cache has been an accuracy hazard — delete it.

Migrations already in 7.1 drop the tables. This slice adds the projection
view and rewires the read path:

```sql
CREATE OR REPLACE VIEW invoice_lines_v1 AS
SELECT
  e.project_id,
  e.metadata->>'statement_key'              AS statement_key,
  e.id                                       AS entry_id,
  (e.metadata->>'billing_period_id')         AS billing_period_id,
  (e.metadata->>'subscription_item_id')      AS subscription_item_id,
  (e.metadata->>'feature_plan_version_id')   AS feature_plan_version_id,
  (e.metadata->>'invoice_item_kind')         AS kind,      -- 'usage' | 'subscription' | 'adjustment'
  (e.metadata->>'description')               AS description,
  (e.metadata->>'quantity')::numeric         AS quantity,
  (e.metadata->>'unit_amount_snapshot')->>'amount' AS unit_amount,
  e.amount                                   AS amount_total,
  (e.metadata->>'proration_factor')::numeric AS proration_factor,
  (e.metadata->>'cycle_start_at')::bigint    AS cycle_start_at,
  (e.metadata->>'cycle_end_at')::bigint      AS cycle_end_at,
  e.transfer_id                              AS ledger_transfer_id,
  e.created_at
FROM pgledger_entries_view e
WHERE e.metadata ? 'statement_key'
  AND (e.metadata->>'invoice_item_kind') IS NOT NULL
  AND e.direction   = 'credit'
  AND e.account_kind IN ('customer_consumed');
```

Note: the view filters on `customer_consumed` rather than the old
`customer_receivable + house_revenue_sink` pair, because usage is now
recognized to `customer.{customerId}.consumed` (CoA), not to a house
revenue account. For Phase 7 (prepaid only), every invoice line is a
consumed-credit entry. Phase 8 extends the view when
`customer.receivable` becomes a normal flow.

**Projection contract (ledger discipline the view depends on).** A
transfer is an invoice line iff it credits `customer.{cid}.consumed`
AND carries both `metadata.statement_key` and `metadata.invoice_item_kind`.
Any transfer that credits `customer.consumed` WITHOUT these fields is
a projection bug and will be silently dropped from the invoice. Two
enforcement points:

1. **`WalletService.captureReservation` and `chargeSubscriptionFee` are
   the ONLY two Phase 7 paths that credit `customer.consumed`.** Both
   set `statement_key` and `invoice_item_kind` unconditionally (`"usage"`
   and `"subscription"` respectively). If you add a third path that
   writes to `customer.consumed` without both fields, the projection
   is wrong and `invoices.total_cents` will not reconcile.
2. **Test guard** (slice 7.10, enforced as a nightly SQL): every row
   in `pgledger_entries_view` with `account_kind='customer_consumed'`
   and `direction='credit'` MUST have non-null `statement_key` AND
   non-null `invoice_item_kind`. Emit `invoice_projection_orphan`
   metric; page on non-zero. Non-revenue reclassifications in future
   phases MUST go via a non-`customer.consumed` path OR MUST carry
   `invoice_item_kind = "internal_reclass"` with an explicit filter
   exclusion in the view.

Read path: `DrizzleBillingRepository.findInvoiceLinesByStatementKey(
projectId, statementKey)`. Provider adapter (`stripe-invoice-projector`)
maps view rows to provider line items. UI reads the view directly.

Completion check:

```
rg "invoice_items|invoiceItemsTable|InvoiceItem" internal/ apps/
# → empty (or only deleted validator/test-fixture names)

rg "invoice_credit_applications" internal/ apps/
# → empty
```

Verification query (safety net before deploy):

```sql
-- Every existing invoice's total_cents must match the view sum.
SELECT i.id, i.statement_key, i.total_cents,
       COALESCE((SELECT SUM(amount_total) FROM invoice_lines_v1 v
                 WHERE v.statement_key = i.statement_key), 0) AS view_sum
FROM invoices i
WHERE i.total_cents <> (
  SELECT COALESCE(SUM(amount_total), 0)
  FROM invoice_lines_v1 v
  WHERE v.statement_key = i.statement_key
);
```

Expected: zero rows for invoices issued post-7.1. Pre-7.1 invoices may
mismatch because their lines were in the deleted `invoice_items` table —
mark those `migrated_manually = true` or reconstruct.

### 7.9 — API endpoints

- `GET  /v1/wallet` — returns balances from the gateway:
  `{available, reserved, consumed}` for the customer's currency.
  (`receivable` returns once Phase 8 seeds the account.)
  No `wallets` table to query; the account keys are derivable.
- `POST /v1/wallet/top-up` — returns provider checkout URL (calls `initiateWalletTopUp`).
- `GET  /v1/wallet/reservations` — active reservations across entitlements, with live `consumed_cents` from the meter DO via RPC.
- `GET  /v1/invoices/:id/lines` — projection over `invoice_lines_v1` for the invoice's `statement_key`. Replaces the old endpoint that read from `invoice_items`.

Deferred to "when UI needs them" (the SQL is trivial, but a public
endpoint is support surface):

- `GET /v1/wallet/grants` — projection by metadata; add when the UI
  renders grants as a first-class list.
- `POST /v1/admin/adjustments` — wire through the existing admin tRPC
  path until there's a real external operator consumer.

SDK types updated: `InvoiceItem` → `InvoiceLine` from the projection.

### 7.10 — Tests

**Unit (WalletService):**

- `recharge` — one transfer `platform.{projectId}.adjustments → customer.{customerId}.available` with `metadata.source = "topup"`; idempotent on key.
- `createReservation` — available→reserved; partial if `available < requested`; inserts reservation row.
- `refillReservation` — advisory lock serializes concurrent calls; `(reservation_id, request_seq)` is idempotent; partial fulfilment on short balance.
- `captureReservation` — atomic `reserved → consumed` + `reserved → available`; skips second leg when `consumed == allocation`.
- `captureReservation({ actualCents: 0 })` — full return to available (the "release" case).
- `adjust` (positive, no expiry) — `platform.adjustments → customer.available`.
- `adjust` (positive, with `expiresAt`) — scheduled job enqueued; at expiry, reverse-adjust fires and caps at current `available`.
- `chargeSubscriptionFee` — single `available → consumed` transfer with `metadata.invoice_item_kind = "subscription"`; invoice header-only side effect.

**Integration (DO, post-6.7 + 7.4):**

- `apply()` decrements `allocation_remaining` and increments `consumed_cents` per priced fact.
- Below threshold → exactly one refill request; `refillInFlight` prevents duplicates.
- Wallet-empty denial: new events return `WALLET_EMPTY`; earlier in-flight events succeed.
- **Zero ledger writes per event:** 10k events into one DO produce zero new rows in `pgledger_entries_view` between reservation creation and reconciliation. Regression guard for 7.4 against 6.7's invariant.

**E2E:**

- Recharge (webhook) → wallet credited → pending reservation refills drain → DO allocation grows.
- Period end → reconciliation cron → `consumed_cents` → `customer.consumed`; unused → `customer.available`; next-period reservation starts fresh.
- Promo grant with expiry → issued (adjustment); partially consumed; at expiry, remainder reverses.
- Invoice projection: `invoice_lines_v1` sum matches `invoices.total_cents` across a week of invoices.

**Invariant 1 of CoA (nightly job — slice 7.11 below):**

```
available + reserved + consumed
  == Σ recharges + Σ positive_adjustments − Σ negative_adjustments
```

(`receivable` and `external_refunds` terms rejoin this identity in
Phase 8 alongside the accounts they reference.) Run as one aggregate
query across all customers; per-customer breakdown is the drill-down
step for when the aggregate alert fires. Emit metric; page on mismatch.
This is the canary.

### 7.11 — Reconciliation cron: wallet identity

Nightly job under `internal/jobs/`. **Run the invariant as a single
aggregate SQL** — one query summing the whole ledger — and alert on any
non-zero delta. Per-customer-row iteration is ceremony when the drift
rate at steady state is zero; reserve it for the breakdown step that
only fires when the aggregate alert fires.

```sql
-- Expected: 0. Any non-zero row is a pageable drift.
WITH lhs AS (
  SELECT SUM(CASE account_kind
    WHEN 'customer_available' THEN balance
    WHEN 'customer_reserved'  THEN balance
    WHEN 'customer_consumed'  THEN balance
    ELSE 0 END) AS total
  FROM pgledger_accounts_view
  WHERE account_kind IN ('customer_available','customer_reserved','customer_consumed')
),
rhs AS (
  SELECT SUM(signed_amount) AS total
  FROM pgledger_entries_view
  WHERE metadata->>'flow' IN ('recharge','adjust')
)
SELECT (SELECT total FROM lhs) - (SELECT total FROM rhs) AS drift;
```

(`customer.receivable` enters this identity in Phase 8 when postpaid
lands.) Emits `wallet_identity_drift` metric; page on any non-zero.
Per-customer breakdown is a follow-up query the on-call runs when the
alert fires — not something the cron pays for every night.

## Risks

**Refill latency under burst.** A 10k-rps meter with a 20%-remaining
threshold can exhaust its runway before the refill round-trips.
Mitigation: per-meter `refill_threshold_bps` config. Hot meters use 50%+
(refill early) with larger chunks.

**Refill races at wallet-empty boundary.** Two concurrent refill
requests from different meter DOs on the same customer both see "wallet
has $5." The advisory lock serializes them. Second request reads updated
balance, partial-fills.

**DO eviction loses `refillInFlight` flag.** The flag is in SQLite, not
memory. Survives eviction. If a DO evicts mid-RPC and the refill
completes in pgledger, the next `apply()` triggers a lightweight sync
call (`WalletService.syncReservation(reservationId)`) that re-reads
`allocation_remaining` and clears the flag.

**Promo-grant expiry races consumption.** A grant's expiry job fires at
`expiresAt`, reads current `customer.available`, and reverses
`MIN(grant_amount, available)`. If the customer has already consumed the
grant, the reversal takes 0. No negative balance possible.

**Operator changes margin / refill chunk mid-period.** Active
reservations carry a snapshot of `refill_chunk_cents` and
`refill_threshold_bps`. Changes take effect on the next reservation (next
period), not retroactively. Customer-facing math stays consistent within
a period.

**`platform.{projectId}.adjustments` drifts.** Because Phase 7 has no
payout reconciliation, the account just accumulates (topups push it
negative, captures and consumption don't touch it, promos pull it
further negative). This is **expected and acceptable** for Phase 7 —
the account is a placeholder for the payout boundary. The Phase 8
funding_clearing work will migrate topup entries out of it. The
identity check in 7.11 excludes this account's absolute balance from
its assertion (the LHS sums only customer-side balances).

**Subscription-flat-fee charge path differs from legacy.** Legacy
posted `customer → house:revenue` in one transfer. New path is
`customer.available → customer.consumed` in one transfer. Same number
of ledger rows, no reservation step (the amount is known in advance).
Invoice projection works off `customer.consumed` for both usage and
subscription lines, differentiated by `metadata.invoice_item_kind`.

## Rollout

Single rollout, no feature flag. Phase 6.7 must have landed cleanly
(including 6.7.10 green). Because 6.7 already left the DO with no
per-event ledger path, there is **no double-write window, no queue
drain, and no deletion cutover** during Phase 7 — it is additive on the
hot path plus a one-time migration elsewhere.

Deploy order:

1. Migration: 7.1 (rename, teardown, seeding) + 7.2 (`entitlement_reservations`).
2. Deploy `WalletService` and the `/internal/refill` route (7.3, 7.5).
3. Deploy DO with allocation-aware `apply` (7.4). Hot path stays ledger-free.
4. Activation workflow gains a `createReservation` step (existing provisioning code calls it after entitlement activation).
5. Period-end reconciliation cron (7.7).
6. Webhook wiring for top-ups (7.6).
7. Nightly identity check (7.11).
8. API / SDK updates (7.9) — can ship in parallel with the above once the underlying service lands.

No back-fill needed: reservations start fresh post-deploy; 6.7-era agent
consumption is non-billable by design (`Phase 6.7 → Phase 7` gap).
Pre-6.7 invoices with `invoice_items` rows are already ledger-backed
(Phase 6.6 posts tagged with `statement_key`); 7.8's view substitution is
a drop-in for those, and 7.8's verification query catches mismatches
before the tables drop.

## Related

- [`../pgledger-ai-wallet-coa.md`](../pgledger-ai-wallet-coa.md) — the chart of accounts this phase implements. Update its §7.2 in this same PR (dot form supersedes colon form).
- [Phase 6.6 — pgledger gateway](./unprice-phase-06.6-new-ledger.md)
- [Phase 6.7 — agent billing simplification](./unprice-phase-06.7-agent-billing-simplification.md)
- [Phase 8 — financial guardrails & postpaid](./unprice-phase-08-financial-guardrails.md) — adds postpaid (via `platform.adjustments`-seeded allowance + `customer.receivable`), cross-meter spend caps, and circuit breakers.
