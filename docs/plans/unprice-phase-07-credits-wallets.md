# Phase 7: Wallets, Reservations & Credit Lifecycle

PR title: `feat: wallets and reservations on pgledger`
Branch: `feat/wallets-reservations`
Prerequisite: Phase 6.6 (pgledger gateway) and Phase 6.7 (agent billing
simplification) both green.

> Phase 8 (refund-to-card, proportional refund attribution, cross-meter
> spend caps, postpaid postpaid invoicing on credit) is deferred. **Phase
> 7 supports both `pay_in_advance` and `pay_in_arrear` plans natively**
> via the receivable + credit_line mechanism described below.

---

## Mission

One wallet model handles every plan shape. A customer's money — real or
platform-issued — lives in pgledger sub-accounts. The "wallet" is not a
Drizzle balance table; balance is the ledger.

The system answers three questions:

1. **Is this request ALLOWED?** → entitlement layer (existing `grants`)
2. **Can the customer AFFORD it?** → funding layer (pgledger sub-accounts)
3. **What kind of money is this?** → sub-account attribution

These compose in the DO hot path:
`entitlement check → priced fact → reservation check → consume`.

## Implementation Guardrails

Read [ADR-0002: Wallet And Payment Provider Activation Guardrails](../adr/ADR-0002-wallet-payment-provider-activation-guardrails.md)
before changing activation, reservations, wallet account seeding, or
payment-provider settlement. The ADR documents the operational lessons from
local signup and usage E2E debugging, including amount scale, `creditLineAmount`
semantics, and the distinction between direct provisioning and webhooks.

---

## The unified wallet principle

A wallet has **5 customer accounts** + **5 platform funding sources**.
Every plan shape — prepaid, postpaid, freemium, trial, hybrid — moves
money through the same accounts in the same order. The plan shape only
chooses *when* invoices get drafted, not *what* the ledger does.

```
                   CUSTOMER ACCOUNTS (per customer)
                   ──────────────────────────────────
                                                                                   
┌──────────────────────────┐    ┌──────────────────────────┐
│  available.purchased     │    │  available.granted       │
│  (cash-only, real money) │    │  (platform-issued credit)│
│  Source: top-ups only    │    │  Sources: credit_line,   │
│  Credit-normal           │    │   plan_included, promo,  │
│                          │    │   trial, manual          │
└────────────┬─────────────┘    └────────────┬─────────────┘
             │                               │
             │   priority drain (granted FIRST, FIFO by expiry)
             └───────────────┬───────────────┘
                             ▼
                  ┌─────────────────────┐
                  │      reserved       │   DO authorization
                  │  (source-agnostic)  │   credit-normal
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │     consumed        │   money burned
                  │  (source-agnostic)  │   credit-normal
                  └─────────────────────┘
                                                                                   
┌──────────────────────────┐
│      receivable          │   what customer owes us
│  (debit-normal,          │   negative balance = IOU
│   allow-negative)        │   cleared by topup → receivable
└──────────────────────────┘
```

```
                   PLATFORM ACCOUNTS (per project)
                   ─────────────────────────────────

  platform.{pid}.funding.topup         real $ from payment providers
  platform.{pid}.funding.promo         promotional credits + trial clawbacks
  platform.{pid}.funding.plan_credit   plan-included credits
  platform.{pid}.funding.manual        operator adjustments
  platform.{pid}.funding.credit_line   per-period spending allowance
                                       (postpaid + arrears)
```

### Why split?

| Question | Single `available` | Split sub-accounts |
|---|---|---|
| Is this real money? | scan transfer metadata | `SELECT balance FROM purchased` |
| Can I refund to card? | heuristic | `purchased.balance >= refund` |
| Drain promo first? | app logic on flat pool | natural — drain `granted` first |
| Customer owes us? | not modeled | `receivable.balance` |

### Why receivable is debit-normal

Invoice creation needs to record an obligation **before** any money
exists. `receivable` going more negative = customer owes us more.
`topup → receivable` clears the IOU. This decouples invoicing from
cash-on-hand, so invoices can be drafted before payment arrives, and
`purchased` stays a strict cash account (only top-ups go in).

---

## The unified flow

The mechanism is identical across plan shapes. Only the **timing** of
invoice creation differs.

```
ADVANCE PLAN (paid before the period)
═════════════════════════════════════

Day 0 (period start):
  ┌─ activateSubscription ──────────────────────────────────┐
  │ adjust(credit_line, +$50, expires=periodEnd)            │
  │   credit_line → granted                                 │
  │ creates wallet_credits row                              │
  └─────────────────────────────────────────────────────────┘
  ┌─ billPeriod (advance mode) ─────────────────────────────┐
  │ rate the period                                         │
  │ post: receivable → consumed   ($50 base fee)            │
  │ create invoice row (totalAmount=$50)                    │
  └─────────────────────────────────────────────────────────┘
  ┌─ Customer pays ─────────────────────────────────────────┐
  │ webhook → settleReceivable                              │
  │ topup → receivable          (clears IOU)                │
  └─────────────────────────────────────────────────────────┘

Days 1–30:
  ┌─ Usage events (DO hot path) ────────────────────────────┐
  │ granted → reserved → consumed  (drained from credit_line)│
  └─────────────────────────────────────────────────────────┘

Day 31:
  ┌─ wallet_credits row expires ────────────────────────────┐
  │ unused credit clawed back: granted → funding.credit_line│
  └─────────────────────────────────────────────────────────┘


ARREARS PLAN (paid after the period)
═════════════════════════════════════

Day 0 (period start):
  ┌─ activateSubscription ──────────────────────────────────┐
  │ adjust(credit_line, +$200 cap, expires=periodEnd)       │
  │   (this is the spending CEILING for the period)         │
  └─────────────────────────────────────────────────────────┘

Days 1–30:
  ┌─ Usage events (DO hot path) ────────────────────────────┐
  │ granted → reserved → consumed                           │
  └─────────────────────────────────────────────────────────┘

Day 31 (period end):
  ┌─ billPeriod (arrears mode) ─────────────────────────────┐
  │ rate the period (actual usage)                          │
  │ post: receivable → consumed   ($83.42 actual)           │
  │ unused credit clawed back at expiration                 │
  └─────────────────────────────────────────────────────────┘
  ┌─ Customer pays ─────────────────────────────────────────┐
  │ webhook → settleReceivable                              │
  │ topup → receivable          (clears IOU)                │
  └─────────────────────────────────────────────────────────┘
```

Bill-period transfers carry `flow + statement_key + kind` invoice
metadata, independent of plan shape. Invoice projection
([§ Invoice Projection](#invoice-projection)) queries by
`(project_id, statement_key)` — same query for advance and arrears.
Reservation flushes are accounting moves and are excluded from invoice
projection.

---

## Amount convention

All monetary amounts at **pgledger scale 8** (`$1 = 100_000_000`).
Database columns are `bigint`. TypeScript field names use `*Amount`
(never `*Cents`). Service boundaries use `Dinero<number>` configured at
scale 8. Invoices also store `totalAmount` at ledger scale.
Payment-provider adapters convert scale-8 amounts to currency minor
units when sending provider invoice items or checkout amounts, and
convert provider webhook amounts back to ledger scale before ledger
transfers. UI / SDK formatting is the other conversion boundary.

---

## Reservation primitive (flush-on-refill)

A reservation is a chunk of money the DO is authorized to consume
locally without per-event ledger writes. Every refill flushes consumed
amounts to the ledger.

### The four DO operations

```
┌─ create ─────────────────────────────────────────────────┐
│  customer.granted    → customer.reserved : granted_part   │
│  customer.purchased  → customer.reserved : purchased_part │
│  metadata: { flow:"reserve", reservation_id, drain_legs } │
│  partial fulfillment if total available < requested       │
└──────────────────────────────────────────────────────────┘

┌─ consume (DO SQLite only — zero ledger writes) ──────────┐
│  LocalReservation.applyUsage(state, cost)                │
│  persist newState synchronously                          │
│  if needsRefill: ctx.waitUntil(flushAndRefill)           │
└──────────────────────────────────────────────────────────┘

┌─ flush + refill (mid-period) ────────────────────────────┐
│  customer.reserved → customer.consumed : flush_amount    │
│    metadata: { flow:"flush", reservation_id, flush_seq }  │
│  customer.granted    → customer.reserved : refill_g      │
│  customer.purchased  → customer.reserved : refill_p      │
│    metadata: { flow:"refill", flush_seq, drain_legs }    │
│  shared idempotency: flush:{reservation}:{seq}           │
└──────────────────────────────────────────────────────────┘

┌─ final flush (period end / 12h inactivity / deletion) ───┐
│  customer.reserved → customer.consumed : unflushed       │
│    metadata: { flow:"flush", final:true, reservation_id }│
│  customer.reserved → customer.purchased : unused_p       │
│    metadata: { flow:"refund_reserved_cash" }             │
│  customer.reserved → platform.funding.{source} : unused_g│
│    metadata: { flow:"release_reserved_credit" }          │
└──────────────────────────────────────────────────────────┘
```

**Refund target.** Source attribution is preserved on the reservation
as `drain_legs`. Final flush refunds unused purchased money to
`available.purchased` and releases unused granted money back to the
mapped platform funding account (`promo`, `plan_credit`, `manual`,
`credit_line`). Phase 8 may add refund-to-card and per-payment
proportional attribution.

**Ledger writes per period.** 1 (reserve, multi-leg) + 2N (N mid-period
flushes) + 1–2 (final). Typically 5–10 transfers per customer per
period, regardless of event volume.

### LocalReservation (pure)

Hot-path math in a zero-dependency class.
[`internal/services/src/wallet/local-reservation.ts`](../../internal/services/src/wallet/local-reservation.ts).

```ts
applyUsage(state, cost) → { newState, isAllowed, needsRefill, refillRequestAmount }
applyRefill(state, grantedAmount) → newState
getCaptureMath(state) → { totalConsumedAmount, totalRefundAmount }
```

`flushedAmount` (cumulative total already sent to ledger) lives in DO
SQLite, not in `ReservationState`. On each flush the DO sends
`consumedAmount - flushedAmount` as `flush_amount`.

---

## Lazy reservation bootstrap

Reservations are not opened at activation. The first priced event for a
`(customer, meter, period)` tuple opens its own reservation. Free-tier
events never touch the wallet at all.

[`apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts:462`](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts:462).

```
DO.apply(event)
  ├─ entitlement check (grants table)
  ├─ price the event
  ├─ if pricePerEvent <= 0: skip wallet (free tier)
  ├─ readWalletReservation(SQLite) → row?
  │    ├─ yes → LocalReservation.applyUsage in-tx
  │    └─ no  → bootstrap (out-of-tx, single-flight)
  ├─ bootstrap:
  │    walletService.createReservation({
  │      idempotencyKey: 'do_lazy:{custEntId}:{periodKey}'
  │    })
  │    on WALLET_EMPTY → cache denial in idempotency_keys
  └─ persist + outbox to Tinybird
```

**Single-flight.** In-memory `reservationBootstrapPromise` dedupes
concurrent bootstraps within a DO instance. Across instances, the
partial unique index on
`entitlement_reservations (project_id, entitlement_id, period_start_at)
WHERE reconciled_at IS NULL` handles dedupe via
`createReservation().reused = "active"`.

**Out-of-tx.** Wallet writes Postgres; events write DO SQLite. They
can't share a transaction. Order: bootstrap → SQLite tx (LocalReservation
+ event idempotency).

---

## Plan settlement (advance + arrears)

The same three pieces of code handle both billing modes.

### activateSubscription — grants only

[`internal/services/src/use-cases/billing/provision-period.ts`](../../internal/services/src/use-cases/billing/provision-period.ts).

Issues additive `wallet_credits` for the upcoming period. Flips
`subscription.status = active`. **Does not** create reservations
(those are lazy) or transfer base fees (those flow through invoicing).

```
input: { subscriptionId, periodStartAt, periodEndAt, idempotencyKey,
         grants: ActivationGrant[] }

per grant: walletService.adjust({
  signedAmount: grant.amount,
  source: grant.source,           // plan_included | trial | credit_line | promo | manual
  expiresAt: periodEndAt,
  idempotencyKey: 'activate:{key}:grant:{i}'
})
```

### billPeriod — receivable → consumed

[`internal/services/src/use-cases/billing/bill-period.ts`](../../internal/services/src/use-cases/billing/bill-period.ts).

Materializes pending billing periods into ledger entries + invoice
rows. Identical for advance and arrears.

```
per pending period (grouped by statement_key):
  rate the period (RatingService)
  post: customer.receivable → customer.consumed : rated_amount
    metadata: {
      flow: "subscription",
      kind: "subscription",
      statement_key,
      billing_period_id,
      ...rating snapshot
    }
  project invoice lines from ledger (getInvoiceLines)
  upsert invoice row, totalAmount = sum of lines at ledger scale
  mark periods invoiced
```

Trial / zero / negative periods are skipped at the ledger layer
(pgledger rejects non-positive transfers). Negative totals get credit
treatment via the wallet flow.

### settleReceivable — topup → receivable

[`internal/services/src/use-cases/billing/settle-invoice.ts`](../../internal/services/src/use-cases/billing/settle-invoice.ts) →
`walletService.settleReceivable`.

```
on payment-provider webhook (or sync collect):
  topup → customer.receivable : invoice.totalAmount
    metadata: { flow:"settle_receivable", invoice_id, subscription_id, when_to_bill }
  idempotencyKey: 'invoice_receivable:{invoice_id}'
```

Same for `pay_in_advance` and `pay_in_arrear`. Idempotency on invoice
ID (not webhook event ID) so duplicate `payment.succeeded` +
`invoice.paid` webhooks converge on one ledger row. The payment
provider charge uses currency minor units at the provider boundary;
the ledger settlement uses `invoice.totalAmount` at scale 8.

### Why usage runway isn't funded by invoice settlement

A subscription invoice settling for $50 should NOT also grant $50 of
usage runway. Runway is issued at activation as `credit_line → granted`;
settlement only clears the receivable IOU. `purchased` is reserved for
explicit customer top-ups (a separate operation).

---

## Top-up primitive

```
INITIATE (tRPC, user-facing):
  insert wallet_topups row (status='pending', provider_session_id=NULL)
  call provider.createCheckoutSession
  update wallet_topups.provider_session_id with returned session id
  return checkoutUrl
  on provider error: mark row failed
  (no ledger write yet)

SETTLE (provider webhook):
  walletService.settleTopUp({ providerSessionId, paidAmount, idempotencyKey })
    update wallet_topups → completed
    platform.funding.topup → customer.available.purchased
    metadata: { flow:"topup", topup_id, external_ref }
  idempotencyKey: 'topup:{webhook_event_id}'

FAIL / EXPIRE:
  update wallet_topups → failed | expired
  no ledger write
  expiration cron sweeps pending rows older than 24h
```

---

## Wallet credits (formerly wallet_grants)

A Drizzle table tracking each platform-issued credit's lifecycle. The
**ledger** holds the actual money in `available.granted`; the
**`wallet_credits`** table tracks per-credit attribution and expiration.

```
wallet_credits
├ id, project_id, customer_id
├ source            promo | plan_included | trial | manual | credit_line
├ issued_amount     bigint scale 8 (immutable once issued)
├ remaining_amount  bigint scale 8 (decremented FIFO by drains)
├ expires_at        timestamptz NULL = never expires
├ expired_at        set when expiration job claws back
├ voided_at         set when operator manually voids
├ ledger_transfer_id  the original credit transfer
├ metadata          jsonb
└ UNIQUE (customer_id, ledger_transfer_id)
```

### FIFO drain by expiry

Within `available.granted`, drain by `expires_at ASC` (soonest first;
`NULL` = never expires last). Per-credit `remaining_amount` is
decremented in the same transaction as the ledger transfer. Drain
attribution captured in transfer metadata as `drain_legs`.

### Expiration ledger transfer

```
customer.available.granted → platform.funding.{source-mapped}
  metadata: { flow:"expire", credit_id, source, expired_amount }
```

Source mapping ([`service.ts:177`](../../internal/services/src/wallet/service.ts:177)):

| `wallet_credits.source` | Returns to |
|---|---|
| `promo` | `funding.promo` |
| `plan_included` | `funding.plan_credit` |
| `trial` | `funding.promo` ← no dedicated trial source |
| `manual` | `funding.manual` |
| `credit_line` | `funding.credit_line` |

### Expiration job

Runs every 5 minutes
([`internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts`](../../internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts)).
For each credit with `expires_at <= now()`, advisory-lock the customer,
re-read inside the lock, call `expireGrant`, mark `expired_at`.

---

## WalletService surface

[`internal/services/src/wallet/service.ts`](../../internal/services/src/wallet/service.ts).
Eight methods, every one wraps its writes in a Drizzle transaction
opening with `pg_advisory_xact_lock(hashtext('customer:' || id))`.

```ts
transfer(input)              generic balance-moving primitive
createReservation(input)     priority drain → granted then purchased
flushReservation(input)      flush + multi-leg refill (mid or final)
adjust(input, tx?)           issue (+) or claw back (-) credits;
                             positive granted → wallet_credits row
settleTopUp(input)           webhook-confirmed top-up
expireGrant(tx, input)       clawback expired wallet_credits
settleReceivable(input)      topup → receivable (clears invoice IOU)
getWalletState(input)        read sub-account balances + active credits
```

`AdjustSource = WalletCreditSource | "purchased"` — reuse the schema
derived `WalletCreditSource` type instead of re-declaring the DB enum
in service code.

`reserved → consumed` reservation flushes intentionally do **not** carry
`metadata.statement_key` or `metadata.kind`; they are accounting moves,
not invoice lines. Bill-period transfers carry invoice metadata.

---

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │   EntitlementWindowDO (per cust+meter)       │
   event ───────►│  apply():                                    │
                 │    entitlement → price → applyUsage          │
                 │    persist SQLite synchronously              │
                 │    outbox → Tinybird                         │
                 │    if needsRefill: ctx.waitUntil(flush)      │
                 │  alarm():                                    │
                 │    if periodEnd | inactive_12h | deleted:    │
                 │      finalFlush                              │
                 └──────────────────┬───────────────────────────┘
                                    │ Hyperdrive (CF edge pool, recommended)
                                    ▼ (vs direct Neon today)
                 ┌──────────────────────────────────────────────┐
                 │  WalletService (Postgres)                    │
                 │  pg_advisory_xact_lock(customer_id)          │
                 │  inside every balance-changing tx            │
                 └──────────────────┬───────────────────────────┘
                                    ▼
                 ┌──────────────────────────────────────────────┐
                 │  pgledger (Phase 7 accounts — see top)       │
                 └──────────────────────────────────────────────┘
```

**Bill-period and settle-invoice paths** call `WalletService` directly
from the Trigger.dev workers (not via the DO). They share the
WalletService class definition and advisory-locking discipline.

---

## Reservation sizing

Computed in `sizeReservation()` inside the DO at lazy-bootstrap time.
Snapshotted into `entitlement_reservations` at create time, immutable
for the life of the reservation.

```
MINIMUM_FLOOR_AMOUNT = 100_000_000     // $1
CEILING_AMOUNT       = 1_000_000_000   // $10

initial_allocation_amount = clamp(
  pricePerEvent * 1000,
  MINIMUM_FLOOR_AMOUNT,
  CEILING_AMOUNT
)
refill_threshold_bps = 2000  (slow) | 5000 (high-velocity)
refill_chunk_amount  = initial_allocation_amount / 4
```

---

## Critical invariants

| Invariant | Where enforced |
|---|---|
| Transfer balanced (debits = credits) | pgledger (DB) |
| `customer.*` accounts non-negative | pgledger (DB) |
| Idempotency on (sourceType, sourceId) | pgledger (DB) |
| `SUM(wallet_credits.remaining WHERE active) == available.granted balance` | **deferred trigger on wallet_credits** (real-time) |
| `Σ inflows - Σ outflows == sum of balances` | nightly cron (heavy query) |
| Stranded reservations (period_end past, reconciled_at NULL) | nightly cron |
| Stranded top-ups (pending > 24h) | nightly cron |
| Invoice projection orphans (bill-period consumed without statement_key + kind; reservation flushes excluded) | nightly cron |

The wallet_credits invariant is enforced by a deferred `CONSTRAINT
TRIGGER` that asserts the sum matches the ledger balance for the
affected customer at COMMIT. Any transaction that breaks the invariant aborts —
drift cannot persist. **The nightly cron does NOT re-check this
invariant**; the trigger is the single source of enforcement. If the
trigger ever fires, the failed tx already rolled back and the bad
state never existed; debug from application logs (the violating
operation surfaced an error to the caller).

---

## DO durability and recovery

The DO holds `consumedAmount - flushedAmount` in SQLite between flushes.
If the DO is permanently lost after local consumption and before a
flush, that delta is unrecoverable in Phase 7.

Phase 7 does **not** use `entitlement_reservations.consumed_amount` as a
shadow watermark. That column remains the Postgres-side committed
consumption total. The nightly reconciliation sweep only finds stranded
reservations; automated reconstruction from DO-local deltas is deferred.

Queue-backed flushes, consumed watermarks, and bounded-loss recovery are
Phase 8 / follow-up work.

---

## Connection model and queue strategy

**Today.** Each DO instance opens its own Neon serverless `Pool`
([`createConnection.ts`](../../internal/db/src/createConnection.ts), called from
[`EntitlementWindowDO.ts:2337`](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts:2337)).
At 10K active DOs that's 30K-50K connections to Neon, hitting tier
limits hard.

**Recommendation.** Two complementary primitives, addressing two
patterns:

| Pattern | Examples | Right tool |
|---|---|---|
| Request-response (RPC) | `createReservation`, mid-period `flushReservation+refill` | **Hyperdrive** (CF edge pool) — drop-in, keeps RPC semantics |
| Fire-and-forget (durable) | future consumed watermark, final flush on eviction, audit | **CF Queue** — DO publishes and exits; consumer drains |

Phase 7 ships with direct Neon. Hyperdrive and Queue integrations are
follow-ups; benchmark first to confirm the saturation problem before
adding plumbing.

---

## Schemas

Three new tables. All amount columns `bigint` at scale 8.

- [`entitlement_reservations`](../../internal/db/src/schema/entitlementReservations.ts) — reservation state machine + `drain_legs`
- [`wallet_topups`](../../internal/db/src/schema/walletTopups.ts) — top-up state machine (`provider_session_id` nullable until provider session creation succeeds)
- [`wallet_credits`](../../internal/db/src/schema/walletCredits.ts) — credit attribution + expiration

Schema changes also omit the legacy `credit_grants`, `invoice_items`,
and `invoice_credit_applications` tables. Invoices use `totalAmount`
(bigint scale 8); there is no cents-named invoice column.

---

## Invoice projection

Ledger is the single source of truth for invoice lines. No
`invoice_items` storage.

```sql
SELECT e.metadata->>'statement_key'  AS statement_key,
       e.id                          AS entry_id,
       e.metadata->>'kind'           AS kind,
       e.metadata->>'description'    AS description,
       (e.metadata->>'quantity')::numeric AS quantity,
       e.amount,
       e.created_at
FROM pgledger_entries_view e
WHERE e.project_id   = $1
  AND e.metadata->>'statement_key' = $2
  AND e.account_kind = 'customer_consumed'
  AND e.direction    = 'debit'   -- debit-leg landing on customer.consumed
  AND e.metadata->>'kind' IS NOT NULL
  AND COALESCE(e.metadata->>'flow', '') <> 'flush';
```

**Contract.** In Phase 7, invoice lines come from bill-period transfers:
they land on `customer.{cid}.consumed` and carry
`metadata.statement_key` plus `metadata.kind`. Reservation flushes carry
`flow:"flush"` and intentionally omit invoice metadata, so they cannot
double-count usage already represented by bill-period receivable
transfers.

API: [`GET /v1/invoices/:id`](../../apps/api/src/routes/invoices/getInvoiceV1.ts)
returns invoice header + projection.

---

## Read API

```
GET /v1/wallet → {
  available: { purchased, granted, total },
  reserved,
  consumed,
  credits: WalletCredit[]
}
```

[`apps/api/src/routes/wallet/getWalletV1.ts`](../../apps/api/src/routes/wallet/getWalletV1.ts)
calls `WalletService.getWalletState`. All amounts at scale 8.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| DO permanently lost mid-period | Accepted Phase 7 risk; queue/watermark recovery deferred |
| Connection saturation at scale | Hyperdrive (drop-in) once stress-tested |
| `wallet_credits` drift vs ledger | Deferred constraint trigger (real-time) |
| Refill latency under burst | Per-meter `refill_threshold_bps`; hot meters use 50%+ |
| Refill races at wallet-empty | Advisory lock serializes; second reader sees fresh balance |
| DO eviction mid-flush | `pending_flush_seq` survives in SQLite; re-issued on wake |
| Top-up webhook before INSERT | INSERT commits before `createCheckoutSession`; `settleTopUp` returns typed error on missing row |
| `funding.*` drift | Expected in Phase 7 (no payout reconciliation); excluded from nightly check |
| FIFO drain ≠ user expectation | Documented; minimizes expiration waste |
| Lazy bootstrap latency on first event | Single-flight + denial cache; pre-warm only if telemetry shows it matters |

---

## Guardrails

- All amounts at scale 8. No `*_cents` columns, no `*Cents` fields.
- Strict reservation only — no soft-overage paths.
- Zero ledger writes per priced event. DO absorbs events; ledger sync amortized.
- Priority drain is law. `granted` first, `purchased` second. FIFO by expiry within `granted`.
- No cached balance columns outside DO SQLite.
- No `wallets` balance table. Balance is the ledger.
- Reservations are lazy. Activation issues credits only.
- Refunds are wallet-credit only in Phase 7. Refund-to-card is Phase 8.
- `WalletService` sits on `LedgerGateway` directly — no `LedgerService.postCharge` shim.
- No `CustomerFundingDO`. Serialization is `pg_advisory_xact_lock(hashtext('customer:' || id))`.

---

## Verification

```bash
# 1. Type check (every workspace)
pnpm typecheck

# 2. Unit + integration tests
pnpm -F @unprice/services test wallet
pnpm -F @unprice/services test ledger

# 3. Confirm zero legacy strings
rg "house:|house\."                                  internal/ apps/   # → empty
rg "grantAccountKey|grant:" internal/services/                         # → empty
rg "credit_grants|invoiceItems|invoiceCreditApplications" internal/db/ # → empty
rg "_cents\b|Cents\b"                                internal/ apps/   # → empty
rg "wallet_grants|walletGrants|WalletGrant\b"        internal/ apps/   # → empty

# 4. Migrations apply cleanly
pnpm -F @unprice/db migrate

# 5. End-to-end smoke test
#  - activate subscription with plan_included grant
#  - send priced event → confirm lazy createReservation fires once
#  - keep sending events past threshold → flushReservation fires
#  - period_end → alarm fires final flush
#  - billPeriod posts receivable → consumed
#  - settleReceivable clears the IOU
#  - GET /v1/wallet returns sub-account balances + credits
#  - GET /v1/invoices/:id returns header + projected lines
```

---

## Rollout

Single rollout, no feature flag.

1. Schema migrations: tables + amount naming cleanup + `wallet_grants` → `wallet_credits` rename
2. Custom SQL migration: deferred `wallet_credits` invariant trigger
3. Deploy `LocalReservation` + `WalletService` (8 methods)
4. Deploy DO with allocation-aware apply + lazy bootstrap
5. Activation hook (grants only)
6. bill-period + settle-invoice (wired for both advance and arrears)
7. Top-up tRPC + webhook → `settleTopUp`
8. Credit expiration job (5-min cron)
9. Nightly reconciliation cron (4 checks — the wallet_credits invariant is enforced by the trigger, not re-checked here)
10. Read API: `GET /v1/wallet`, `GET /v1/invoices/:id`

No back-fill. No dual-write.

---

## Related

- [`../pgledger-ai-wallet-coa.md`](../pgledger-ai-wallet-coa.md) — chart of accounts
- [Phase 6.6](./unprice-phase-06.6-new-ledger.md) — pgledger gateway
- [Phase 6.7](./unprice-phase-06.7-agent-billing-simplification.md) — agent billing
- [Phase 8](./unprice-phase-08-financial-guardrails.md) — refund-to-card, proportional refund, cross-meter caps
