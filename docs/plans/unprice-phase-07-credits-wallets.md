# Phase 7: Wallets, Reservations & Credit Lifecycle (pgledger-native)

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
Chart of accounts: [../pgledger-ai-wallet-coa.md](../pgledger-ai-wallet-coa.md)
PR title: `feat: wallets and reservations on pgledger`
Branch: `feat/wallets-reservations`

**Prerequisite:** [Phase 6.6](./unprice-phase-06.6-new-ledger.md) and
[Phase 6.7](./unprice-phase-06.7-agent-billing-simplification.md) both
green.

---

## Mission

Make pgledger the single source of truth for customer balance. The
"wallet" is not a Drizzle table — it is a set of sub-accounts in
pgledger that distinguish **real money** from **promotional/granted
credits**.

The system must answer three questions at any point in time:

1. **"Is this request ALLOWED?"** → Entitlement layer (existing `grants` table)
2. **"Can the customer AFFORD this?"** → Funding layer (pgledger sub-accounts)
3. **"What money is real vs promotional?"** → Sub-account attribution

These compose in the DO hot path:
`check entitlement limit → price event → check reservation → consume`.

---

## Two-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ENTITLEMENT LAYER  (existing grants table)                 │
│  "You can USE X amount of feature Y"                        │
│                                                             │
│  grants table → sorted by priority → merged by policy       │
│  (sum for usage, max for tier, replace for flat)            │
│  → computed entitlement (not a DB row, just runtime state)  │
│                                                             │
│  Answers: rate limits, feature access, usage caps           │
│  Does NOT track money                                       │
└─────────────────────┬───────────────────────────────────────┘
                      │ "allowed" + priced cost
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  FUNDING LAYER  (pgledger sub-accounts)                     │
│  "You have $X to SPEND (and here's what kind of money)"     │
│                                                             │
│  customer.{cid}.available.purchased  — real money           │
│  customer.{cid}.available.granted    — promo/trial credits  │
│  customer.{cid}.reserved             — DO authorization     │
│  customer.{cid}.consumed             — money burned         │
│                                                             │
│  Answers: balance checks, reservation authorization,        │
│           revenue attribution, refund eligibility           │
└─────────────────────────────────────────────────────────────┘
```

The entitlement `grants` table is **unchanged** from its current form.
It continues to track quantity/access rights with priority, merging
policies (sum/max/replace), and feature linkage. Phase 7 adds the
funding layer alongside it.

---

## Account Model

### Sub-Account Split

Instead of a single `customer.{cid}.available`, the balance is split:

```
customer.{cid}.available.purchased   — real money (top-ups, paid subscription credits)
customer.{cid}.available.granted     — promotional/trial/plan-included credits (funny money)
customer.{cid}.reserved              — DO spending authorization (source-agnostic)
customer.{cid}.consumed              — money burned (source-agnostic)
```

Platform source accounts (per project):

```
platform.{pid}.funding.topup         — real money from payment providers
platform.{pid}.funding.promo         — promotional credits issued
platform.{pid}.funding.plan_credit   — plan-included credits + base fees
platform.{pid}.funding.manual        — manual operator adjustments
```

### Why Split?

| Question | Single `available` | Split sub-accounts |
|---|---|---|
| "How much real money does customer have?" | Scan transfer metadata | `SELECT balance FROM available.purchased` |
| "Can I refund to their card?" | Heuristic | `purchased.balance >= refund_amount` |
| "How much promo credit expired?" | Scan + compute | `SUM(expired_amount) FROM wallet_grants` |
| "Revenue attribution for this period?" | Reconstruct from metadata | `consumed` balance, split by drain metadata |
| "Drain promotional credits first?" | Application logic on flat pool | Natural: drain `granted` sub-account first |

### Money Flow Diagram

```
                    Payment Provider (Stripe, Polar, etc.)
                              │
                              │ webhook confirms payment
                              ▼
               ┌──────────────────────────────┐
               │  platform.{pid}.funding.topup │
               └──────────────┬───────────────┘
                              │ settleTopUp()
                              ▼
               ┌──────────────────────────────────┐
               │ customer.{cid}.available.purchased │ ◄── real money
               └──────────────┬───────────────────┘
                              │
            ┌─────────────────┤ drainToReserved()
            │                 │ (purchased drained SECOND)
            │                 ▼
            │  ┌────────────────────────────────┐
            │  │  customer.{cid}.reserved        │ ◄── DO authorization
            │  └──────────────┬─────────────────┘
            │                 │ flushReservation()
            │                 ▼
            │  ┌────────────────────────────────┐
            │  │  customer.{cid}.consumed        │ ◄── money burned
            │  └────────────────────────────────┘
            │
            │  ┌──────────────────────────────────┐
            ├──│ customer.{cid}.available.granted   │ ◄── funny money
            │  └──────────────┬───────────────────┘
            │                 │ drainToReserved()
            │                 │ (granted drained FIRST)
            │                 ▼
            │           (same reserved account)
            │
            │  ┌──────────────────────────────────┐
            └──│ platform.{pid}.funding.promo      │ ──► grant issuance
               │ platform.{pid}.funding.plan_credit│ ──► plan activation
               │ platform.{pid}.funding.manual     │ ──► operator adjust
               └──────────────────────────────────┘
```

### Priority Drain Order

When funding a reservation or any `available → reserved` movement:

1. **Drain `available.granted` FIRST** (funny money — use it or lose it)
2. **Drain `available.purchased` SECOND** (real money — preserve it)

Within `available.granted`, drain by grant expiry date (soonest-expiring
first, FIFO). This is tracked via the `wallet_grants` table.

Attribution is recorded at drain time in transfer metadata:

```json
{
  "flow": "reserve",
  "reservation_id": "res_xxx",
  "drain_legs": [
    { "source": "granted", "amount": 50000000, "grant_id": "wgr_abc" },
    { "source": "purchased", "amount": 50000000 }
  ]
}
```

---

## Amount Convention

**All monetary amounts are stored and passed at pgledger scale 8.**
One dollar is `100_000_000` minor units. Database columns are `bigint`.
TypeScript field names use the `*Amount` suffix (never `*Cents`).
Service boundaries use `Dinero<number>` configured at scale 8. Sub-cent
pricing (e.g., `$0.00012345 = 12_345` units) is representable without
rounding.

Conversions to/from human-readable dollars happen only at UI / SDK
boundaries. Nothing inside `WalletService`, `LocalReservation`, the DO,
or the reconciliation cron converts scales.

---

## Grant & Credit Expiration

### The Problem

Promotional credits, trial credits, and plan-included credits have a
natural expiration. When they expire, unspent amounts must be clawed
back cleanly without affecting real money.

### Solution: `wallet_grants` Tracking Table

A lightweight Drizzle table tracks each credit grant's lifecycle. The
**ledger** holds the actual money in `available.granted`; the
**`wallet_grants` table** tracks per-grant attribution and expiration.

```
┌────────────────────────────────────────────────────────────┐
│                    wallet_grants                            │
│                                                            │
│  id              text PK                                   │
│  project_id      text NOT NULL                             │
│  customer_id     text NOT NULL                             │
│  source          'promo' | 'plan_included' | 'trial'       │
│                  | 'manual'                                │
│  issued_amount   bigint NOT NULL  (scale 8)                │
│  remaining_amount bigint NOT NULL (scale 8)                │
│  expires_at      timestamptz NULL (null = never expires)   │
│  expired_at      timestamptz NULL (set when expired)       │
│  voided_at       timestamptz NULL (set when manually voided)│
│  ledger_transfer_id text NOT NULL (original credit xfer)   │
│  metadata        jsonb                                     │
│  created_at      timestamptz NOT NULL DEFAULT now()        │
│                                                            │
│  UNIQUE (customer_id, ledger_transfer_id)                  │
│  INDEX (customer_id, expires_at) WHERE expired_at IS NULL  │
│    AND voided_at IS NULL                                   │
└────────────────────────────────────────────────────────────┘
```

**Key invariant:** For any customer, `SUM(remaining_amount) FROM
wallet_grants WHERE expired_at IS NULL AND voided_at IS NULL` MUST equal
`customer.{cid}.available.granted` balance. Checked nightly.

### Grant Lifecycle

```
  Issue              Drain (FIFO)          Expire
  ─────►             ─────────►            ─────►
  
  ┌──────────┐    ┌──────────────┐    ┌──────────────┐
  │ ACTIVE   │───►│ PARTIALLY    │───►│ EXPIRED      │
  │          │    │ CONSUMED     │    │              │
  │ remaining│    │ remaining    │    │ remaining=0  │
  │ = issued │    │ < issued     │    │ expired_at   │
  └──────────┘    └──────┬───────┘    └──────────────┘
       │                 │                    ▲
       │                 ▼                    │
       │          ┌──────────────┐            │
       └─────────►│ FULLY        │────────────┘
                  │ CONSUMED     │  (if remaining=0
                  │ remaining=0  │   at expiry time)
                  └──────────────┘
```

### Drain Algorithm (FIFO by Expiry)

When draining from `available.granted` for a reservation:

```ts
// Called inside drainToReserved() when draining the granted sub-account
async function drainGrantedFIFO(
  tx: Transaction,
  customerId: string,
  requestedAmount: number,
): Promise<{ drained: number; legs: DrainLeg[] }> {
  // Get active grants ordered by expiry (soonest first, nulls last)
  const activeGrants = await tx.query.walletGrants.findMany({
    where: and(
      eq(walletGrants.customerId, customerId),
      isNull(walletGrants.expiredAt),
      isNull(walletGrants.voidedAt),
      gt(walletGrants.remainingAmount, 0),
    ),
    orderBy: [
      // soonest-expiring first; never-expiring last
      sql`COALESCE(expires_at, 'infinity'::timestamptz) ASC`,
      asc(walletGrants.createdAt), // tie-break: oldest first
    ],
  })

  let remaining = requestedAmount
  const legs: DrainLeg[] = []

  for (const grant of activeGrants) {
    if (remaining <= 0) break

    const drain = Math.min(remaining, grant.remainingAmount)

    await tx.update(walletGrants)
      .set({ remainingAmount: grant.remainingAmount - drain })
      .where(eq(walletGrants.id, grant.id))

    legs.push({
      source: "granted",
      amount: drain,
      grantId: grant.id,
      grantSource: grant.source,
    })

    remaining -= drain
  }

  return { drained: requestedAmount - remaining, legs }
}
```

### Expiration Job

A scheduled job runs periodically (e.g., every 5 minutes) to expire
grants whose `expires_at` has passed:

```ts
// internal/jobs/src/trigger/tasks/expire-wallet-grants.ts
async function expireWalletGrants() {
  const expiredGrants = await db.query.walletGrants.findMany({
    where: and(
      isNull(walletGrants.expiredAt),
      isNull(walletGrants.voidedAt),
      gt(walletGrants.remainingAmount, 0),
      lte(walletGrants.expiresAt, new Date()),
    ),
  })

  for (const grant of expiredGrants) {
    // One transaction per grant (different customers may be involved)
    await db.transaction(async (tx) => {
      // Advisory lock on customer
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('customer:' || ${grant.customerId}))`
      )

      // Re-read inside lock (may have been consumed since query)
      const current = await tx.query.walletGrants.findFirst({
        where: eq(walletGrants.id, grant.id),
      })

      if (!current || current.expiredAt || current.remainingAmount === 0) return

      const clawbackAmount = current.remainingAmount

      // Ledger transfer: available.granted → platform.funding.promo (or appropriate source)
      await walletService.expireGrant(tx, {
        customerId: current.customerId,
        projectId: current.projectId,
        grantId: current.id,
        amount: clawbackAmount,
        source: current.source,
        idempotencyKey: `expire:${current.id}`,
      })

      // Mark grant as expired
      await tx.update(walletGrants).set({
        remainingAmount: 0,
        expiredAt: new Date(),
      }).where(eq(walletGrants.id, current.id))
    })
  }
}
```

### Expiration Ledger Transfer

```
customer.{cid}.available.granted → platform.{pid}.funding.{source}
  metadata: {
    flow: "expire",
    grant_id: "wgr_xxx",
    source: "promo",        // or "trial", "plan_included"
    expired_amount: 50000000,
    idempotency_key: "expire:wgr_xxx"
  }
```

The money returns to the **same platform source account** it came from,
keeping the books balanced per funding type.

---

## The Reservation Primitive (flush-on-refill)

A reservation is a chunk of funded money the DO is authorized to consume
locally without touching the ledger per event. Every time the DO refills,
it also flushes consumed amounts to the ledger.

### Create (one pgledger transaction, multi-leg drain)

```
# Step 1: Drain from available.granted (FIFO by expiry)
customer.{cid}.available.granted → customer.{cid}.reserved : granted_portion
  metadata: { flow: "reserve", reservation_id, drain_source: "granted",
              grant_ids: [...], idempotency_key }

# Step 2: Drain from available.purchased (remainder)
customer.{cid}.available.purchased → customer.{cid}.reserved : purchased_portion
  metadata: { flow: "reserve", reservation_id, drain_source: "purchased",
              idempotency_key }
```

If `available.granted + available.purchased < requested`, move what's
available; the DO denies `WALLET_EMPTY` once that chunk runs out.

The `wallet_grants.remaining_amount` is decremented for each grant
drained in the same transaction (FIFO by expiry).

### Consume (DO SQLite only, zero ledger writes)

```
DO.apply(event)
  ├─ compute priced fact (rate card snapshotted in 6.7.2)
  ├─ LocalReservation.applyUsage(state, cost)       // pure function
  ├─ persist newState to SQLite synchronously
  ├─ push priced fact to outbox → Tinybird
  └─ if needsRefill && !refillInFlight:
       ctx.waitUntil(requestFlushAndRefill())
```

### Flush and Refill (one pgledger transaction, multi-leg)

```
# 1. Recognize what was consumed since the last flush
customer.{cid}.reserved → customer.{cid}.consumed : flush_amount
  metadata: { flow: "flush", reservation_id, flush_seq, kind: "usage",
              statement_key }

# 2. Extend runway (multi-leg drain, same priority order)
customer.{cid}.available.granted → customer.{cid}.reserved : granted_refill
customer.{cid}.available.purchased → customer.{cid}.reserved : purchased_refill
  metadata: { flow: "refill", reservation_id, flush_seq, idempotency_key }
```

Both legs share `idempotencyKey = flush:{reservation_id}:{flush_seq}`.
`flush_amount == 0` skips leg 1.

### Final Flush (DO `alarm()` — period end / 24h inactivity / deletion)

```
# 1. Recognize remaining unflushed consumption
customer.{cid}.reserved → customer.{cid}.consumed : unflushed_amount
  metadata: { flow: "flush", reservation_id, flush_seq, kind: "usage",
              statement_key, final: true }

# 2. Return the rest (to purchased — conservative; real money returned)
customer.{cid}.reserved → customer.{cid}.available.purchased : refund_amount
  metadata: { flow: "refund", reservation_id, statement_key }
```

Skip leg 1 if `unflushed_amount == 0`; skip leg 2 if `refund_amount == 0`.
Idempotency key `capture:{reservation_id}`.

**Why refund to `purchased`?** Once money enters `reserved`, the
source attribution is lost (it's source-agnostic). Returning to
`purchased` is conservative — real money is always safe to hold.
Alternative: track drain attribution in the reservation row and refund
proportionally. Deferred to Phase 8 if needed.

### Ledger Writes Per Period

1 (reserve, multi-leg) + 2N (N mid-period flushes) + 1–2 (final).
Typically 5–10 transfers per customer per period.

---

## The Top-Up Primitive

Mirrors reservations on the provider side. A Drizzle table tracks the
request lifecycle; the ledger records the money movement only after the
provider webhook confirms settlement.

### Initiate (tRPC router, at user request)

```ts
const topupId = newId("wallet_topup")
const session = await paymentProviderResolver.createCheckoutSession({
  amount: input.amount,           // scale 8
  currency: input.currency,
  metadata: {
    kind:       "wallet_topup",
    topup_id:   topupId,
    customer_id: input.customerId,
  },
})
await db.insert(walletTopups).values({
  id:                  topupId,
  projectId:           ctx.projectId,
  customerId:          input.customerId,
  provider:            session.provider,
  providerSessionId:   session.id,
  requestedAmount:     input.amount,
  currency:            input.currency,
  status:              "pending",
})
return { checkoutUrl: session.url, topupId }
```

No ledger write yet. No public `POST /v1/wallet/top-up` — tRPC-only.

### Settle (provider webhook → `processWebhookEvent` → `walletService.settleTopUp`)

```
one pgledger transaction:
  UPDATE wallet_topups SET status='completed', completed_at=now(),
    settled_amount=?, ledger_transfer_id=?
    WHERE provider_session_id = ?

  platform.{pid}.funding.topup → customer.{cid}.available.purchased : paid_amount
    metadata: { flow: "topup", source: "purchased", topup_id, external_ref }
```

Idempotent on `topup:{webhook_event_id}`.

### Fail / Expire

```
UPDATE wallet_topups SET status IN ('failed','expired'), completed_at=now()
  WHERE provider_session_id = ?
```

No ledger write. Expiration cron sweeps `pending` rows older than 24h.

---

## Subscription Activation + Funding

When a subscription activates, it may include plan credits (e.g., "$10
of API calls included in Pro plan"). These are **granted credits** —
promotional money that came with the plan:

```
platform.{pid}.funding.plan_credit → customer.{cid}.available.granted : plan_credit_amount
  metadata: { flow: "adjust", source: "plan_included", subscription_id,
              billing_period_id, grant_id: "wgr_xxx" }
```

A `wallet_grants` row is created for these plan credits with
`source = "plan_included"` and `expires_at = period_end_at` (they
expire at the end of the billing period).

**Flat subscription fees** (base price) are a direct consumption:

```
customer.{cid}.available.purchased → customer.{cid}.consumed : base_fee_amount
  metadata: { flow: "subscription", kind: "subscription", subscription_id,
              statement_key, billing_period_id }
```

Base fees always drain from `purchased` (real money). If `purchased`
is insufficient, the subscription cannot activate.

---

## LocalReservation (pure core)

Hot-path logic in a zero-dependency class. The DO wires this into
`applyEventSync`'s `beforePersist` hook.

```ts
// internal/services/src/wallet/local-reservation.ts
// Pure functions. No I/O, no imports beyond types.
// All amounts are pgledger scale-8 minor units ($1 = 100_000_000).

export type ReservationState = {
  allocationAmount: number  // Total money granted to this DO so far
  consumedAmount:   number  // Total money burned (cumulative)
}

export type UsageResult = {
  newState: ReservationState
  isAllowed: boolean
  needsRefill: boolean
  refillRequestAmount: number
}

export class LocalReservation {
  constructor(
    private thresholdAmount: number,
    private chunkAmount: number,
  ) {}

  public applyUsage(state: ReservationState, cost: number): UsageResult {
    const remaining = state.allocationAmount - state.consumedAmount

    if (cost > remaining) {
      return {
        newState: state,
        isAllowed: false,
        needsRefill: true,
        refillRequestAmount: this.chunkAmount,
      }
    }

    const newState: ReservationState = {
      allocationAmount: state.allocationAmount,
      consumedAmount:   state.consumedAmount + cost,
    }

    const newRemaining = newState.allocationAmount - newState.consumedAmount
    const needsRefill = newRemaining < this.thresholdAmount

    return {
      newState,
      isAllowed: true,
      needsRefill,
      refillRequestAmount: needsRefill ? this.chunkAmount : 0,
    }
  }

  public applyRefill(state: ReservationState, grantedAmount: number): ReservationState {
    return {
      allocationAmount: state.allocationAmount + grantedAmount,
      consumedAmount:   state.consumedAmount,
    }
  }

  public getCaptureMath(state: ReservationState) {
    const refund = state.allocationAmount - state.consumedAmount
    return {
      totalConsumedAmount: state.consumedAmount,
      totalRefundAmount:   Math.max(0, refund),
    }
  }
}
```

`flushedAmount` (cumulative total already sent to the ledger) is tracked
in the DO's SQLite, not in `ReservationState`. On each flush, the DO
sends `consumedAmount - flushedAmount` as the `flush_amount` leg.

---

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │   EntitlementWindowDO (per cust+meter)       │
  event ────────►│  apply():                                    │
                 │    ├─ entitlement check (grants table)       │
                 │    ├─ priced fact (snapshotted rate card)    │
                 │    ├─ LocalReservation.applyUsage(...)       │
                 │    ├─ persist newState to SQLite             │
                 │    ├─ priced fact → outbox → Tinybird        │
                 │    └─ if needsRefill && !refillInFlight:     │
                 │         ctx.waitUntil(                       │
                 │           walletService.flushReservation())  │
                 │  alarm():                                    │
                 │    ├─ flush outbox → Tinybird                │
                 │    └─ if periodEnd | inactive_24h | deleted: │
                 │         walletService.flushReservation(      │
                 │           { final: true })                   │
                 └──────────────────┬───────────────────────────┘
                                    │ in-process call
                                    ▼
                 ┌──────────────────────────────────────────────┐
                 │  WalletService (6 methods)                   │
                 │  transfer / createReservation /              │
                 │  flushReservation / adjust / settleTopUp /   │
                 │  expireGrant                                 │
                 │  pg_advisory_xact_lock(customer_id) inside   │
                 │  every balance-changing tx                   │
                 └──────────────────┬───────────────────────────┘
                                    │ LedgerGateway.createTransfer(s)
                                    ▼
                 ┌──────────────────────────────────────────────┐
                 │  pgledger (Phase 7 accounts)                 │
                 │                                              │
                 │  customer.{cid}.available.purchased          │
                 │  customer.{cid}.available.granted            │
                 │  customer.{cid}.reserved                     │
                 │  customer.{cid}.consumed                     │
                 │                                              │
                 │  platform.{pid}.funding.topup                │
                 │  platform.{pid}.funding.promo                │
                 │  platform.{pid}.funding.plan_credit          │
                 │  platform.{pid}.funding.manual               │
                 └──────────────────────────────────────────────┘
```

No per-event ledger write. No second DO. No HTTP shim. No happy-path cron.

---

## Guardrails

- **All amounts at scale 8.** No `*_cents` columns, no `*Cents` fields.
- **Strict reservation only.** No soft-overage paths.
- **Zero ledger writes per priced event.** DO absorbs events; ledger sync is amortized.
- **Priority drain is law.** `granted` before `purchased`, always. FIFO by expiry within `granted`.
- **Grant tracking invariant.** `SUM(wallet_grants.remaining_amount WHERE active)` == `available.granted` balance. Nightly check.
- **No cached balance columns** anywhere outside the DO's SQLite.
- **No `wallets` balance table.** Balance is the ledger.
- **No postpaid path** in Phase 7 (deferred to Phase 8).
- **Refunds are wallet-credit only** in Phase 7. Refund-to-card is Phase 8.
- **`WalletService` sits on `LedgerGateway` directly.** The existing `LedgerService.postCharge` is deleted in 7.1.
- **No `CustomerFundingDO`.** Serialization is `pg_advisory_xact_lock(hashtext('customer:' || id))`.

---

## Reservation Sizing

Applied in `activateEntitlement`, not in `WalletService`:

```ts
// MINIMUM_FLOOR_AMOUNT = 100_000_000     // $1
// CEILING_AMOUNT       = 1_000_000_000   // $10

initial_allocation_amount = Math.min(
  Math.max(price_per_event_amount * 1000, MINIMUM_FLOOR_AMOUNT),
  CEILING_AMOUNT,
)
```

Refill defaults:
- `refill_threshold_bps = 2000` (20%) for slow meters, `5000` (50%) for high-velocity
- `refill_chunk_amount = initial_allocation_amount / 4`

Both snapshot into `entitlement_reservations` at create time, immutable
for the life of the reservation.

---

## Non-Goals

- **Postpaid / invoice-collected plans.** Phase 8.
- **Dynamic refill chunk sizing.** Static per-meter config. Iterate later.
- **Cross-currency wallets.** One account per currency.
- **Cross-meter spend caps.** Phase 8.
- **Proportional refund attribution.** Refunds return to `purchased` (conservative). Phase 8 can refund proportionally using drain metadata.
- **`platform.revenue` sink.** Revenue is `Σ customer.*.consumed` via SQL.
- **`platform.funding_clearing`** — real escrow. Phase 8. Phase 7 uses typed source accounts.

---

## Cleanup Triggered by This Rewrite

Single migration. No backward compatibility preserved.

### Tables Deleted

- `credit_grants`
- `invoice_items`
- `invoice_credit_applications`
- Any `wallets` / `wallet_*` tables if present

### Tables Created

- `entitlement_reservations` (slice 7.2)
- `wallet_topups` (slice 7.2)
- `wallet_grants` (slice 7.2)

### Code Deleted

- `internal/services/src/ledger/accounts.ts`:
  - `houseAccountKey` and all `house:*` builders → replaced by `platformAccountKey`
  - `grantAccountKey` → gone
  - `customerAccountKey` single form → replaced by `customerAccountKeys` (plural, sub-account bundle)
- `internal/services/src/ledger/gateway.ts`:
  - `seedHouseAccounts` → `seedPlatformAccounts`
  - `ensureCustomerAccount` → `ensureCustomerAccounts` (four-account bundle)
  - `postCharge` → deleted. Callers use `WalletService`
  - `postRefund` → deleted. Callers use `WalletService.adjust`
- Invoice-related: `invoiceItems`, `invoiceCreditApplications`, `creditGrants` table defs → deleted
- `invoices.amountCreditUsed`, `invoices.subtotalCents`, `invoices.paymentAttempts` → dropped
- `invoices.totalCents` → renamed `totalAmount` (scale 8)

### Code Renamed

- Every `house:*` string literal → `platform.*` dot form
- Every `*_cents` column and `*Cents` TS field → `*_amount` / `*Amount`

---

## Execution Slices

### 7.1 — Account Rename and Legacy Teardown

**Goal:** One migration, one code sweep. End state: no `house:*` strings,
no legacy tables, new account key builders in place.

**Migration (single Drizzle migration):**

```sql
-- Drop legacy tables (pre-production cleanup; no data preserved).
DROP TABLE IF EXISTS invoice_items               CASCADE;
DROP TABLE IF EXISTS invoice_credit_applications CASCADE;
DROP TABLE IF EXISTS credit_grants               CASCADE;

-- Slim invoices to header + collection state.
ALTER TABLE invoices DROP COLUMN IF EXISTS amount_credit_used;
ALTER TABLE invoices DROP COLUMN IF EXISTS subtotal_cents;
ALTER TABLE invoices DROP COLUMN IF EXISTS payment_attempts;
ALTER TABLE invoices RENAME COLUMN total_cents TO total_amount;  -- bigint, scale 8

-- Deactivate legacy pgledger accounts (house:*, customer:*:*, grant:*)
```

**Code (`internal/services/src/ledger/accounts.ts`):**

```ts
// Phase 7 account key builders.
// The full CoA lands in Phase 8; widen the unions there.

export type PlatformFundingKind = "topup" | "promo" | "plan_credit" | "manual"

export const platformAccountKey = (
  kind: PlatformFundingKind,
  projectId: string,
): string => `platform.${projectId}.funding.${kind}`

export const customerAccountKeys = (
  customerId: string,
): {
  purchased: string
  granted:   string
  reserved:  string
  consumed:  string
} => ({
  purchased: `customer.${customerId}.available.purchased`,
  granted:   `customer.${customerId}.available.granted`,
  reserved:  `customer.${customerId}.reserved`,
  consumed:  `customer.${customerId}.consumed`,
})

// Convenience: all available sub-accounts for drain ordering
export const customerAvailableKeys = (customerId: string) => [
  `customer.${customerId}.available.granted`,    // drain first
  `customer.${customerId}.available.purchased`,  // drain second
] as const
```

**Normal balance (set at account creation):**
- Credit-normal: all `customer.*` accounts, all `platform.*.funding.*` accounts

**Non-negativity enforced on:** all `customer.*` accounts.

**Seeding:**
- `seedPlatformAccounts(projectId, currency)` — four `platform.{pid}.funding.*` accounts
- `ensureCustomerAccounts(customerId, currency)` — four `customer.{cid}.*` accounts

**Completion check:**

```
rg "house:|house\\." internal/ apps/                            # → empty
rg "grantAccountKey|grant:" internal/services/                  # → empty
rg "credit_grants|invoiceItems|invoiceCreditApplications" internal/db/  # → empty
rg "_cents\\b|Cents\\b" internal/ apps/                         # → empty
```

---

### 7.2 — Schemas: `entitlement_reservations` + `wallet_topups` + `wallet_grants`

Three new tables. All amount columns are `bigint` at scale 8.

```sql
-- Reservation state machine.
CREATE TABLE entitlement_reservations (
  id                      text PRIMARY KEY,
  project_id              text NOT NULL,
  customer_id             text NOT NULL,
  entitlement_id          text NOT NULL,
  allocation_amount       bigint NOT NULL,               -- total ever moved into reserved
  consumed_amount         bigint NOT NULL DEFAULT 0,     -- synced at each flush
  refill_threshold_bps    integer NOT NULL DEFAULT 2000,
  refill_chunk_amount     bigint NOT NULL,
  period_start_at         timestamptz NOT NULL,
  period_end_at           timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  reconciled_at           timestamptz,                   -- NULL = active
  UNIQUE (entitlement_id, period_start_at)
);

-- Top-up state machine.
CREATE TYPE wallet_topup_status AS ENUM ('pending', 'completed', 'failed', 'expired');

CREATE TABLE wallet_topups (
  id                      text PRIMARY KEY,
  project_id              text NOT NULL,
  customer_id             text NOT NULL,
  provider                text NOT NULL,                 -- 'stripe' | 'polar' | 'sandbox'
  provider_session_id     text NOT NULL,
  requested_amount        bigint NOT NULL,               -- scale 8
  currency                text NOT NULL,
  status                  wallet_topup_status NOT NULL,
  settled_amount          bigint,
  ledger_transfer_id      text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  UNIQUE (provider, provider_session_id)
);

CREATE INDEX ON wallet_topups (customer_id, created_at DESC);
CREATE INDEX ON wallet_topups (status, created_at) WHERE status = 'pending';

-- Grant/credit tracking (attribution + expiration).
CREATE TABLE wallet_grants (
  id                      text PRIMARY KEY,
  project_id              text NOT NULL,
  customer_id             text NOT NULL,
  source                  text NOT NULL,                 -- 'promo' | 'plan_included' | 'trial' | 'manual'
  issued_amount           bigint NOT NULL,               -- scale 8, what was originally credited
  remaining_amount        bigint NOT NULL,               -- scale 8, what hasn't been consumed or expired
  expires_at              timestamptz,                   -- NULL = never expires
  expired_at              timestamptz,                   -- set when expiration job runs
  voided_at               timestamptz,                   -- set when manually voided by operator
  ledger_transfer_id      text NOT NULL,                 -- the original credit transfer
  metadata                jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, ledger_transfer_id)
);

CREATE INDEX ON wallet_grants (customer_id, expires_at)
  WHERE expired_at IS NULL AND voided_at IS NULL;
CREATE INDEX ON wallet_grants (expires_at)
  WHERE expired_at IS NULL AND voided_at IS NULL AND remaining_amount > 0;
```

---

### 7.3 — `WalletService` Primitives

File: `internal/services/src/wallet/service.ts`. Six methods.

Every method wraps its transfers in one pgledger transaction with
`pg_advisory_xact_lock(hashtext('customer:' || :customer_id))`.

```ts
export type WalletDeps = {
  services: Pick<ServiceContext, "ledgerGateway">
  db:       Database
  logger:   AppLogger
}

export class WalletService {
  constructor(private deps: WalletDeps) {}

  // Generic balance-moving primitive. Callers provide account keys.
  // When destination is customer.consumed, metadata MUST include
  // statement_key AND kind.
  transfer(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    fromAccountKey: string; toAccountKey: string
    amount: number
    metadata: Record<string, unknown>
    idempotencyKey: string
  }): Promise<Result<void, WalletError>>

  // Open a reservation with priority drain.
  // 1. Drain available.granted (FIFO by expiry via wallet_grants)
  // 2. Drain available.purchased (remainder)
  // 3. INSERT entitlement_reservations row
  // Partial fulfillment if total available < requested.
  createReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    entitlementId: string; requestedAmount: number
    refillThresholdBps: number; refillChunkAmount: number
    periodStartAt: Date; periodEndAt: Date
    idempotencyKey: string
  }): Promise<Result<{
    reservationId: string
    allocationAmount: number
    drainLegs: DrainLeg[]  // attribution: which grants/sources funded this
  }, WalletError>>

  // Flush consumed + refill with priority drain.
  // Mid-period: flush reserved→consumed, refill available→reserved
  // Final: flush + return remainder to available.purchased
  flushReservation(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    reservationId: string; flushSeq: number
    flushAmount: number
    refillChunkAmount: number
    statementKey: string
    final: boolean
  }): Promise<Result<{
    grantedAmount: number
    flushedAmount: number
    refundedAmount: number
  }, WalletError>>

  // Issue or claw back credits. Positive = issue, negative = claw back.
  // Positive adjustments create a wallet_grants row when source is
  // 'promo', 'plan_included', 'trial', or 'manual' (with expiresAt).
  // Negative adjustments drain from the appropriate sub-account.
  adjust(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    signedAmount: number; actorId: string; reason: string
    source: "promo" | "purchased" | "plan_included" | "manual" | "trial"
    idempotencyKey: string
    expiresAt?: Date    // only for granted credits
  }): Promise<Result<{
    clampedAmount: number
    unclampedRemainder: number
    grantId?: string     // wallet_grants row id, if created
  }, WalletError>>

  // Settle a provider-confirmed top-up.
  // platform.{pid}.funding.topup → customer.{cid}.available.purchased
  settleTopUp(input: {
    projectId: string; customerId: string; currency: CurrencyCode
    providerSessionId: string
    paidAmount: number
    idempotencyKey: string
  }): Promise<Result<{
    topupId: string
    ledgerTransferId: string
  }, WalletError>>

  // Expire a grant: clawback remaining from available.granted.
  // customer.{cid}.available.granted → platform.{pid}.funding.{source}
  expireGrant(tx: Transaction, input: {
    customerId: string; projectId: string
    grantId: string
    amount: number
    source: string
    idempotencyKey: string
  }): Promise<Result<void, WalletError>>
}
```

**What the CoA §7.6 names map to:**

| CoA name | Phase 7 call | Phase |
|---|---|---|
| `recharge` | `settleTopUp` (webhook-driven) | 7 |
| `transferAvailableToReserved` | `createReservation` (multi-leg drain) | 7 |
| `releaseReservation` | `flushReservation({ final: true, flushAmount: 0 })` | 7 |
| `captureReservation` | `flushReservation({ final: true })` | 7 |
| `refundToWallet` | `adjust({ signedAmount: -N, source: "manual" })` | 7 |
| `chargeSubscriptionFee` | `transfer(available.purchased → consumed)` | 7 |
| `grantPromoCredits` | `adjust({ signedAmount: +N, source: "promo", expiresAt })` | 7 |
| `grantPlanCredits` | `adjust({ signedAmount: +N, source: "plan_included", expiresAt })` | 7 |
| `expireGrant` | `expireGrant()` | 7 |
| `refundExternal` | *(requires `platform.refund_clearing`)* | 8 |
| `settleReceivable` | *(requires `customer.receivable`)* | 8 |

---

### 7.4 — DO Allocation-Aware Hot Path

Add columns to the DO's `meter_window` SQLite table (not a second table):

```sql
reservation_id               text NULL
allocation_amount            bigint NOT NULL DEFAULT 0
consumed_amount              bigint NOT NULL DEFAULT 0
flushed_amount               bigint NOT NULL DEFAULT 0
refill_threshold_bps         integer NOT NULL DEFAULT 2000
refill_chunk_amount          bigint NOT NULL DEFAULT 0
refill_in_flight             integer NOT NULL DEFAULT 0  -- bool
flush_seq                    integer NOT NULL DEFAULT 0
pending_flush_seq            integer NULL
```

Hot path:

```ts
const local = new LocalReservation(
  thresholdFromBps(w.allocationAmount, w.refillThresholdBps),
  w.refillChunkAmount,
)

const state = { allocationAmount: w.allocationAmount, consumedAmount: w.consumedAmount }
const result = local.applyUsage(state, pricedFact.amount)

if (!result.isAllowed) {
  throw new EntitlementWindowWalletEmptyError({
    eventId: event.id,
    reservationId: w.reservationId,
  })
}

// SYNCHRONOUS SQLite write BEFORE any await.
this.db.update(meterWindowTable).set({
  consumedAmount: result.newState.consumedAmount,
}).run()

if (result.needsRefill && !w.refillInFlight) {
  const nextSeq = w.flushSeq + 1
  this.db.update(meterWindowTable).set({
    refillInFlight: 1,
    pendingFlushSeq: nextSeq,
  }).run()
  ctx.waitUntil(this.requestFlushAndRefill({
    flushSeq: nextSeq,
    flushAmount: result.newState.consumedAmount - w.flushedAmount,
    refillChunkAmount: result.refillRequestAmount,
  }))
}
```

Denial enum: `LIMIT_EXCEEDED | SPEND_CAP_EXCEEDED | WALLET_EMPTY | RECOVERY_REQUIRED`.

---

### 7.5 — In-Process Flush + Refill

The DO imports `WalletService` and a Neon serverless Postgres client in
its constructor. Flush is an in-process call, not HTTP.

```ts
private async requestFlushAndRefill(input: {
  flushSeq: number
  flushAmount: number
  refillChunkAmount: number
}) {
  const w = this.readWindow()

  const result = await this.walletService.flushReservation({
    projectId:         w.projectId,
    customerId:        w.customerId,
    currency:          w.currency,
    reservationId:     w.reservationId,
    flushSeq:          input.flushSeq,
    flushAmount:       input.flushAmount,
    refillChunkAmount: input.refillChunkAmount,
    statementKey:      `${w.reservationId}:${w.periodEndAt}`,
    final:             false,
  })

  if (result.err) {
    this.logger.error("flush failed", { error: result.err.message })
    this.db.update(meterWindowTable).set({ refillInFlight: 0 }).run()
    return
  }

  const newState = this.localReservation.applyRefill(
    { allocationAmount: w.allocationAmount, consumedAmount: w.consumedAmount },
    result.val.grantedAmount,
  )
  this.db.update(meterWindowTable).set({
    allocationAmount: newState.allocationAmount,
    flushedAmount:    w.flushedAmount + result.val.flushedAmount,
    flushSeq:         input.flushSeq,
    pendingFlushSeq:  null,
    refillInFlight:   0,
  }).run()
}
```

**Crash recovery:** On DO wake, if `pending_flush_seq IS NOT NULL AND
pending_flush_seq > flush_seq`, re-issue the call with the same seq.
Idempotency table returns the prior result.

---

### 7.6 — Top-Ups and Promo Grants

**Top-ups:** Two-step flow (initiate via tRPC, settle via webhook).
See "The Top-Up Primitive" section above for full flow.

**Promo grants:** `adjust({signedAmount: +N, source: "promo", expiresAt?})`:

```
platform.{pid}.funding.promo → customer.{cid}.available.granted : N
  metadata: { flow: "adjust", source: "promo", grant_id: "wgr_xxx",
              expires_at: "2025-06-01T00:00:00Z" }
```

Creates a `wallet_grants` row with `source = "promo"`, `issued_amount = N`,
`remaining_amount = N`, `expires_at = expiresAt`.

**Grants as a read path:**

```sql
-- All active grants for a customer
SELECT
  id,
  source,
  issued_amount,
  remaining_amount,
  expires_at,
  created_at,
  metadata
FROM wallet_grants
WHERE customer_id = $1
  AND expired_at IS NULL
  AND voided_at IS NULL
ORDER BY COALESCE(expires_at, 'infinity'::timestamptz) ASC;
```

**Grant history (including expired):**

```sql
SELECT
  id,
  source,
  issued_amount,
  remaining_amount,
  expires_at,
  expired_at,
  voided_at,
  created_at
FROM wallet_grants
WHERE customer_id = $1
ORDER BY created_at DESC;
```

---

### 7.7 — Alarm-Driven Final Flush

Three triggers converge on the same final flush:

```ts
async alarm() {
  await this.flushOutboxToTinybird()

  const w = this.readWindow()
  if (!w.reservationId || w.recoveryRequired) {
    await this.scheduleAlarm(/* next wake */)
    return
  }

  const now = Date.now()
  const isPeriodEnd       = now >= w.periodEndAt
  const isInactive        = now - w.lastEventAt > INACTIVITY_THRESHOLD_MS
  const isDeletionPending = w.deletionRequested

  if (isPeriodEnd || isInactive || isDeletionPending) {
    await this.finalFlush(w)
    if (isDeletionPending) {
      await this.ctx.storage.deleteAll()
      return
    }
  }

  await this.scheduleAlarm(/* next wake */)
}

private async finalFlush(w: Window) {
  const unflushed = w.consumedAmount - w.flushedAmount
  const nextSeq   = w.flushSeq + 1

  this.db.update(meterWindowTable).set({ pendingFlushSeq: nextSeq }).run()

  const result = await this.walletService.flushReservation({
    projectId:         w.projectId,
    customerId:        w.customerId,
    currency:          w.currency,
    reservationId:     w.reservationId,
    flushSeq:          nextSeq,
    flushAmount:       unflushed,
    refillChunkAmount: 0,
    statementKey:      `${w.reservationId}:${w.periodEndAt}`,
    final:             true,
  })

  if (result.err) {
    this.logger.error("final flush failed", { error: result.err.message })
    return
  }

  this.db.update(meterWindowTable).set({
    reservationId:   null,
    flushedAmount:   w.flushedAmount + result.val.flushedAmount,
    flushSeq:        nextSeq,
    pendingFlushSeq: null,
  }).run()
}
```

---

### 7.8 — Invoice Projection (inline filter, no view)

Ledger is the single source of truth for invoice lines:

```sql
SELECT
  e.metadata->>'statement_key'               AS statement_key,
  e.id                                        AS entry_id,
  (e.metadata->>'kind')                       AS kind,
  (e.metadata->>'description')                AS description,
  (e.metadata->>'quantity')::numeric          AS quantity,
  e.amount                                    AS amount_total,
  e.created_at
FROM pgledger_entries_view e
WHERE e.project_id      = $1
  AND e.metadata->>'statement_key' = $2
  AND e.account_kind    = 'customer_consumed'
  AND e.direction       = 'credit'
  AND (e.metadata->>'kind') IS NOT NULL;
```

**Contract:** A transfer is an invoice line iff it credits
`customer.{cid}.consumed` AND carries `metadata.statement_key` AND
`metadata.kind`.

---

### 7.9 — API Endpoints

Two read endpoints:

- `GET /v1/wallet` — returns:
  ```json
  {
    "available": {
      "purchased": 500000000,
      "granted": 200000000,
      "total": 700000000
    },
    "reserved": 100000000,
    "consumed": 300000000,
    "grants": [
      {
        "id": "wgr_xxx",
        "source": "promo",
        "issued_amount": 500000000,
        "remaining_amount": 200000000,
        "expires_at": "2025-06-01T00:00:00Z"
      }
    ]
  }
  ```

- `GET /v1/invoices/:id` — header + ledger projection lines.

---

### 7.10 — Tests

**Unit (`LocalReservation`, pure):**
- `applyUsage` allowed, denied, exact-match paths
- Threshold boundary: `needsRefill` flips correctly
- `applyRefill` increments allocation only
- `getCaptureMath` with/without unused remainder

**Unit (`WalletService`):**
- `createReservation` — priority drain: `granted` first, `purchased` second
- `createReservation` — FIFO within granted: soonest-expiring grant drained first
- `createReservation` — partial fulfillment when total available < requested
- `createReservation` — wallet_grants.remaining_amount decremented correctly
- `flushReservation` mid-period — flush + multi-leg refill
- `flushReservation` final — flush + refund to `purchased`
- `adjust` positive with `expiresAt` — creates wallet_grants row + credits `available.granted`
- `adjust` positive without `expiresAt` — credits `available.purchased` (source: "purchased")
- `settleTopUp` — credits `available.purchased`, idempotent
- `expireGrant` — clawback from `available.granted`, mark expired

**Unit (`drainGrantedFIFO`):**
- 3 grants with different expiry → drained in expiry order
- Grant with `remaining_amount = 0` → skipped
- Partial drain within a single grant
- Drain exceeds all grants → returns what's available

**Integration (grant expiration):**
- Grant issued → partially consumed → expiry fires → remaining clawed back
- Grant issued → fully consumed → expiry fires → clawback = 0, no-op
- Grant issued → expiry fires concurrently with drain → advisory lock serializes

**Integration (DO):**
- `apply()` increments consumed; below threshold triggers flush
- `WALLET_EMPTY` denial when cost > remaining
- Crash recovery: pending_flush_seq re-issued on wake
- Period end → final flush → reservation cleared
- Zero ledger writes per event (regression guard)

**E2E:**
- Top-up → settleTopUp → `available.purchased` credited → DO refill picks it up
- Promo grant with expiry → partially consumed → expired → remainder clawed back
- Invoice projection lines sum to `invoices.total_amount`

---

### 7.11 — Reconciliation Cron

Nightly job. Five checks:

**1. Grant tracking invariant:**

```sql
-- For each customer: SUM(wallet_grants.remaining_amount) must equal
-- the available.granted account balance.
-- Expected: 0 drift per customer.
SELECT
  wg.customer_id,
  SUM(wg.remaining_amount) AS grant_sum,
  a.balance AS ledger_balance,
  SUM(wg.remaining_amount) - a.balance::bigint AS drift
FROM wallet_grants wg
JOIN pgledger_accounts_view a
  ON a.name = 'customer.' || wg.customer_id || '.available.granted'
WHERE wg.expired_at IS NULL
  AND wg.voided_at IS NULL
GROUP BY wg.customer_id, a.balance
HAVING SUM(wg.remaining_amount) != a.balance::bigint;
```

**2. Wallet identity check:**

```sql
-- available.purchased + available.granted + reserved + consumed
--   == Σ all inflows - Σ all outflows
-- Expected: 0 drift.
```

**3. Stranded reservation sweep:**

```sql
SELECT id, customer_id, entitlement_id, period_end_at
FROM entitlement_reservations
WHERE reconciled_at IS NULL
  AND period_end_at < now() - interval '1 hour';
```

**4. Stranded top-up sweep:**

```sql
SELECT id, customer_id, provider_session_id, created_at
FROM wallet_topups
WHERE status = 'pending'
  AND created_at < now() - interval '24 hours';
```

**5. Invoice-projection orphan check:**

```sql
SELECT count(*)
FROM pgledger_entries_view
WHERE account_kind = 'customer_consumed'
  AND direction    = 'credit'
  AND (metadata->>'statement_key' IS NULL OR metadata->>'kind' IS NULL);
```

**6. Grant expiration sweep:**

Runs more frequently (every 5 minutes) as a separate scheduled job:

```sql
SELECT id, customer_id, project_id, source, remaining_amount
FROM wallet_grants
WHERE expired_at IS NULL
  AND voided_at IS NULL
  AND remaining_amount > 0
  AND expires_at <= now();
```

For each: call `walletService.expireGrant()` in a transaction.

---

### 7.12 — Activation Hook

File: `internal/services/src/use-cases/subscriptions/activate-subscription.ts`.

One use case owns the transition to `active` for a new billing period.
It is the **only** caller of `walletService.createReservation`.

```ts
export type ActivateSubscriptionInput = {
  subscriptionId: string
  periodStartAt:  Date
  periodEndAt:    Date
  idempotencyKey: string
}

export type ActivateSubscriptionOutput = {
  subscriptionId: string
  reservations: Array<{
    entitlementId:    string
    reservationId:    string
    allocationAmount: number
    drainLegs:        DrainLeg[]
  }>
}
```

**Transaction boundary.** Everything in one `db.transaction`:

1. `SELECT pg_advisory_xact_lock(hashtext('customer:' || customerId))`
2. `subscriptionService.markActive(subscriptionId, periodStartAt, periodEndAt)`
3. Issue plan-included credits:
   `walletService.adjust({ source: "plan_included", expiresAt: periodEndAt })`
   → credits `available.granted` + creates `wallet_grants` row
4. Charge base fee (if any):
   `walletService.transfer(available.purchased → consumed)`
5. For each metered entitlement:
   `walletService.createReservation({ ... })`
   → priority drain from `granted` then `purchased`
6. Commit.

**Zero-balance policy.** If `available.purchased + available.granted <
Σ requestedAmount` at activation, return `InsufficientFundsError`.
All-or-nothing. No partial activation.

---

## Entity Relationship Graph

```
┌─────────────┐     ┌────────────────────────┐     ┌───────────────┐
│ subscription │────►│ entitlement_reservations │◄────│ wallet_grants │
│              │     │                        │     │               │
│ id           │     │ id                     │     │ id            │
│ customer_id  │     │ customer_id            │     │ customer_id   │
│ status       │     │ entitlement_id         │     │ source        │
│              │     │ allocation_amount      │     │ issued_amount │
│              │     │ consumed_amount        │     │ remaining_amt │
│              │     │ period_start_at        │     │ expires_at    │
│              │     │ period_end_at          │     │ expired_at    │
│              │     │ reconciled_at          │     │ ledger_xfer_id│
│              │     └────────────────────────┘     └───────────────┘
│              │                                           │
│              │     ┌──────────────┐                      │
│              │     │ wallet_topups │                      │
│              │     │              │     ┌────────────────────────────┐
│              │     │ id           │     │  pgledger accounts         │
│              │     │ customer_id  │     │                            │
│              │     │ provider     │     │  customer.{cid}            │
│              │     │ status       │     │    .available.purchased    │
│              │     │ settled_amt  │     │    .available.granted      │
└──────────────┘     └──────────────┘     │    .reserved              │
                                          │    .consumed              │
       ┌──────────────────────┐           │                            │
       │  grants (entitlement) │           │  platform.{pid}.funding   │
       │  (UNCHANGED)          │           │    .topup                 │
       │                      │           │    .promo                 │
       │  id                  │           │    .plan_credit           │
       │  feature_plan_ver_id │           │    .manual                │
       │  subject_id          │           └────────────────────────────┘
       │  type (sub/trial/...) │
       │  priority            │
       │  limit               │
       │  effective_at        │
       │  expires_at          │
       └──────────────────────┘
```

**Two separate grant concepts:**
- `grants` (entitlement layer): "You can USE X amount of feature Y" — quantity/access rights
- `wallet_grants` (funding layer): "You have $X to SPEND" — money attribution + expiration

They do NOT merge. A subscription activation creates BOTH:
- Entitlement grants (existing flow, unchanged)
- Wallet grants (new: plan-included credits with expiry)

---

## Risks

**Refill latency under burst.** Per-meter `refill_threshold_bps` config.
Hot meters use 50%+ with larger chunks.

**Refill races at wallet-empty boundary.** Advisory lock serializes; the
second reader sees updated balance and partial-fills.

**DO eviction mid-flush.** `pending_flush_seq` survives in SQLite. On
wake, re-issues with same seq via idempotency.

**Grant expiration races consumption.** Advisory lock serializes. Expiry
re-reads `remaining_amount` inside lock. If already consumed, clawback = 0.

**Top-up webhook arrives before row INSERT.** INSERT commits before
`createCheckoutSession` is called. `settleTopUp` treats missing-row as
typed error.

**Operator changes threshold/chunk mid-period.** Active reservations
carry immutable snapshot. Changes take effect next period.

**`platform.{pid}.funding.*` drift.** Expected in Phase 7 (no payout
reconciliation). Nightly check excludes it.

**FIFO drain may not match user expectation.** Users might expect
newest grants consumed first. FIFO (soonest-expiring) is correct because
it minimizes waste from expiration.

---

## Rollout

Single rollout, no feature flag. Deploy order:

1. Migration: 7.1 (rename, teardown) + 7.2 (new tables)
2. Deploy `LocalReservation` + `WalletService` (7.3)
3. Deploy DO with allocation-aware apply + flush + alarm (7.4 + 7.5 + 7.7)
4. Activation hook (7.12)
5. Top-up wiring (7.6): tRPC + webhook → `settleTopUp`
6. Grant expiration job (7.11 §6)
7. Nightly cron (7.11 §1-5)
8. API / SDK updates (7.9)

No back-fill. No dual-write.

---

## Related

- [`../pgledger-ai-wallet-coa.md`](../pgledger-ai-wallet-coa.md) — updated in this PR
- [Phase 6.6 — pgledger gateway](./unprice-phase-06.6-new-ledger.md)
- [Phase 6.7 — agent billing simplification](./unprice-phase-06.7-agent-billing-simplification.md)
- [Phase 8 — financial guardrails & postpaid](./unprice-phase-08-financial-guardrails.md) — adds postpaid, proportional refund attribution, cross-meter spend caps, external refunds
