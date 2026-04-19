# Phase 7: Credits, Wallets & Reservation-Based Allocation

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
PR title: `feat: add credits, wallets, and reservation-based allocation`
Branch: `feat/credits-wallets`

**Prerequisite:** [Phase 6.6 — pgledger gateway](./unprice-phase-06.6-new-ledger.md)
ships the `LedgerGateway` and house accounts. [Phase 6.7 — agent billing
simplification](./unprice-phase-06.7-agent-billing-simplification.md) strips
billing, rating, and the Postgres client out of `EntitlementWindowDO`. Phase 7
extends the simplified DO — it does not untangle a tangled one.

## Mission

Add prepaid wallets and credit grants to Unprice using a **reservation /
allocation** pattern. At entitlement activation, a worker pulls an allocation
from the customer's funding accounts (wallet, credits) in priority order and
hands a chunk of that allocation to `EntitlementWindowDO`. The DO decrements
the allocation locally per priced fact. When remaining drops below threshold,
the DO requests a refill. At period end, unused allocation reconciles back.

Ledger writes per customer per period: ~3–10. Not millions.

The previous phase-7 framing (`WalletDO` + `SettlementRouter`) is superseded.
A runtime router that decides per-event whether to write to the ledger is a
sign the underlying primitive (reservation) hadn't been recognized yet. This
rewrite removes it.

## Outcome

- `wallets`, `credit_grants`, `credit_burn_rates`, `entitlement_reservations`,
  and `reservation_refills` tables exist.
- `WalletService` owns allocation operations: `createReservation`,
  `refillReservation`, `reconcileReservation`, `topUpWallet`.
- `EntitlementWindowDO` gains `allocation_cents` and
  `allocation_remaining_cents` in SQLite; hot path denies on either
  `LIMIT_EXCEEDED`, `SPEND_CAP_EXCEEDED`, or `WALLET_EMPTY`.
- A `CustomerFundingDO` (one per customer) serializes refills across all
  meter DOs owned by that customer.
- Prepaid and postpaid entitlements run the **same DO code path**. The branch
  is at entitlement creation, not at runtime.
- Credits are a funding source that composes through the same priority order
  as wallets. Grant expiry transfers remaining balance to
  `house:expired_credits`.

## Dependencies

- **Phase 5** for settlement webhooks (credit purchase confirmation).
- **Phase 6.6** for `LedgerGateway.createTransfers` and seeded house
  accounts (`house:credit_issuance`, `house:expired_credits`, and the new
  `house:postpaid_accrual` seeded here).
- **Phase 6.7** for a DO that already emits priced facts via CF Queue,
  already enforces per-meter spend caps, and has no billing loop in its
  alarm.

Phases 4, 5, 6.5 wallet/settlement scaffolding was removed from the tree in
earlier cleanup. This phase does not resurrect it.

## Read First

- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
  — post-6.7 shape. Phase 7 extends the SQLite schema and `applyEventSync`.
- [../../internal/services/src/ledger/gateway.ts](../../internal/services/src/ledger/gateway.ts)
  — the only path into pgledger.
- [../../internal/services/src/ledger/accounts.ts](../../internal/services/src/ledger/accounts.ts)
  — account key builders (`customerAccountKey`, `grantAccountKey`,
  `houseAccountKey`).
- [../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts](../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts)
  — credit purchase webhook entry point.

## The Reservation Primitive

The whole phase turns on one idea.

**A reservation is a chunk of funded money that the DO is authorized to
consume locally, without phoning home per event.**

Creation:

```
wallet → reserved   (one pgledger transfer, amount = allocation_cents)
```

Consumption:

```
DO.apply(event)
  ├─ compute priced fact (from Phase 6.7 snapshotted rate card)
  ├─ allocation_remaining -= amount_cents  (DO SQLite, local)
  └─ enqueue priced fact to billing queue
```

Refill (when `allocation_remaining < threshold × allocation_cents`):

```
DO → reservation-refill-queue → CustomerFundingDO → WalletService
  WalletService:
    wallet → reserved  (one pgledger transfer, amount = refill_chunk_cents)
  returns new allocation_remaining to DO via RPC
```

Reconciliation (period end):

```
Cron reads DO.consumed_cents
WalletService.reconcileReservation:
  reserved → wallet   (one pgledger transfer, amount = allocation - consumed)
```

**Ledger writes per customer per period:** reservation creation (1) + N
refills (typically 2–5) + reconciliation (1). The DO absorbs N-thousand
events without touching Postgres.

**Overdraft bound:** `refill_chunk × concurrent_meters_per_customer`. A
customer with 3 hot meters and a $1 refill chunk can overrun by at most $3
while refills race. Tune refill chunk per meter velocity.

## Prepaid vs Postpaid: One Code Path

The DO does not know which mode it is in. It decrements `allocation_remaining`
and requests refills. The difference lives entirely in **how the reservation
is funded**.

### Prepaid (wallet-backed)

Funding order at reservation creation:

1. `customer:<id>:credit:<grant_id>` accounts (expiring-soonest first).
2. `customer:<id>:wallet`.

If the customer's total balance across credits + wallet is less than
`requested_cents`, the reservation is created at whatever balance is
available, and the DO denies `WALLET_EMPTY` once that's consumed.

### Postpaid (invoice at period end)

Funding order at reservation creation:

1. `house:postpaid_accrual` — a house-side "we'll invoice for this later"
   account. Always has infinite available balance.

The DO sees the same `allocation_cents` primitive. Refills always succeed.
At period end, `reserved` account balance equals consumed amount; that
becomes an invoice line item. The funds move
`reserved → customer:<id>:invoice_receivable` on invoice issuance, then
`receivable → house:revenue` on payment.

### Why this collapses cleanly

The DO holds a reservation. The reservation holds money that was moved out
of some funding source. Prepaid = funding source is the customer; postpaid =
funding source is the house. Both are just pgledger accounts. The DO
doesn't care.

**This replaces the SettlementRouter.** There is no runtime decision per
event. The decision is "which funding accounts to pull from" at reservation
creation, and that's static per entitlement (derived from the plan version).

## Credits as Funding Sources

Credit grants are pgledger accounts, not a separate subsystem.

### Grant issuance

```
house:credit_issuance → customer:<id>:credit:<grant_id>  (one transfer)
```

The `credit_grants` table records metadata:

- `source` — `promo`, `manual`, `plan_included`, `purchased`.
- `expiresAt` — nullable.
- `priority` — integer; lower = consumed first.
- `burnRateMultiplierBps` — e.g., `15000` = 1.5× wallet rate (AI cost
  volatility fix; operator raises this when model costs spike).

### Grant consumption

When `WalletService.createReservation` or `refillReservation` runs, it
queries all grant accounts for the customer, ordered by
`(expiresAt ASC NULLS LAST, priority ASC)`. It transfers from grants first,
wallet last. Grant balance = pgledger `getAccountBalance(grantAccountKey)`.
No cached remaining column.

### Grant expiry

Cron at `expiresAt`:

```
customer:<id>:credit:<grant_id> → house:expired_credits  (one transfer)
```

One ledger entry per grant per expiry. No per-event accounting.

### Burn rate multipliers

When a grant with `burnRateMultiplierBps = 15000` funds a reservation, the
reservation records `burn_rate_bps = 15000`. The DO's priced-fact math scales
`amount_cents` by the multiplier before decrementing `allocation_remaining`.
`$1.00` of consumption at 1.5× burns `$1.50` of allocation.

This means: if you issued $10 of promo credits and the burn rate is 2×, the
customer effectively gets $5 of usage. Operator adjusts the multiplier when
underlying costs shift. Customer contract is unchanged.

## The CustomerFundingDO

One DO instance per customer. Its job: serialize refill requests across all
meter DOs for that customer.

### Why it exists

`EntitlementWindowDO` is sharded per `(customer, meter)`. A customer with 5
concurrent hot meters will have 5 DOs independently requesting refills. If
they all hit `WalletService.refillReservation` concurrently, pgledger
transfers work (pgledger handles concurrency correctly via row versioning),
but you get thrashing: two refills race for the last dollar in the wallet,
one succeeds, the other retries.

`CustomerFundingDO` linearizes these requests. Each meter DO sends its
refill request to the customer's funding DO. The funding DO calls
`WalletService.refillReservation` one at a time, returns results to each
meter DO. Race-free by construction.

### Shape

```ts
export class CustomerFundingDO extends DurableObject {
  // No persistent state — it's a serialization point.
  // Refill state lives in pgledger (authoritative) and the meter DO
  // (consumption tracking).

  async requestRefill(input: {
    reservationId: string
    requestedCents: number
  }): Promise<RefillResult> {
    // Call WalletService.refillReservation
    // Return allocation delta or DENIED
  }
}
```

No alarm, no SQLite. It's a mutex with RPC surface. Cloudflare bills per
invocation, not per instance-hour, so one-per-customer is cheap.

### Why not a Postgres advisory lock?

- Adds a round-trip to Postgres before the refill transfer.
- Works, but couples the serialization primitive to the DB connection pool.
- DO-based serialization is co-located with the meter DOs that trigger it —
  lower latency, no pool exhaustion under burst.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │     EntitlementWindowDO             │
                    │  (per customer+meter, from 6.7)      │
                    │                                      │
  event ───────────►│  apply():                            │
                    │    ├─ priced fact (snapshotted)      │
                    │    ├─ allocation_remaining -= amt    │
                    │    ├─ if remaining < threshold:       │
                    │    │     request refill               │
                    │    └─ emit priced fact → billing Q   │
                    └────────┬─────────────────────────────┘
                             │ refill request (RPC)
                             ▼
                    ┌─────────────────────────────────────┐
                    │     CustomerFundingDO               │
                    │  (per customer, serialization only) │
                    └────────┬─────────────────────────────┘
                             │ WalletService.refillReservation
                             ▼
                    ┌─────────────────────────────────────┐
                    │         WalletService                │
                    │  (Postgres + LedgerGateway)          │
                    │                                      │
                    │  funding priority:                   │
                    │    1. credits (expiring first)       │
                    │    2. wallet (prepaid)               │
                    │       OR                             │
                    │    1. house:postpaid_accrual         │
                    │       (postpaid)                     │
                    └────────┬─────────────────────────────┘
                             │ createTransfers([])
                             ▼
                    ┌─────────────────────────────────────┐
                    │      pgledger (via LedgerGateway)   │
                    │  customer:<id>:wallet                │
                    │  customer:<id>:credit:<grant_id>     │
                    │  customer:<id>:reserved:<ent_id>     │
                    │  house:credit_issuance               │
                    │  house:expired_credits               │
                    │  house:postpaid_accrual              │
                    └─────────────────────────────────────┘
```

## Guardrails

- Reservation is the only primitive. No `SettlementRouter`. Prepaid/postpaid
  is a funding strategy chosen at activation, not a runtime dispatch.
- DO is authoritative for allocation consumption within its chunk. Ledger is
  authoritative for funding. The reservation is the contract.
- Refill chunk size is the overdraft bound. Expose it in operator config per
  meter. Do not hardcode.
- Credits flow through the same priority machinery as wallets. One algorithm,
  many funding sources.
- `WalletService` does not depend on `LedgerService`. Both sit on
  `LedgerGateway`.
- No cached `balance_cents` / `remaining_cents` columns anywhere. Balance
  reads go through the gateway.

## Execution Slices

### 7.1 — Wallet + credit grant schema

**Tables:**

```sql
CREATE TABLE wallets (
  id              text PRIMARY KEY,
  project_id      text NOT NULL,
  customer_id     text NOT NULL,
  currency        text NOT NULL,
  ledger_account  text NOT NULL,  -- customer:<id>:wallet
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, customer_id, currency)
);

CREATE TABLE credit_grants (
  id                       text PRIMARY KEY,
  project_id               text NOT NULL,
  customer_id              text NOT NULL,
  wallet_id                text NOT NULL REFERENCES wallets(id),
  ledger_account           text NOT NULL,  -- customer:<id>:credit:<grant_id>
  source                   credit_grant_source NOT NULL,
  priority                 integer NOT NULL DEFAULT 100,
  burn_rate_multiplier_bps integer NOT NULL DEFAULT 10000,
  issued_amount_cents      bigint NOT NULL,
  expires_at               timestamptz,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_burn_rates (
  id               text PRIMARY KEY,
  project_id       text NOT NULL,
  scope            credit_burn_rate_scope NOT NULL,  -- global, feature, plan
  scope_id         text,
  multiplier_bps   integer NOT NULL,
  effective_at     timestamptz NOT NULL,
  superseded_at    timestamptz
);
```

**House accounts (seeded via 6.6 `seedHouseAccounts` extension):**

- `house:credit_issuance`
- `house:expired_credits`
- `house:postpaid_accrual` (new in 7.1)

**Validators:** export from `internal/db/src/validators.ts` barrel.

### 7.2 — Reservation schema

```sql
CREATE TABLE entitlement_reservations (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL,
  customer_id          text NOT NULL,
  entitlement_id       text NOT NULL,
  ledger_account       text NOT NULL,  -- customer:<id>:reserved:<ent_id>
  funding_strategy     funding_strategy NOT NULL,  -- prepaid, postpaid
  allocation_cents     bigint NOT NULL,
  consumed_cents       bigint NOT NULL DEFAULT 0,
  status               reservation_status NOT NULL,  -- active, exhausted, reconciled
  refill_threshold_bps integer NOT NULL DEFAULT 2000,  -- 20%
  refill_chunk_cents   bigint NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  reconciled_at        timestamptz
);

CREATE TABLE reservation_refills (
  id                  text PRIMARY KEY,
  reservation_id      text NOT NULL REFERENCES entitlement_reservations(id),
  request_seq         integer NOT NULL,  -- idempotency key within reservation
  requested_cents     bigint NOT NULL,
  granted_cents       bigint NOT NULL,  -- may be less if funds short
  funding_breakdown   jsonb NOT NULL,   -- which accounts funded the refill
  status              refill_status NOT NULL,  -- pending, complete, denied
  denied_reason       text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (reservation_id, request_seq)
);
```

**Why `(reservation_id, request_seq)` unique:** at-least-once delivery from
the meter DO means the same refill request may arrive twice. The DO
increments `request_seq` locally and includes it in the message; duplicate
messages no-op on the unique constraint.

### 7.3 — `WalletService` allocation operations

File: `internal/services/src/wallet/service.ts`.

```ts
class WalletService {
  constructor(private deps: {
    db: Database
    logger: AppLogger
    gateway: LedgerGateway
  }) {}

  async createReservation(input: {
    entitlementId: string
    fundingStrategy: "prepaid" | "postpaid"
    requestedCents: number
    refillChunkCents: number
    refillThresholdBps: number
  }): Promise<Result<Reservation, WalletError>> {
    // 1. Resolve funding order (prepaid: credits by priority, then wallet;
    //    postpaid: house:postpaid_accrual)
    // 2. Query available balance per account via gateway
    // 3. Build transfer list to move funds into reserved account
    // 4. Call gateway.createTransfers — returns on success
    // 5. Insert entitlement_reservations row
    // 6. Return Reservation with allocation_cents (may be < requested)
  }

  async refillReservation(input: {
    reservationId: string
    requestSeq: number
    requestedCents: number
  }): Promise<Result<RefillResult, WalletError>> {
    // 1. Upsert reservation_refills (request_seq unique → idempotent)
    // 2. If already complete: return stored result
    // 3. Run same funding priority order as createReservation
    // 4. gateway.createTransfers — atomic
    // 5. Update refill row, return RefillResult { grantedCents, breakdown }
    //    OR denied reason (WALLET_EMPTY, GRANTS_EXHAUSTED)
  }

  async reconcileReservation(input: {
    reservationId: string
    actualConsumedCents: number
  }): Promise<Result<void, WalletError>> {
    // 1. Read allocation_cents from reservation row
    // 2. unused = allocation - consumed
    // 3. If unused > 0: transfer reserved → source accounts in reverse
    //    priority order (wallet first, then highest-priority credits)
    // 4. Mark reservation reconciled
  }

  async topUpWallet(input: {
    walletId: string
    amountCents: number
    idempotencyKey: string  // usually provider payment id
  }): Promise<Result<void, WalletError>> {
    // 1. gateway.createTransfers: house:credit_issuance → wallet
    // 2. Trigger pending-refill drain (any reservation in WAITING_FOR_FUNDS
    //    gets a refill attempt via CustomerFundingDO)
  }
}
```

**No `LedgerService` import.** `WalletService` and `LedgerService` are
siblings over `LedgerGateway`.

### 7.4 — DO: allocation-aware hot path

Extend `EntitlementWindowDO` SQLite schema:

```ts
export const allocationStateTable = sqliteTable("allocation_state", {
  reservationId:        text("reservation_id").primaryKey(),
  allocationCents:      integer("allocation_cents").notNull(),
  allocationRemaining:  integer("allocation_remaining_cents").notNull(),
  burnRateMultiplierBps:integer("burn_rate_multiplier_bps").notNull().default(10000),
  refillThresholdBps:   integer("refill_threshold_bps").notNull(),
  refillChunkCents:     integer("refill_chunk_cents").notNull(),
  refillInFlight:       integer("refill_in_flight", { mode: "boolean" }).notNull().default(false),
  refillRequestSeq:     integer("refill_request_seq").notNull().default(0),
})
```

Extend `applyEventSync` `beforePersist` hook:

```ts
// After priced fact is computed (Phase 6.7)
const scaledCents = Math.ceil(
  pricedFact.amountCents * allocationState.burnRateMultiplierBps / 10000
)

if (allocationState.allocationRemaining < scaledCents) {
  throw new EntitlementWindowWalletEmptyError({
    eventId: event.id,
    reservationId: allocationState.reservationId,
  })
}

// Decrement locally
allocationState.allocationRemaining -= scaledCents

// Check refill threshold
const threshold = Math.ceil(
  allocationState.allocationCents * allocationState.refillThresholdBps / 10000
)
if (allocationState.allocationRemaining < threshold && !allocationState.refillInFlight) {
  allocationState.refillInFlight = true
  allocationState.refillRequestSeq += 1
  ctx.waitUntil(requestRefill(allocationState.refillRequestSeq))
}
```

`requestRefill` sends an RPC to the customer's funding DO:

```ts
async requestRefill(requestSeq: number): Promise<void> {
  const fundingDO = env.CUSTOMER_FUNDING_DO.get(
    env.CUSTOMER_FUNDING_DO.idFromName(customerId)
  )
  const result = await fundingDO.requestRefill({
    reservationId: allocationState.reservationId,
    requestSeq,
    requestedCents: allocationState.refillChunkCents,
  })
  applyRefillResult(result)  // updates SQLite atomically
}
```

**Denial semantics:** `WALLET_EMPTY` joins the existing denial enum from 6.7
(`LIMIT_EXCEEDED`, `SPEND_CAP_EXCEEDED`).

### 7.5 — Refill worker: `CustomerFundingDO`

File: `apps/api/src/durable-objects/CustomerFundingDO.ts`.

```ts
export class CustomerFundingDO extends DurableObject {
  private walletService: WalletService

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    // Construct WalletService with Postgres + LedgerGateway
  }

  async requestRefill(input: {
    reservationId: string
    requestSeq: number
    requestedCents: number
  }): Promise<RefillResult> {
    // Single-threaded by DO contract.
    // Idempotent via request_seq on reservation_refills table.
    return this.walletService.refillReservation(input)
  }

  async drainPendingRefills(input: {
    walletId: string
  }): Promise<void> {
    // Called from WalletService.topUpWallet when wallet gains balance.
    // Reads reservations in WAITING_FOR_FUNDS state, triggers refill for each.
  }
}
```

**Why this DO owns Postgres access:** `EntitlementWindowDO` does not (Phase
6.7 removed it). `CustomerFundingDO` is a cold-path DO; Postgres access is
appropriate. Its alarm is unused — refills are request-driven.

### 7.6 — Credit purchase flow

Webhook entry (depends on Phase 5):

```
provider webhook
  ↓
processWebhookEvent use case
  ↓
if event.type === "checkout.completed" && metadata.kind === "credit_purchase":
  WalletService.topUpWallet({
    walletId: metadata.walletId,
    amountCents: event.amount,
    idempotencyKey: event.id,
  })
  ↓
gateway.createTransfers([
  { from: house:credit_issuance, to: customer:<id>:wallet, amount }
])
  ↓
CustomerFundingDO.drainPendingRefills({ walletId })
```

Checkout initiation is a use case: `initiateCreditPurchase` → provider
`createCheckoutSession` with metadata `{ kind: "credit_purchase", walletId }`.

### 7.7 — Period-end reconciliation

Cron job `reconcile-reservations`:

```
SELECT * FROM entitlement_reservations
WHERE status = 'active'
  AND period_end_at < now()
```

For each:

```
1. Read consumed_cents from the meter DO (RPC to EntitlementWindowDO)
2. WalletService.reconcileReservation({ reservationId, consumedCents })
3. If postpaid: create invoice line item from consumed_cents
4. Mark reservation reconciled
```

Runs hourly; reservations beyond period end are caught within an hour. Tight
SLO is not required because the DO has already stopped accepting events for
that period.

### 7.8 — API endpoints

- `GET /v1/wallet` — wallet + all grant balances (via gateway).
- `POST /v1/wallet/top-up` — returns provider checkout URL.
- `GET /v1/wallet/reservations` — active reservations across entitlements,
  with live `consumed_cents` from meter DO.
- `GET /v1/wallet/grants` — grants with burn rates and expiry.
- `POST /v1/admin/grants` (operator) — issue manual credit grant.
- `PATCH /v1/admin/burn-rates` (operator) — adjust burn rate.

SDK types updated for all of the above.

### 7.9 — UI

- **Wallet dashboard:** balance (wallet + grants), burn-down chart,
  reservation summary ("X of $Y remaining on Feature Z").
- **Credit purchase:** top-up form, package selection (operator-configured),
  provider checkout redirect.
- **Burn rate editor (operator):** scope (global / feature / plan), versioned
  history, effective-at scheduling.
- **Grant timeline:** issued / consumed / expired per grant.
- **Reservation visibility (customer):** "$487 of $500 remaining. Auto-refill
  triggers at $100."

### 7.10 — Tests

**Unit (service layer):**

- `createReservation`: funding priority order across wallet + 3 grants of
  varying expiry and priority.
- `refillReservation`: idempotency via `request_seq`.
- `refillReservation`: funds short → returns grantedCents < requestedCents.
- `reconcileReservation`: unused flows back in reverse priority order.
- `topUpWallet`: triggers pending-refill drain.

**Integration (DO):**

- `apply` decrements allocation by `amount_cents × burn_rate_multiplier`.
- Remaining below threshold → exactly one refill request (no duplicate
  schedules while `refillInFlight = true`).
- Wallet-empty denial: new events denied with `WALLET_EMPTY`, events in
  flight complete.
- Postpaid ∞-allocation: same DO code, refills always succeed, consumed
  rolls into invoice.

**E2E:**

- Credit purchase → webhook → wallet credit → pending refill drains →
  DO receives new allocation.
- Period end → reconciliation → unused returns to wallet → next period
  reservation starts fresh.
- Grant expiry → balance transfers to `house:expired_credits`, DO's
  allocation unaffected until next refill.

## Non-Goals

- ML-based refill chunk sizing. Ship static per-meter config; iterate from
  data.
- Cross-currency wallets. Same-currency reservations only. Cross-currency
  requires FX accounts in pgledger and is future work.
- Real-time cross-meter spend caps. Phase 8 territory — uses the Tinybird
  aggregate path, not this ledger one.
- "Best-effort" overdraft prevention. Refill chunk size is the bound.
  Document it; do not try to eliminate it via distributed locks.

## Risk & Mitigations

**Risk: refill latency under burst.**
A 10k-RPS meter with a 50% refill threshold can exhaust its 80% runway
before the refill round-trips. Mitigation: per-meter `refill_threshold_bps`
config. Hot meters use 80% threshold (refill early). Combined with larger
chunks for high-velocity meters, the DO stays ahead.

**Risk: refill races at wallet-empty boundary.**
Two concurrent refill requests from different meter DOs on the same customer
both observe "wallet has $5"; both try to pull $3. `CustomerFundingDO`
serializes them — second request sees `$2` after the first completes.
`refillReservation` handles partial fulfilment cleanly.

**Risk: DO eviction loses `refillInFlight` flag.**
The flag is SQLite, not in-memory. Survives eviction. If a DO evicts mid-RPC
and the refill completes in pgledger, the next `apply()` reads the committed
`allocation_remaining_cents` via a lightweight sync call to
`CustomerFundingDO.syncReservation(reservationId)`. Once synced, flag clears.

**Risk: grant expiry races consumption.**
Grant expires while DO has a refill in flight funded by that grant. Mitigation:
`refillReservation` reads grant balance via gateway at transfer time.
Expired grants return 0 balance; refill proceeds with remaining sources. No
data-loss window because the expiry cron only runs on already-expired grants
(monotonic).

**Risk: operator changes burn rate mid-period.**
Active reservations carry a snapshot of `burn_rate_multiplier_bps` at
reservation time. Burn rate changes take effect on the **next refill** (next
chunk reflects new rate). This prevents retroactive burn-rate adjustments
from breaking customer-facing consumption math.

**Risk: postpaid `house:postpaid_accrual` grows unbounded.**
Invoice issuance moves `reserved → receivable`, then payment moves
`receivable → revenue`. Accrual account balance tracks
invoiced-but-unpaid minus paid across the house — standard AR accounting.
Alert on accrual balance above operator-defined threshold (liquidity
concern, not data concern).

## Rollout

Single rollout, no feature flag. Phase 7 lands on a clean tree:

1. Migration adds `wallets`, `credit_grants`, `credit_burn_rates`,
   `entitlement_reservations`, `reservation_refills`.
2. Migration seeds `house:postpaid_accrual`.
3. Deploy `CustomerFundingDO` binding.
4. Deploy DO with allocation-aware `apply` path.
5. Activation workflow (existing) gains a reservation-creation step; flag
   per-plan as "wallet-backed" or "postpaid" (default postpaid for existing
   plans — behaves identically to pre-Phase-7 via infinite allocation).

Existing active entitlements at cutover: run a one-time migration that
creates a postpaid reservation per active entitlement with `allocation_cents
= 0` initial, first event triggers refill, allocation grows from there.

Existing entitlements do not pay any latency cost. The reservation is just a
row pointing at `house:postpaid_accrual`.

## Related

- [Phase 6.6 — pgledger gateway](./unprice-phase-06.6-new-ledger.md)
- [Phase 6.7 — agent billing simplification](./unprice-phase-06.7-agent-billing-simplification.md)
- [Phase 8 — financial guardrails](./unprice-phase-08-financial-guardrails.md)
  (cross-meter spend caps, circuit breakers)
- [Competitor landscape](../ai-billing-competitor-landscape.md) — how Lago,
  OpenMeter, Flexprice, Polar, Metronome approach these problems.
