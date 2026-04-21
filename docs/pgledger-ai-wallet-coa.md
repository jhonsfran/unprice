# pgledger Chart of Accounts — AI Wallet + Reservation System

Single-currency pgledger. Ledger-level only: accounts, naming, allowed transfer paths, invariants. No application tables, services, or orchestration.

---

## 1. Account List

### 1.1 Per-customer accounts — `customer.{customer_id}.*`

| Account | Purpose | Increases when... | Decreases when... | Non-zero long-term? | Customer-visible? |
|---|---|---|---|---|---|
| `customer.{id}.available` | Spendable wallet balance. The only balance the customer can "use". | Wallet recharge, reservation release/expire, refund-to-wallet, positive adjustment | Reservation creation, soft-overage drain, external refund, negative adjustment | Yes — equals current wallet | Yes |
| `customer.{id}.reserved` | Funds earmarked for in-flight work. Still the customer's money, but not spendable. | Reservation creation | Reservation capture, release, expire | Non-zero only while reservations are open; 0 when idle | Yes (as "pending") |
| `customer.{id}.consumed` | Lifetime finalized usage recognized against this customer. | Capture (reserved→consumed), soft-overage drain (available→consumed, receivable→consumed) | Refund-after-consumption | Yes — monotonically grows, only reduced by refunds | Yes (as usage history) |
| `customer.{id}.receivable` | Customer debt — usage we recognized but they haven't funded yet. | Soft-overage shortfall | Receivable settlement (external payment), write-off | 0 in strict model; ≥ 0 in soft-overage | Yes (as "amount owed") |

### 1.2 Shared platform accounts — `platform.*`

| Account | Purpose | Increases when... | Decreases when... | Non-zero long-term? | Customer-visible? |
|---|---|---|---|---|---|
| `platform.funding_clearing` | Counterpart for inbound external funds (Stripe, ACH, etc.). Bridges off-ledger cash into the ledger. | External settlement booked | Credited into `customer.available` or `customer.receivable` | Transient — must clear to 0 per deposit once reconciled | No |
| `platform.refund_clearing` | Counterpart for outbound external refunds. | Refund initiated on ledger | Refund settled externally | Transient — must clear to 0 once the payout lands | No |
| `platform.writeoff` | Uncollectible receivable losses. | Bad debt written off | Write-off reversed (customer eventually paid) | Grows monotonically | No |
| `platform.adjustments` | Offset for manual operator adjustments (promos, goodwill, corrections). | Negative adjustment to customer | Positive adjustment to customer | Near-zero ideally; audited if it drifts | No |
| `platform.revenue` *(optional)* | Platform-wide revenue rollup — redundant with Σ `customer.*.consumed` but handy if you want a single number. | Recognized revenue rolled up | Reversals | Grows monotonically | No |

### 1.3 Optional provider-clearing — `provider.{vendor}.*`

Only add if you want COGS attribution at the ledger level (e.g., split OpenAI vs Anthropic spend from customer revenue). For a minimal model, keep provider economics out of pgledger.

| Account | Purpose | Increases when... | Decreases when... | Non-zero long-term? | Customer-visible? |
|---|---|---|---|---|---|
| `provider.{vendor}.clearing` | Bridges vendor invoices against recognized per-vendor COGS. | Consumption attributable to vendor | Vendor invoice paid | 0 at end of each invoice period | No |
| `provider.{vendor}.cogs` | Lifetime COGS per vendor. | Consumption recognized against vendor | Reversal | Grows monotonically | No |

---

## 2. Naming Convention

Hierarchical dot notation, lowercase, ASCII-safe, three segments:

```
{scope}.{identifier}.{role}

customer.{customer_id}.available
customer.{customer_id}.reserved
customer.{customer_id}.consumed
customer.{customer_id}.receivable

platform.funding.clearing       # or platform.funding_clearing — pick one and stick to it
platform.refund.clearing
platform.revenue
platform.writeoff
platform.adjustments

provider.{vendor}.clearing
provider.{vendor}.cogs
```

Rules:

- Segment 1 is the scope: `customer` | `platform` | `provider`. No other roots.
- Segment 2 is the identifier: UUID for customer, short stable slug for platform/provider (never a human name that can change).
- Segment 3 is the lifecycle role.
- No currency in names — pgledger accounts are single-currency by configuration. Run one ledger per currency.
- No environment in names (no `.prod.`, `.staging.`) — that's a deployment concern, not a ledger concern.
- Per-customer accounts are created lazily on the customer's first ledger-touching event.
- Platform accounts are pre-seeded once at system init and never deleted.
- Provider accounts are pre-seeded when a vendor is onboarded.

---

## 3. Transfer Matrix

Notation: `FROM → TO : amount // meaning`. Amounts are always positive. Every multi-leg flow is **one** pgledger transaction — partial posting is forbidden.

### 3.1 Wallet recharge (X)
```
platform.funding_clearing → customer.{id}.available : X   // external funds credited to wallet
```
Only post after external settlement (Stripe webhook confirmed, ACH cleared, etc.). Never pre-post pending funds.

### 3.2 Reservation creation (R)
```
customer.{id}.available → customer.{id}.reserved : R      // earmark funds for in-flight request
```
- **Strict model:** reject if `available < R`.
- **Soft-overage model:** also reject if `available < R`. Soft-overage only activates at capture, not at reserve.

### 3.3 Reservation capture — actual ≤ reserved (A ≤ R)
```
customer.{id}.reserved → customer.{id}.consumed : A       // recognize finalized usage
customer.{id}.reserved → customer.{id}.available : R - A  // return unused portion to spendable
```
Skip the second leg if `A == R`. If `A == 0`, treat as release (3.4).

### 3.4 Reservation release / full cancel (R, no usage)
```
customer.{id}.reserved → customer.{id}.available : R      // unused reservation returned
```
Always allowed. Used for user-cancel, upstream error pre-consumption, or TTL expiry with zero usage.

### 3.5 Reservation capture — actual > reserved (A > R, shortfall S = A − R)

**Strict model: reject the overage.** Cap at R; surface the shortfall as an error. No receivable legs.
```
customer.{id}.reserved → customer.{id}.consumed : R       // capture up to reservation only
// S is NOT posted; upstream must have prevented the overage
```

**Soft-overage model: drain available first, then receivable.** Let `U = min(S, available_now)`.
```
customer.{id}.reserved   → customer.{id}.consumed   : R
customer.{id}.available  → customer.{id}.consumed   : U          // drain remaining wallet
customer.{id}.receivable → customer.{id}.consumed   : S - U      // any remainder becomes debt
```
- Omit the `available` leg if `U == 0`; omit the `receivable` leg if `S == U`.
- `receivable → consumed` increases **both** balances because `receivable` is debit-normal (asset) and `consumed` is credit-normal (revenue). This single transfer correctly represents "revenue recognized; customer now owes this amount".

### 3.6 Direct consumption with no reservation (soft-overage only, amount C)
```
customer.{id}.available  → customer.{id}.consumed : min(C, available_now)
customer.{id}.receivable → customer.{id}.consumed : max(0, C - available_now)
```
Disallowed in strict model — all consumption must flow through a reservation.

### 3.7 Refund after consumption (F)
Refund back to the wallet:
```
customer.{id}.consumed → customer.{id}.available : F
```
Refund paid out externally:
```
customer.{id}.consumed → platform.refund_clearing : F
```
Reject if `F > consumed` for that customer.

### 3.8 Expired reservation (R, no usage)
Identical to 3.4:
```
customer.{id}.reserved → customer.{id}.available : R
```
If your policy is forfeiture instead of release (rare — should be opt-in and disclosed):
```
customer.{id}.reserved → customer.{id}.consumed : R       // or → platform.revenue
```
Default is release.

### 3.9 Manual adjustment (K)
Credit the customer (promo, goodwill):
```
platform.adjustments → customer.{id}.available : K
```
Debit the customer (correction, chargeback fix):
```
customer.{id}.available → platform.adjustments : K
```
Every adjustment carries `actor=operator:{id}` and a reason in transfer metadata.

### 3.10 Receivable settlement (Y, soft-overage only)
External payment applied to debt:
```
platform.funding_clearing → customer.{id}.receivable : Y
```
Write-off:
```
platform.writeoff → customer.{id}.receivable : Y
```
Write-off reversal (customer eventually paid):
```
customer.{id}.receivable → platform.writeoff : Y
// then post 3.10 settlement normally
```

### 3.11 Transfer matrix summary

| Flow | From | To | Strict | Soft |
|---|---|---|---|---|
| Recharge | `platform.funding_clearing` | `customer.available` | allowed | allowed |
| Reserve | `customer.available` | `customer.reserved` | if `available ≥ R` | if `available ≥ R` |
| Capture (A ≤ R) | `customer.reserved` | `customer.consumed` (+ `customer.available` for R−A) | allowed | allowed |
| Release / expire | `customer.reserved` | `customer.available` | allowed | allowed |
| Overage (A > R) | multi-leg (see 3.5) | — | **reject** | allowed |
| Direct spend, no reservation | `customer.available` (+ `customer.receivable`) | `customer.consumed` | **reject** | allowed |
| Refund to wallet | `customer.consumed` | `customer.available` | allowed | allowed |
| Refund external | `customer.consumed` | `platform.refund_clearing` | allowed | allowed |
| Adjust + | `platform.adjustments` | `customer.available` | allowed | allowed |
| Adjust − | `customer.available` | `platform.adjustments` | allowed | allowed |
| Forfeit on expiry | `customer.reserved` | `customer.consumed` | policy-gated | policy-gated |
| Receivable payment | `platform.funding_clearing` | `customer.receivable` | n/a | allowed |
| Write-off | `platform.writeoff` | `customer.receivable` | n/a | allowed |

Everything else is **disallowed**. Specifically:

- No `customer.consumed → customer.reserved` — consumption is terminal.
- No `customer.available → customer.reserved` without a reservation id in metadata.
- No `customer.reserved → customer.receivable` — overage must flow via `consumed` so the usage history is truthful.
- No `customer.reserved → platform.*` except the policy-gated forfeiture in 3.8.
- No direct funding of `customer.consumed` — funds enter via `available` and only move to `consumed` through a recognized usage path.
- No direct funding of `customer.reserved` from `platform.*` — reservations are sourced only from `customer.available`.

---

## 4. Lifecycle Rules / Invariants

1. **Wallet identity.** For every customer and every point in time:
   `available + reserved + consumed − receivable = (lifetime funding) + (lifetime positive adjustments) − (lifetime negative adjustments) − (lifetime external refunds)`.
   This is the integrity check — run it nightly against pgledger balances.
2. **`available` is the only spendable balance.** Everything visible as "wallet balance" to the customer is `available`. `reserved` is shown as pending; never summed into spendable.
3. **`reserved` never leaves the customer namespace.** It can only go to `customer.consumed` (capture) or back to `customer.available` (release/expire). Never refunded, never written off, never adjusted, never moved between customers.
4. **`consumed` is monotonically non-decreasing in normal operation.** The only decrease is via refund flows (3.7).
5. **`receivable` is zero under strict mode.** Under soft-overage it is strictly non-negative.
6. **Every reservation must terminate.** For each `available → reserved : R` there is a matching set of capture/release/expire transfers summing to exactly R, all carrying the same `reservation_id`. Orphaned reserved balances are a bug.
7. **No bypassing the lifecycle.** `available → consumed` is legal **only** as a leg of a soft-overage capture (same atomic transaction as a `reserved → consumed` leg) or as direct consumption under soft-overage (3.6). Standalone `available → consumed` outside these paths is a bug.
8. **Clearing accounts clear.** `platform.funding_clearing` and `platform.refund_clearing` must reconcile to 0 once the corresponding external settlement lands. A persistent balance is an open reconciliation item, not steady state.
9. **No negative customer-facing balance.** `available`, `reserved`, and `consumed` must never be negative. Enforce with pgledger's account-level non-negativity constraint and/or application-level pre-transfer check.
10. **Atomicity.** Multi-leg flows (capture-with-release, overage with three legs, receivable write-off) are one pgledger transaction. No staggered posts.
11. **Immutable history.** Transfers are never updated or deleted. Corrections are new transfers with a clear `flow=adjust` or `flow=refund` label.
12. **Metadata contract.** Every transfer carries: `idempotency_key`, `flow ∈ {recharge, reserve, capture, release, expire, overage, refund, adjust, settle_receivable, writeoff}`, `actor ∈ {system, operator:{id}, customer:{id}}`, and — for reservation-related flows — `reservation_id`.
13. **Lazy customer accounts, eager platform accounts.** Customer accounts come into existence on first real event (recharge or reservation). Platform accounts are seeded at ledger init.
14. **No cross-currency transfers.** One ledger per currency. `platform.*` accounts are duplicated per currency if you run multiple ledgers.

---

## 5. Edge Cases

- **Double-capture.** Second capture arrives for an already-captured reservation. Reject on idempotency key at the use-case layer; the ledger must not re-post.
- **Capture/release race.** Resolve in the reservation state machine, not the ledger. First-writer-wins; loser gets a state conflict error.
- **Concurrent reservations draining `available`.** Serialize reservation creation per customer (advisory lock on `customer_id`, or `SELECT ... FOR UPDATE` on a wallet row). Account-level non-negativity will catch violations, but app-level locking produces clean errors.
- **Refund larger than consumed.** Reject. Cannot refund more revenue than was recognized.
- **Partial refund chain.** Track refund ceiling per original charge in application metadata; the ledger guards the sanity bound (`consumed ≥ 0`).
- **Reservation expired while capture is in flight.** Should not happen — once the capture transaction starts, expire is blocked. Enforce at state machine.
- **Customer deletion.** Do **not** delete ledger accounts. Drain `available` and `reserved` to zero via adjustments/releases, then deactivate the accounts in pgledger. Historical `consumed` and `receivable` must be preserved for audit.
- **Provider over-bills us, we eat the cost.** Post a positive adjustment to the customer (`platform.adjustments → customer.available`) and absorb the cost outside pgledger, or against `provider.{vendor}.clearing` if you use provider accounts.
- **Chargeback.** Model as: `customer.available → platform.adjustments` (reverse the credit) plus, if the funds have already been consumed, `customer.consumed → platform.refund_clearing` (reverse the usage). Attach chargeback id in metadata.
- **Write-off reversal.** `customer.receivable → platform.writeoff`, then normal receivable settlement.
- **Currency / price-book change.** Not a ledger concern — re-pricing happens upstream. Ledger only sees final amounts.
- **Forfeiting expired reservations.** Requires explicit policy flag. Default is release.

---

## 6. Policy: strict reservation only

**Decision: strict reservation. No soft-overage code path. No parallel credits/grants system.**

Rules:

- Reservations are sized with an explicit safety margin at the use-case layer (e.g., estimated tokens × 1.2, plus a fixed floor). Margin is the first line of defense against overage — tune it aggressively rather than tolerating overage at the ledger layer.
- Capture is clamped at `reserved`. Upstream (provider adapter, streaming token counter) enforces a hard stop at the reserved ceiling — circuit-break or truncate rather than overrun. Any observed `A > R` is an upstream bug, not a ledger event.
- Unused reservation is released within a bounded TTL (e.g., 10× expected request duration) or on explicit cancel.
- `customer.receivable` exists in the chart of accounts because overage-correction and operator-initiated debt are still legitimate rare events. It is **not** a future soft-overage staging ground, and no use case may write to it as part of a normal capture path. The only flows touching `customer.receivable` are manual (operator-initiated) receivable entry, settlement, and write-off.
- No direct consumption outside a reservation (flow 3.6 in the transfer matrix is disallowed).

### Single source of truth for customer balance

The wallet is the **only** system that tracks customer balance. In this repo that means:

- The current `credit_grants` table (`internal/db/src/schema/invoices.ts`) and the associated `house:credit_issuance` / `house:expired_credits` / `grant:{grantId}` ledger accounts (`internal/services/src/ledger/accounts.ts`) are **deleted**, not run in parallel.
- Any semantics currently carried by a grant (promo credits, prepaid packages, expiry) are re-expressed as a positive `platform.adjustments → customer.available` transfer with metadata, and — if expiry is required — as a scheduled `customer.available → platform.adjustments` reversal.
- Billing code that currently reads grant balance (`internal/services/src/billing/service.ts`) is rewritten to read `customer.available` via `LedgerGateway.getAccountBalance`.
- No backward compatibility. No data migration from `credit_grants`. If there are live grants at cutover, reconcile them manually once via a one-shot adjustment per customer, then drop the table.

### What this rules out

- Soft-overage capture paths (flows 3.5-soft and 3.6). Remove them from the implementation plan; keep them in the design doc only as rejected alternatives.
- Two account systems (wallet + grants) serving the same balance question. One system, one answer.
- A "pending recharge" state on the ledger. Recharges only post after external settlement.

---

## 7. Migration & pgledger setup checklist (repo-specific)

This is a rip-and-replace. No backward compatibility, no parallel tables, no dual-write.

### 7.1 One-time teardown (single migration)

- Drop the existing `credit_grants` table defined in `internal/db/src/schema/invoices.ts` and remove the Drizzle model.
- Drop the existing single-account-per-customer accounts (`customer:{customerId}:{currency}`) and the grant-related house accounts (`house:credit_issuance:{projectId}:{currency}`, `house:expired_credits:{projectId}:{currency}`) and any `grant:{grantId}` accounts via pgledger account deactivation. Do not preserve historical balances; this is pre-production cleanup.
- Delete the account-name constants for the above in `internal/services/src/ledger/accounts.ts`.
- Delete any grant-reading code paths in `internal/services/src/billing/service.ts` and their callers.

### 7.2 Naming (dot form, scale 8, no currency in key)

Account keys use the hierarchical dot notation from §2. Three segments. Currency lives as an account-level column, **not** a key segment (pgledger is single-currency per ledger; running multi-currency means multiple ledgers, not compound keys).

```
customer.{customerId}.available
customer.{customerId}.reserved
customer.{customerId}.consumed
customer.{customerId}.receivable           # Phase 8

platform.{projectId}.adjustments           # seeded in Phase 7
platform.{projectId}.funding_clearing      # Phase 8
platform.{projectId}.refund_clearing       # Phase 8
platform.{projectId}.writeoff              # Phase 8
platform.{projectId}.revenue               # Phase 8 (optional)
```

Scoping rules:

- `customer.*` keys do **not** include `projectId`. Customer ids (`cus_*` nanoids) are globally unique, so the project scope is carried as pgledger account metadata, not as a key segment.
- `platform.*` keys **do** include `projectId`. Platform-side pools are per-tenant.
- `provider.*` keys (if ever introduced; see §1.3) follow `provider.{vendor}.{role}` with no project scope.

**Amount convention.** All balances and transfer amounts are integers at pgledger scale 8. One dollar is `100_000_000` minor units. Database columns on application tables that mirror ledger amounts are `bigint`. TypeScript field names use the `*Amount` suffix (never `*Cents`). Service boundaries use `Dinero<number>` configured at scale 8. Sub-cent pricing is representable without rounding.

Update `internal/services/src/ledger/accounts.ts` to emit these dot-form names and nothing else. Delete every legacy colon-form / `house:*` / `grant:*` builder in the same pass.

### 7.3 Per-project, per-currency seeding

- One pgledger ledger per currency. Currency is an account-level column, not part of the key.
- On project creation, seed `platform.{projectId}.adjustments` for every supported currency. The other platform accounts (`funding_clearing`, `refund_clearing`, `writeoff`, `revenue`) are seeded in Phase 8 when the flows that use them land. Extend `LedgerGateway.seedHouseAccounts` (`internal/services/src/ledger/gateway.ts`) and rename it to `seedPlatformAccounts`.
- On first customer-touching event (top-up settlement or reservation activation), lazily create the three Phase 7 `customer.{customerId}.*` accounts (`available`, `reserved`, `consumed`) in a single transaction. `receivable` is deferred to Phase 8. Extend `LedgerGateway.ensureCustomerAccount` to create the three-account bundle; rename to `ensureCustomerAccounts` (plural) to reflect the new shape.

### 7.4 Normal-balance configuration

- **Credit-normal:** `customer.*.available`, `customer.*.reserved`, `customer.*.consumed`, `platform.*.revenue`, `platform.*.refund_clearing`, `platform.*.adjustments`.
- **Debit-normal:** `customer.*.receivable`, `platform.*.funding_clearing`, `platform.*.writeoff`.

Set these at account-creation time in the gateway. pgledger does not let you change normal balance after the fact without recreating the account.

### 7.5 Non-negativity constraints

Enforce non-negativity on:

- `customer.*.available`
- `customer.*.reserved`
- `customer.*.consumed`
- `customer.*.receivable` *(Phase 8)*

Enforce at the pgledger account level if the version in use supports it; otherwise enforce at the use-case layer with a pre-transfer balance check inside the same DB transaction (`pg_advisory_xact_lock(hashtext('customer:' || customer_id))`).

### 7.6 Gateway API surface after the rewrite

The gateway collapses to **one** transfer primitive. The use-case / service layer (`WalletService` in Phase 7) composes that primitive for every flow in §3.

```ts
// internal/services/src/ledger/gateway.ts
createTransferInTx(tx, {
  fromAccountKey: string,
  toAccountKey:   string,
  amount:         bigint,           // scale 8
  currency:       CurrencyCode,
  metadata:       TransferMetadata, // { flow, idempotency_key, ...flow-specific }
}): Promise<Result<TransferId, LedgerError>>

seedPlatformAccounts(projectId, currency): Promise<void>
ensureCustomerAccounts(customerId, currency): Promise<void>
getAccountBalance(accountKey): Promise<bigint>
```

Everything else — reserve, capture, release, recharge, refund, adjust, settle-receivable, write-off — is a `WalletService` method (or a use case) composed of `createTransferInTx` calls inside one Drizzle / pgledger transaction. Capture (`reserved → consumed : actual` plus `reserved → available : reserved − actual`) is two `createTransferInTx` calls, not a dedicated gateway method.

Phase 7 ships `WalletService` with five methods: `transfer`, `createReservation`, `flushReservation`, `adjust`, `settleTopUp`. `refundToWallet` / `refundExternal`, `settleReceivable`, `writeOffReceivable`, and the `funding_clearing` / `refund_clearing` side of recharge land in Phase 8. See `./plans/unprice-phase-07-credits-wallets.md` §7.3 for the Phase 7 shape.

Every `WalletService` method wraps its `createTransferInTx` calls in one pgledger transaction and writes an `unprice_ledger_idempotency` row keyed on `(source_type, source_id)`. Every method that touches a customer balance opens its transaction with `SELECT pg_advisory_xact_lock(hashtext('customer:' || customer_id))`.

### 7.7 Reconciliation

Add a nightly job under `internal/jobs/` that checks the wallet identity (invariant 1 from section 4) for every active customer. In Phase 7 the identity simplifies to (no `receivable`, no `refund_clearing`, no external refunds yet):

```
available + reserved + consumed
  == Σ adjustments_in − Σ adjustments_out
```

where both sums are over transfers touching `platform.{projectId}.adjustments` against that customer's accounts. Emit a metric per customer on mismatch; log with `reservation_id` context where applicable. No paging in Phase 7. The broader identity (including `receivable`, `funding_clearing`, and external refunds) lands in Phase 8 when those flows exist. See `./plans/unprice-phase-07-credits-wallets.md` §7.11 for the full cron spec (identity check + stranded-reservation sweep + stranded-topup sweep + invoice-projection orphan check).

### 7.8 What is explicitly out of scope

- Provider-clearing / COGS accounts.
- Soft-overage flows and the corresponding use cases (`settle-receivable` beyond the operator-only path, no automated receivable accrual). `customer.*.receivable` is defined in the chart of accounts but is not written to in Phase 7; all `receivable` flows ship in Phase 8.
- `platform.*.funding_clearing`, `platform.*.refund_clearing`, `platform.*.writeoff`, `platform.*.revenue` — defined in the chart of accounts, seeded and used starting in Phase 8. Phase 7 recharges issue from `platform.{projectId}.adjustments` with `metadata.source` distinguishing top-ups / promos / corrections.
- The `credit_grants` table and grant-related ledger accounts (deleted, not migrated).
- Any "wallet balance" Drizzle table — the spendable balance is `customer.{customerId}.available` in pgledger and nothing else. The two new Drizzle tables in Phase 7 are **state machines** that settle into the ledger: `entitlement_reservations` (reservation lifecycle) and `wallet_topups` (provider-initiated top-up lifecycle, webhook-settled). Neither holds authoritative balance.
