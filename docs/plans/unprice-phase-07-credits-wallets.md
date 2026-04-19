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
"wallet" is not a Drizzle table — it is the `customer.{projectId}.{customerId}.available.{currency}`
account in pgledger. A reservation is a pre-funded chunk of that balance
moved into `customer.{id}.reserved` so the DO can consume against it
locally without phoning home per event. At period end, the consumed
portion is captured to `customer.{id}.consumed` and any unused portion
returned to `available`.

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
- All five `platform.{projectId}.*.{currency}` accounts seeded per project/currency:
  `funding_clearing`, `refund_clearing`, `writeoff`, `adjustments`, `revenue` (revenue optional, see §Guardrails).
- Four `customer.{projectId}.{customerId}.*.{currency}` accounts created lazily on first customer event: `available`, `reserved`, `consumed`, `receivable`.
- `WalletService` exposes the narrow primitive set from CoA §7.6.
- `EntitlementWindowDO` gains `allocation_cents`, `allocation_remaining_cents`, `consumed_cents` in SQLite. Hot path denies `LIMIT_EXCEEDED | SPEND_CAP_EXCEEDED | WALLET_EMPTY`.
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
customer.{id}.available → customer.{id}.reserved : R
  metadata: { flow: "reserve", reservation_id, entitlement_id, idempotency_key }
```

If `customer.{id}.available < R`, create at whatever is available; the DO
denies `WALLET_EMPTY` once that chunk is consumed. Reservation row records
`allocation_cents` = what was actually moved.

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
    customer.{id}.available → customer.{id}.reserved : refill_chunk
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
customer.{id}.reserved → customer.{id}.consumed : consumed_cents      # recognize usage
customer.{id}.reserved → customer.{id}.available : allocation - consumed  # refund unused
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
                   │  WalletService (narrow primitives)   │
                   │  recharge / transferAvailableToReserved /
                   │  captureReservation / releaseReservation /
                   │  adjust / settleReceivable / writeOffReceivable │
                   └──────────┬───────────────────────────┘
                              │ LedgerService.createTransfers
                              ▼
                   ┌──────────────────────────────────────┐
                   │  pgledger (CoA §1)                   │
                   │  customer.{pid}.{cid}.available.{cur}│
                   │  customer.{pid}.{cid}.reserved.{cur} │
                   │  customer.{pid}.{cid}.consumed.{cur} │
                   │  customer.{pid}.{cid}.receivable.{cur}│
                   │  platform.{pid}.funding_clearing.{cur}│
                   │  platform.{pid}.refund_clearing.{cur} │
                   │  platform.{pid}.adjustments.{cur}    │
                   │  platform.{pid}.writeoff.{cur}       │
                   └──────────────────────────────────────┘
```

No per-event ledger write anywhere. No second DO. No grants subsystem.

## Guardrails

- The CoA is law. Account names use the dot form (`platform.funding_clearing`, `customer.{pid}.{cid}.available.{cur}`). The colon form from repo legacy is **renamed** in slice 7.1, not kept in parallel.
- Strict reservation only. No soft-overage paths. Capture clamps at `reserved`; any `A > R` is an upstream bug, not a ledger event. Operators size reservations with a safety margin at the use-case layer.
- `customer.receivable` exists in the chart of accounts but no normal flow writes to it. Only operator-initiated entry, settlement, or write-off touches it.
- **Zero ledger writes per priced event.** Phase 6.7 guarantees this; 7.4's allocation path must not regress it.
- No cached `balance_cents` / `remaining_cents` columns anywhere outside the DO's own SQLite. Balance reads go through `LedgerService.getAccountBalance`.
- No `wallets` Drizzle table. No `credit_grants` Drizzle table. No `credit_burn_rates` Drizzle table. Grants are `platform.adjustments → customer.available` transfers with metadata; their "balance" is the sum of those transfers. Burn-rate tuning is a safety margin knob on the entitlement, not a versioned table.
- `platform.revenue` is **optional**. Revenue per customer is `customer.{id}.consumed` balance; platform-wide revenue is `Σ customer.*.consumed` via SQL. Seed `platform.revenue` only if the operator asks for a single-row total.
- `WalletService` does not depend on `LedgerService`. Both sit on `LedgerService`.
- No `CustomerFundingDO`. Refill serialization is `pg_advisory_xact_lock(hashtext(customer_id))` inside the refill transaction.
- No postpaid path in Phase 7. Postpaid (`platform.adjustments`-seeded allowance + `customer.receivable` on shortfall) is Phase 8.

## Non-goals

- **Postpaid / invoice-collected plans.** Deferred to Phase 8. All Phase 7 customers are prepaid-wallet-funded. The CoA has the seams (`platform.adjustments`, `customer.receivable`) — Phase 8 wires them.
- **Grants as a subsystem.** Grants are `platform.adjustments → customer.available` transfers with `{source: "promo" | "purchased" | "plan_included" | "manual", grant_id, expires_at?, priority?}` in metadata. Expiry is a scheduled reverse adjustment. There is no `credit_grants` Drizzle table, no `credit_burn_rates` table, no `GrantsManager` class, no `/v1/wallet/grants` endpoint backed by a table.
- **Burn-rate multipliers.** If AI costs shift, adjust the reservation-sizing margin on the entitlement (one config field). Do not build a scope/effective_at/superseded_at versioned table for a knob a use case can own.
- **ML-based refill chunk sizing.** Static per-meter config. Iterate from data later.
- **Cross-currency wallets.** One ledger per currency; `platform.*` accounts duplicated per currency. Cross-currency requires FX accounts and is future work.
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
  - `postRefund` → deleted. Callers switch to `WalletService.refundToWallet` or `refundExternal`.
- `internal/services/src/billing/service.ts`:
  - Any code reading grant balance from the legacy `credit_grants` table → deleted. Grant balance is `Σ platform.adjustments → customer.available` transfers where metadata.source matches.
- `internal/services/src/subscriptions/invokes.ts` (the `invoiceSubscription` flow):
  - `projectedInvoiceItems` construction + `txBillingRepo.createInvoiceItemsBatch` → deleted (slice 7.8).
  - `LedgerService.postCharge` loop → replaced with `WalletService.chargeSubscriptionFee` (a one-transaction `available → reserved → consumed` for flat periodic fees; see slice 7.3).
- `internal/db/src/schema/invoices.ts`:
  - `invoiceItems`, `invoiceCreditApplications`, `creditGrants` table defs and their relations → deleted.
  - `invoices.amountCreditUsed`, `invoices.subtotalCents`, `invoices.paymentAttempts` → dropped (derive from ledger / provider webhooks on demand).
  - `invoices.totalCents` → renamed `totalCentsFrozen`, set once at finalization.
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
table, and the five `platform.*` + four `customer.*` account key
builders in place.

Migration (single Drizzle migration):

```sql
-- Drop legacy tables (pre-production cleanup; no data preserved).
DROP TABLE IF EXISTS invoice_items            CASCADE;
DROP TABLE IF EXISTS invoice_credit_applications CASCADE;
DROP TABLE IF EXISTS credit_grants            CASCADE;

-- Slim invoices to a header + collection state.
ALTER TABLE invoices DROP COLUMN IF EXISTS amount_credit_used;
ALTER TABLE invoices DROP COLUMN IF EXISTS subtotal_cents;
ALTER TABLE invoices DROP COLUMN IF EXISTS payment_attempts;
ALTER TABLE invoices RENAME COLUMN total_cents TO total_cents_frozen;

-- Deactivate legacy pgledger accounts from Phase 6.6:
--   house:revenue:*, house:credit_issuance:*, house:expired_credits:*, house:refunds:*
-- and any single-account customer:<id>:<currency> accounts. Use the
-- deactivation function exposed by pgledger; do not physically delete.
-- New account keys are created on first use.
```

Code (`internal/services/src/ledger/accounts.ts`):

```ts
export const platformAccountKey = (
  kind: "funding_clearing" | "refund_clearing" | "writeoff" | "adjustments" | "revenue",
  projectId: string,
  currency: CurrencyCode,
): string => `platform.${projectId}.${kind}.${currency}`

export const customerAccountKeys = (
  projectId: string,
  customerId: string,
  currency: CurrencyCode,
): {
  available: string
  reserved: string
  consumed: string
  receivable: string
} => ({
  available:  `customer.${projectId}.${customerId}.available.${currency}`,
  reserved:   `customer.${projectId}.${customerId}.reserved.${currency}`,
  consumed:   `customer.${projectId}.${customerId}.consumed.${currency}`,
  receivable: `customer.${projectId}.${customerId}.receivable.${currency}`,
})
```

Normal balance (set at creation in the gateway; pgledger does not permit changing it later):

- Credit-normal: `customer.available`, `customer.reserved`, `customer.consumed`, `platform.refund_clearing`, `platform.adjustments`, `platform.revenue` (if seeded).
- Debit-normal: `customer.receivable`, `platform.funding_clearing`, `platform.writeoff`.

Non-negativity enforced on: `customer.available`, `customer.reserved`,
`customer.consumed`, `customer.receivable`. At the pgledger account
level if the version supports it; otherwise at the service layer inside
the same transaction as the transfer, guarded by the advisory lock.

Seeding:

- `LedgerService.seedPlatformAccounts(projectId, currency)` creates the five `platform.*` accounts. Called on project creation; idempotent.
- `LedgerService.ensureCustomerAccounts(projectId, customerId, currency)` creates the four `customer.*` accounts in one pgledger transaction. Called lazily on first customer-touching operation.

Completion check:

```
rg "house:|house\\." internal/ apps/                  # → empty
rg "grantAccountKey|grant:" internal/services/        # → empty
rg "credit_grants|invoiceItems|invoiceCreditApplications" internal/db/  # → empty
```

### 7.2 — `entitlement_reservations` schema

One table. That's all the Drizzle this phase adds.

```sql
CREATE TYPE funding_strategy AS ENUM ('prepaid'); -- 'postpaid' added in Phase 8
CREATE TYPE reservation_status AS ENUM ('active', 'exhausted', 'reconciled');

CREATE TABLE entitlement_reservations (
  id                      text PRIMARY KEY,
  project_id              text NOT NULL,
  customer_id             text NOT NULL,
  entitlement_id          text NOT NULL,
  currency                text NOT NULL,
  funding_strategy        funding_strategy NOT NULL DEFAULT 'prepaid',
  allocation_cents        bigint NOT NULL,  -- total ever moved into reserved for this reservation
  consumed_cents          bigint NOT NULL DEFAULT 0,  -- authoritative; DO syncs via cron
  status                  reservation_status NOT NULL DEFAULT 'active',
  refill_threshold_bps    integer NOT NULL DEFAULT 2000,
  refill_chunk_cents      bigint NOT NULL,
  refill_request_seq      integer NOT NULL DEFAULT 0,  -- monotonic; idempotency key for refills
  period_start_at         timestamptz NOT NULL,
  period_end_at           timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  reconciled_at           timestamptz,
  UNIQUE (entitlement_id, period_start_at)
);
```

Why no `reservation_refills` table: each refill is a pgledger transfer
with `metadata.reservation_id` and `metadata.request_seq`. Idempotency
is handled by `unprice_ledger_idempotency`. History queries are SQL over
`pgledger_entries_view` filtered by metadata — same pattern as invoice
lines.

### 7.3 — `WalletService` primitives

File: `internal/services/src/wallet/service.ts`.

Narrow surface, exactly what the CoA §7.6 mandates. Every method wraps
its transfers in one pgledger transaction and inserts one
`unprice_ledger_idempotency` row.

```ts
export type WalletDeps = {
  services: Pick<ServiceContext, "ledgerGateway">
  db: Database
  logger: AppLogger
}

export class WalletService {
  constructor(private deps: WalletDeps) {}

  // 3.1 — external funds enter the wallet (after Stripe/ACH settlement)
  recharge(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    amountCents: number; idempotencyKey: string
  }): Promise<Result<void, WalletError>>

  // 3.2 — earmark funds for a new reservation (used by createReservation below)
  transferAvailableToReserved(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    amountCents: number; reservationId: string; idempotencyKey: string
  }): Promise<Result<void, WalletError>>

  // 3.3 / 3.4 — capture at period end. Atomic: reserved → consumed (actual)
  //              and reserved → available (allocation − actual).
  captureReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    reservationId: string; allocationCents: number; actualCents: number
    statementKey: string; idempotencyKey: string
  }): Promise<Result<void, WalletError>>

  // 3.4 — release full reservation (TTL expiry, user cancel, A == 0)
  releaseReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    reservationId: string; amountCents: number; idempotencyKey: string
  }): Promise<Result<void, WalletError>>

  // 3.7 — refund a previously-consumed amount, back to wallet or externally
  refundToWallet(input:   { /* … amountCents, idempotencyKey */ }): Promise<Result<void, WalletError>>
  refundExternal(input:   { /* … amountCents, idempotencyKey */ }): Promise<Result<void, WalletError>>

  // 3.9 — operator adjustment (signed). Positive = promo/goodwill; negative = correction.
  adjust(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    signedAmountCents: number; actorId: string; reason: string
    idempotencyKey: string
    expiresAt?: Date  // if set, a scheduled reverse-adjust is queued
  }): Promise<Result<void, WalletError>>

  // 3.10 — operator-only (rare). Out of normal flow per CoA §6.
  settleReceivable(input:   { /* … amountCents, externalRef, idempotencyKey */ }): Promise<Result<void, WalletError>>
  writeOffReceivable(input: { /* … amountCents, reason, idempotencyKey */ }):      Promise<Result<void, WalletError>>

  // Composite: open a reservation (insert row + transferAvailableToReserved).
  createReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    entitlementId: string; requestedCents: number
    refillThresholdBps: number; refillChunkCents: number
    periodStartAt: Date; periodEndAt: Date
    idempotencyKey: string
  }): Promise<Result<{ reservationId: string; allocationCents: number }, WalletError>>

  // Composite: atomic `available → reserved : refill_chunk` under advisory lock.
  // Partial fulfilment when available < requested. Idempotent on (reservationId, requestSeq).
  refillReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    reservationId: string; requestSeq: number; requestedCents: number
  }): Promise<Result<{ grantedCents: number }, WalletError>>

  // Composite: flat subscription fee. Open reservation for R, immediately capture.
  // One pgledger transaction: available → reserved → consumed (two transfers).
  // Used by invoiceSubscription for recurring flat fees (replaces postCharge).
  chargeSubscriptionFee(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    amountCents: number; statementKey: string; billingPeriodId: string
    idempotencyKey: string
  }): Promise<Result<void, WalletError>>
}
```

Serialization: every `refillReservation`, `createReservation`,
`transferAvailableToReserved`, and `chargeSubscriptionFee` call opens its
transaction with:

```sql
SELECT pg_advisory_xact_lock(hashtext('customer:' || :customer_id));
```

This serializes balance-changing operations per customer across the app,
without a DO. Lock scope is the transaction — released on commit/rollback.

**No `LedgerService` import.** `WalletService` and `LedgerService` are
siblings over `LedgerService`. The existing `LedgerService.postCharge` is
deleted in 7.1; anything that called it now calls `WalletService`.

### 7.4 — DO allocation-aware hot path

Extend `EntitlementWindowDO` SQLite schema:

```ts
export const allocationStateTable = sqliteTable("allocation_state", {
  reservationId:         text("reservation_id").primaryKey(),
  allocationCents:       integer("allocation_cents").notNull(),
  allocationRemaining:   integer("allocation_remaining_cents").notNull(),
  refillThresholdBps:    integer("refill_threshold_bps").notNull(),
  refillChunkCents:      integer("refill_chunk_cents").notNull(),
  refillInFlight:        integer("refill_in_flight", { mode: "boolean" }).notNull().default(false),
  refillRequestSeq:      integer("refill_request_seq").notNull().default(0),
  consumedCents:         integer("consumed_cents").notNull().default(0),
})
```

`applyEventSync`'s `beforePersist` hook extension (runs after 6.7's
priced-fact computation):

```ts
if (allocationState.allocationRemaining < pricedFact.amountCents) {
  throw new EntitlementWindowWalletEmptyError({
    eventId: event.id,
    reservationId: allocationState.reservationId,
  })
}

// Local decrement (no ledger write).
allocationState.allocationRemaining -= pricedFact.amountCents
allocationState.consumedCents        += pricedFact.amountCents

// Refill trigger.
const threshold = Math.ceil(
  allocationState.allocationCents * allocationState.refillThresholdBps / 10000,
)
if (
  allocationState.allocationRemaining < threshold &&
  !allocationState.refillInFlight
) {
  allocationState.refillInFlight = true
  allocationState.refillRequestSeq += 1
  ctx.waitUntil(this.requestRefill(allocationState.refillRequestSeq))
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
    idempotencyKey: event.id,
  })
  ↓
one pgledger transfer:
  platform.{pid}.funding_clearing.{cur} → customer.{pid}.{cid}.available.{cur}
  ↓
drain pending refills (HTTP loop to /internal/refill)
```

Checkout initiation: new use case `initiateWalletTopUp` that calls the
provider's `createCheckoutSession` with `metadata = {kind:
"wallet_topup", customerId, currency}`.

**Promo grants** are `adjust(signedAmountCents: +N, actorId: "operator:<id>",
reason, expiresAt?)`. That produces:

```
platform.{pid}.adjustments.{cur} → customer.{pid}.{cid}.available.{cur}
  metadata: { flow: "adjust", source: "promo", grant_id, expires_at, priority }
```

If `expiresAt` is set, the `adjust` call also enqueues a scheduled job
that, at `expiresAt`, reverses any unconsumed portion:

```
customer.{pid}.{cid}.available.{cur} → platform.{pid}.adjustments.{cur}
  amount = MIN(original_grant_amount, current_available_balance)
  metadata: { flow: "adjust", source: "promo_expiry", grant_id }
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

1. Read `consumed_cents` from the meter DO via RPC (DO is authoritative for consumption within the period).
2. `WalletService.captureReservation({reservationId, allocationCents, actualCents: consumedCents, statementKey, idempotencyKey})`.
   - Posts `customer.reserved → customer.consumed : consumedCents` **and** `customer.reserved → customer.available : allocation − consumed` in one pgledger transaction.
   - Skips the second leg if `consumed == allocation`.
3. Update the reservation row: `status = 'reconciled'`, `reconciled_at = now()`, `consumed_cents = consumedCents`.
4. If an invoice cycle closes at this same boundary, create the `invoices` header row (no lines — they project from the ledger; see 7.8). `total_cents_frozen` = sum of captured amounts for that statement key.

Tight SLO is not required: the DO stops accepting events for the closed
period via its existing `periodEndAt` guard. Reconciliation latency of up
to an hour is fine.

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
recognized to `customer.{id}.consumed` (CoA), not to a house revenue
account. For Phase 7 (prepaid only), every invoice line is a
consumed-credit entry. Phase 8 extends the view when `customer.receivable`
becomes a normal flow.

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
-- Every existing invoice's total_cents_frozen must match the view sum.
SELECT i.id, i.statement_key, i.total_cents_frozen,
       COALESCE((SELECT SUM(amount_total) FROM invoice_lines_v1 v
                 WHERE v.statement_key = i.statement_key), 0) AS view_sum
FROM invoices i
WHERE i.total_cents_frozen <> (
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
  `{available, reserved, consumed, receivable}` for the customer's currency.
  No `wallets` table to query; the account keys are derivable.
- `POST /v1/wallet/top-up` — returns provider checkout URL (calls `initiateWalletTopUp`).
- `GET  /v1/wallet/reservations` — active reservations across entitlements, with live `consumed_cents` from the meter DO via RPC.
- `GET  /v1/wallet/grants` — projection over `pgledger_entries_view` by metadata (SQL in slice 7.6).
- `GET  /v1/invoices/:id/lines` — projection over `invoice_lines_v1` for the invoice's `statement_key`. Replaces the old endpoint that read from `invoice_items`.
- `POST /v1/admin/adjustments` (operator) — issues a promo or correction via `WalletService.adjust`. Grants are adjustments; there is no separate `/admin/grants` endpoint.

SDK types updated: `InvoiceItem` → `InvoiceLine` from the projection.
`Grant` → a view-row type over the metadata-keyed query.

### 7.10 — Tests

**Unit (WalletService):**

- `recharge` — one transfer `platform.funding_clearing → customer.available`; idempotent on key.
- `createReservation` — available→reserved; partial if `available < requested`; inserts reservation row.
- `refillReservation` — advisory lock serializes concurrent calls; `(reservation_id, request_seq)` is idempotent; partial fulfilment on short balance.
- `captureReservation` — atomic `reserved → consumed` + `reserved → available`; skips second leg when `consumed == allocation`.
- `releaseReservation` — full return to available.
- `adjust` (positive, no expiry) — `platform.adjustments → customer.available`.
- `adjust` (positive, with `expiresAt`) — scheduled job enqueued; at expiry, reverse-adjust fires and caps at current `available`.
- `chargeSubscriptionFee` — `available → reserved → consumed` in one transaction; invoice header-only side effect.

**Integration (DO, post-6.7 + 7.4):**

- `apply()` decrements `allocation_remaining` and increments `consumed_cents` per priced fact.
- Below threshold → exactly one refill request; `refillInFlight` prevents duplicates.
- Wallet-empty denial: new events return `WALLET_EMPTY`; earlier in-flight events succeed.
- **Zero ledger writes per event:** 10k events into one DO produce zero new rows in `pgledger_entries_view` between reservation creation and reconciliation. Regression guard for 7.4 against 6.7's invariant.

**E2E:**

- Recharge (webhook) → wallet credited → pending reservation refills drain → DO allocation grows.
- Period end → reconciliation cron → `consumed_cents` → `customer.consumed`; unused → `customer.available`; next-period reservation starts fresh.
- Promo grant with expiry → issued (adjustment); partially consumed; at expiry, remainder reverses.
- Invoice projection: `invoice_lines_v1` sum matches `invoices.total_cents_frozen` across a week of invoices.

**Invariant 1 of CoA (nightly job — slice 7.11 below):**

```
available + reserved + consumed − receivable
  == Σ recharges + Σ positive_adjustments − Σ negative_adjustments − Σ external_refunds
```

per customer. Emit metric; page on mismatch. This is the canary.

### 7.11 — Reconciliation cron: wallet identity

Nightly job under `internal/jobs/` that runs CoA invariant 1 (see tests
above) for every active customer. Emits `wallet_identity_drift` metric;
pages on any non-zero delta. This is the single integrity check that
tells you the ledger is still correct.

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

**`platform.funding_clearing` grows.** Per CoA §4 invariant 8, it must
clear to 0 per deposit once reconciled. The nightly identity job (7.11)
surfaces persistent balances as open reconciliation items.

**Subscription-flat-fee charge path differs from legacy.** Legacy posted
`customer → house:revenue` in one transfer. New path is `available →
reserved → consumed` in one transaction (two transfers). Accounting
equivalent; invoice projection works off `customer.consumed` for both
usage and subscription lines (differentiated by
`metadata.invoice_item_kind`).

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
