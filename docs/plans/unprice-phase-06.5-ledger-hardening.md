# Phase 6.5: Ledger Hardening & AI-Ready Financial Core

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
PR title: `feat: harden ledger for multi-settlement and AI-scale billing`
Branch: `feat/ledger-hardening`

## Mission

Harden the ledger to be a true append-only, immutable financial source of truth
with fixed internal precision, journal grouping, reversal entries, and
append-only settlement records. This phase prepares the ledger for wallet
settlement (Phase 7), financial guardrails (Phase 8), and high-frequency
agent metering at scale.

## Dependencies

- Phase 4 for existing `LedgerService`
- Phase 5 for settlement webhooks
- Phase 6 for agent billing and `billMeterFact`

## The 20% That Makes 80% Impact

One structural change: **move settlement off the entry row into its own table.**
That single change fixes entry immutability, enables wallet/crypto/multi-provider
settlement, creates an audit trail, and eliminates all three mutations that
currently break append-only semantics.

The second change: **move `confirmLedgerSettlementByInvoiceId` and
`reopenLedgerSettlementByInvoiceId` from `process-webhook-event.ts` into
`LedgerService`.** These two functions (lines 127-215) directly UPDATE
`ledgerEntries` and `ledgers` tables, bypassing all service invariants.

Everything else (bigint, journal grouping, meter-fact attribution) is incremental.
The settlement table is the structural fix.

## Core Design Principle: Entries Have No State

The current design's fundamental error is treating ledger entries as stateful
entities. The settlement columns (`settledAt`, `settlementType`,
`settlementArtifactId`, `settlementPendingProviderConfirmation`) turn an
immutable fact into a mutable entity with implicit state transitions.

**The ledger does NOT need a state machine.** A ledger entry is an event — it
happens and it's done. Putting state on an entry is like putting state on a git
commit.

| Concept | Has states? | What it is |
|---------|------------|------------|
| Ledger entry | **No.** Fact. Born immutable. | "Customer consumed $3.50 on April 12" |
| Settlement | **Yes.** pending → confirmed → reversed. | "That $3.50 collected via INV-123" |
| Invoice | **Yes.** draft → unpaid → paid/void. | "INV-123 totals $13.50" |
| Wallet | **Yes.** Has balance, funded/debited. | "Wallet has $96.50 remaining" |

The fix is NOT to formalize entry transitions into a state machine. The fix is to
**remove all state from the entry** and put it on the settlement record, which is
the thing that actually has a lifecycle.

Settlement state machine (on `ledger_settlements.status`, NOT on entries):

```
  pending ──→ confirmed     (payment success)
     │              │
     └──→ reversed  ←──┘    (payment failure / chargeback)
          (terminal — re-settlement creates a new record)
```

## Architectural Pattern: fold / decide / shell

Inspired by [`ricofritzsche/eventstore-typescript`](https://github.com/ricofritzsche/eventstore-typescript),
a lightweight TypeScript event store that enforces a clean functional separation
for event-sourced domains:

1. **fold** — a pure function that reduces a list of events (or entries) into
   current state. No I/O, no side effects.
2. **decide** ��� a pure function that takes a command + the folded state and
   returns either a success result (new event/entry to append) or a domain error.
3. **shell** — the impure orchestrator that queries, calls fold, calls decide,
   and persists the result.

This maps directly to the ledger:

```
                     ┌──────────────────────────────┐
  query entries      │         LedgerService         │
  ─────────────────► │  (shell — DB + transactions)  │
                     └──────┬───────────┬────────────┘
                            │           │
                    fold    │           │  decide
                    ────────▼──         ──▼─────────
                    foldLedgerState     decideDebit
                    (entries[])         (command, state)
                    → { balance,        → Ok(DebitEntry)
                        unsettled }     | Err(InsufficientBalance)
                    ────────────        ────────────────
                    pure, testable      pure, testable
```

### What to extract

Refactor `LedgerService.postDebit` and `postCredit` into three layers:

- **`foldLedgerState(entries: LedgerEntry[]): LedgerState`** — computes
  `{ balanceMinor, unsettledBalanceMinor }` by summing `signedAmountMinor`.
  Pure function, unit-testable with zero DB setup.
- **`decideDebit(command: PostDebitInput, state: LedgerState): Result<NewEntry, LedgerError>`**
  — validates amount > 0, truncates to integer, computes `balanceAfterMinor`.
  Returns the entry to insert or a typed error. Pure function.
- **`LedgerService.postDebit` (the shell)** — acquires the lock
  (`SELECT ... FOR UPDATE`), queries entries, calls `foldLedgerState`, calls
  `decideDebit`, persists inside the transaction. Same DB semantics as today,
  but the business logic is extracted and independently testable.

Same extraction for settlement:

- **`foldSettlementState(settlements: LedgerSettlement[]): SettlementState`** —
  computes current status, total settled amount, transition history.
- **`decideConfirm(state: SettlementState): Result<StatusTransition, LedgerError>`**
  — enforces `pending → confirmed`, rejects invalid transitions.
- **`decideReverse(state: SettlementState, reason: string): Result<ReversalPlan, LedgerError>`**
  — enforces `pending|confirmed → reversed`, produces reversal entries.

### Why this matters now

The fold/decide split is not a future aspiration — it solves three immediate
problems in this phase:

1. **Testability.** The current `postDebit` mixes validation, arithmetic, and
   DB operations in one method. Extracting pure functions lets us unit-test
   balance computation, idempotency edge cases, and settlement transitions
   without standing up a database. Integration tests (Slice 7) still validate
   the shell, but the combinatorial explosion of business rules is covered by
   fast pure-function tests.

2. **Replayability.** If `foldLedgerState` can compute balance from entries,
   then `reconcileUnsettledBalance` is just `fold all entries → compare with
   cached counter`. Same function, different input set. The fold IS the
   reconciliation logic.

3. **Settlement state machine safety.** `decideConfirm` and `decideReverse`
   encode the valid transitions as pure logic. The shell calls decide and
   either persists or returns the error. No way to accidentally bypass the
   state machine from a webhook handler or use case.

### Optimistic concurrency (future consideration)

The eventstore-typescript library replaces row-level `SELECT ... FOR UPDATE`
with filter-scoped optimistic locking: query → fold → decide → append with
`expectedMaxSequenceNumber`. If a concurrent write appended matching events,
the append fails and the caller retries. This eliminates deadlock risk and
allows concurrent writes to different customers without contention.

We keep `SELECT ... FOR UPDATE` for now — it works and is battle-tested. But
the fold/decide extraction makes the switch to optimistic concurrency a
mechanical change later: replace the lock acquisition in the shell with a
sequence-number check on append. The pure functions don't change at all.

## Why This Phase Exists

### Industry context

Stripe acquired Metronome for $1B (Jan 2026) because Stripe Billing's
pre-aggregation architecture couldn't handle real-time event streaming at AI
scale. Metronome, Orb, and Lago all use append-only ledgers as the single
source of truth, with invoices as derived settlement artifacts. The
architectural pattern that emerged across all of them:

```
Raw Event → Billable Metric → Rated Charge → Ledger Entry → Settlement Artifact
                                                              (invoice, wallet, threshold)
```

### Industry alignment

| Company | Ledger | Invoice | Wallet |
|---------|--------|---------|--------|
| **Orb** | Immutable, "billing = deterministic query" | Derived, re-computable | Credits with priority/expiry |
| **Metronome** | Event-first, 30B events/mo (OpenAI) | Derived, 10K invoices/sec | Credits as settlement type |
| **Lago** | Events → metrics → charges, 15K ev/sec | Auto-generated per cycle | 5 wallets/customer, priority 1-50 |
| **OpenMeter** | CloudEvents → meters → charges | Progressive billing | Grant/debit credits |
| **Unprice (today)** | Append-only with **mutable** settlement | Materialized 1:1 from entries | creditGrants, FIFO at finalize |
| **Unprice (after 6.5)** | Truly append-only, scale 6 | Materialized, ledgerEntryId FK | Ready for Phase 7 wallets |

Key industry properties Unprice's ledger must match:

- **Immutability**: entries are never mutated. Corrections are reversal entries.
- **Settlement as a separate layer**: entries and settlement state are independent
  tables.
- **Sub-cent precision**: AI token pricing (e.g., $0.003/1K tokens) requires
  precision below the cent. Use a fixed internal precision (scale 6) so all
  ledger arithmetic uses one canonical scale.
- **Re-computability**: given immutable entries, any derived artifact (invoice,
  statement, balance) can be re-derived.
- **Extensible settlement types**: new settlement methods (wallet, crypto,
  marketplace splits) shouldn't require DDL migrations.

What Unprice already does right (validated by industry):

- Entries are input for invoice items (invokes.ts:628-651) — **Orb/Metronome pattern**
- Idempotency via sourceType:sourceId unique index — **Blnk pattern**
- `SELECT FOR UPDATE` serialization on ledger writes — **Formance pattern**
- Credits applied at finalization time, not debit time — **Lago pattern**

### Architecture: enhanced single-entry, not double-entry

This architecture was evaluated against three leading open-source fintech/billing
projects:

- **Formance (formancehq/ledger)**: Full double-entry with accounts, postings,
  moves, and a "Volumes" pattern (input/output counters per account). Balance is
  `input - output`. Uses `SELECT FOR UPDATE` on `accounts_volumes` for
  serialization, and an append-only `logs` table with SHA-256 hash chain.

- **Blnk (blnkfinance/blnk)**: Double-entry with a single `transactions` table
  carrying both `source` and `destination` balance IDs. Uses optimistic
  concurrency (`version` stamp) plus Redis distributed locks. Supports
  inflight/commit two-phase pattern for holds.

- **Flexprice (flexprice/flexprice)**: Wallets with `wallet_transactions` as
  the credit ledger. Each credit row carries `credits_available`, `expiry_date`,
  and `priority`. Grants are blueprints (rules) that schedule credit deliveries
  via `credit_grant_applications`.

**Decision: Unprice does NOT need full double-entry.** We are a billing platform,
not a general-purpose financial ledger. Money doesn't move between customer
accounts. Double-entry would force us to invent counterpart accounts (AR, cash
clearing, wallet liability, revenue/deferred revenue), causing 2-4x write
amplification and more contention on the hot write path — exactly what we're
trying to avoid for AI-scale billing.

Instead, we borrow selectively:

| From | Borrow | Skip |
|------|--------|------|
| **Formance** | Immutability discipline, journal grouping, reversal-as-new-entry, projection mindset | Generic accounts, postings table, volumes (input/output), moves table |
| **Blnk** | Idempotent transaction semantics, hash-based dedup | Source/destination double-entry, Redis distributed locks, balance monitors |
| **Flexprice** | Wallets as separate domain, credit lots with priority/expiry (Phase 7) | Mutable `credits_available` column — use append-only debit entries instead |

**We do NOT need the concept of "accounts" as a generic abstraction.** The
implicit account `(project, customer, currency)` is sufficient. Domain-specific
balance containers (wallets, credit lots) are modeled explicitly in Phase 7 when
needed, not as a generic accounts table.

### How grants relate to the ledger

**Entitlement grants and financial grants are separate domains:**

- `grants` (entitlements.ts) = feature access rules, limits, overage strategy.
  They control *what* a customer can use. They do NOT live in the ledger.
- `credit_lots` / `wallet_grants` (Phase 7) = monetary value buckets with
  priority, expiry, and remaining balance. They control *how* charges are paid.

Grants define the *rules*. The ledger records the *financial facts*. Settlement
connects them: a wallet deduction settles a ledger entry via the settlement
layer. This separation keeps each domain simple and independently evolvable.

### Prepaid vs postpaid in one ledger

Both prepaid (credits/wallets) and postpaid (invoices) use the same charge
ledger. The difference is in settlement:

- **Postpaid**: usage posts debit to charge ledger → later linked to invoice
  settlement artifact → provider collects payment
- **Prepaid**: usage posts debit to charge ledger → settlement router links it
  to wallet settlement artifact → wallet balance decreases in wallet subsystem

One consistent financial story for charges. Settlement is the branching point.

### Why the current model cannot support wallets

Three specific structural blockers:

**1. One entry = one settlement.** `settlementType` and `settlementArtifactId`
are scalar columns on the entry row. If a customer has a $50 charge and a $30
wallet balance, you can't settle $30 via wallet and $20 via invoice. The entry
gets ONE type and ONE artifact ID. The proposed `ledger_settlement_lines.amountMinor`
per entry solves this — one entry, multiple settlement lines.

**2. `settlementType` is a Postgres enum.** Adding `"wallet"` requires DDL
migration (`ALTER TYPE ADD VALUE`). Adding `"crypto"` is another migration.
Each new settlement method requires schema changes. The proposed
`ledger_settlements.type` as `varchar(32)` solves this.

**3. `settlementPendingProviderConfirmation` bakes Stripe into every entry.**
A wallet deduction is instant — no provider confirmation step. Crypto has block
confirmations, not webhooks. The proposed settlement status state machine
(pending → confirmed) on `ledger_settlements` is provider-agnostic.

### Where wallet charges go (Phase 7, enabled by this phase)

```
Charge → Ledger entry (immutable fact: "consumed $3.50")
Settlement Router decides HOW to collect:
  ├── Wallet?   → settlement(type="wallet")  → deduct wallet balance
  ├── Invoice?  → settlement(type="invoice") → include in next invoice
  └── Partial?  → settlement_line($2 wallet) + settlement_line($1.50 invoice)
```

The charge goes to the ledger. The settlement goes to the settlement layer. The
wallet has its own balance. The ledger entry never knows or cares whether payment
came from Stripe, crypto, or a wallet. It just says: "customer consumed $3.50."

Wallet top-ups ($100 prepaid) are NOT ledger entries. The ledger records
consumption, not funding. The wallet subsystem tracks its own balance, funded by
whatever provider.

### What's wrong today

```
  SUBSCRIPTION PATH                          METER FACT PATH

  Billing Period (pending)                   Meter Event
       │                                          │
       ▼                                          ▼
  Rating → LedgerService.postDebit()         Rating → LedgerService.postDebit()
       │  (unsettled entry created)               │  (unsettled, NO billingPeriodId,
       │                                          │   NO statementKey, NO subscriptionId)
       ▼                                          ▼
  getUnsettledEntries(statementKey)           ???  ◄── NO SETTLEMENT PATH
       │                                          (entries accumulate forever)
       ▼
  Create invoice + invoice_items (1:1 from entries)
       │
       ▼
  markSettled()  ◄── MUTATION #1 (UPDATEs entry columns, breaks append-only)
       │
       ▼
  finalizeInvoice() → Stripe sync
       │
       ▼
  Webhook: payment.succeeded
       │
       ▼
  confirmLedgerSettlement()  ◄── MUTATION #2 (direct DB update, bypasses LedgerService)
       │
       ▼
  Webhook: payment.failed
       │
       ▼
  reopenLedgerSettlement()   ◄── MUTATION #3 (NULLs OUT columns, DESTROYS audit trail)
```

Specific problems:

1. **Mutating settled entries breaks immutability**.
   `reopenLedgerSettlementByInvoiceId` in `process-webhook-event.ts` nulls out
   `settlementType`, `settlementArtifactId`, and `settledAt` on existing
   entries. This destroys audit history. Industry standard: post a reversal
   entry that negates the original, leaving both in the log.

2. **Settlement logic leaks outside `LedgerService`**.
   `confirmLedgerSettlementByInvoiceId` and `reopenLedgerSettlementByInvoiceId`
   directly update `ledgerEntries` and `ledgers` tables, duplicating balance
   arithmetic. All ledger mutations must flow through `LedgerService`.

3. **Settlement state is mutable on entries — contradicts append-only**.
   `markSettled` UPDATEs `settledAt`, `settlementType`, `settlementArtifactId`
   on existing entries. Settlement should be its own append-only layer that
   *references* entries, not mutates them.

4. **No journal grouping**. A single agent task producing charges across
   tokens + compute + API calls creates independent entries with no grouping.

5. **Integer cents loses sub-cent precision**. `amountCents: integer` can't
   represent $0.003/token without rounding.

6. **Mixed-scale arithmetic is unsafe**. All amounts must use one canonical
   scale for safe arithmetic.

7. **Settlement types are a Postgres enum**. Adding `"wallet"` (Phase 7) or
   `"one_time"` (crypto) requires a DDL migration each time.

8. **No audit trail for settlement transitions**. When an entry goes from
   unsettled → settled → reversed, there's no record of *when* or *why* each
   transition happened.

9. **Meter-fact ledger entries have no settlement path**. `billMeterFact`
   posts debits with only `featurePlanVersionId` — no `statementKey`,
   `subscriptionId`, `billingPeriodId`, or cycle dates. These entries
   accumulate unsettled forever with no grouping mechanism.

## The Case Against Refactoring Invoicing Now

The natural question: "If the ledger is the source of truth, shouldn't invoices
be pure projections from ledger entries rather than a materialized copy?"

8 reasons NOT to make invoices a pure ledger projection in Phase 6.5:

**1. Different consumers, different data needs.** `invoice_items` has
`prorationFactor` and `itemProviderId` (Stripe line item ID) that don't exist
on entries. Entries have `signedAmountCents`, `balanceAfterCents`, `entryType`
that mean nothing on an invoice line. A projection serving both is a leaky
abstraction.

**2. Stripe requires materialized provider state.** Finalization reconciles
with Stripe via `itemProviderId` stored on each invoice item. After sync,
`itemProviderId` is updated on the item. A projection from entries would still
need somewhere to store provider IDs — you recreate the table.

**3. Materialized snapshot IS correct for a legal document.** An issued invoice
should not change if a subsequent ledger correction is posted. The materialized
copy represents the invoice *as issued*. Re-computability means you CAN
re-derive — not that you MUST read from the ledger on every access.

**4. Performance: one-table scan vs. three-table join.** Current reads hit
`invoice_items` by `invoiceId` — single table scan. A projection requires
entries JOIN settlement_lines JOIN settlements filtered by artifact + status.

**5. Credits stay at invoice level for now.** `_applyCredits` operates on
`invoice.totalCents`. Phase 7 replaces this with wallet settlement. Moving
credits to ledger level now is throwaway work.

**6. Phase 7 breaks the 1:1 assumption.** Today: entry → invoice item (1:1).
After wallets: some entries settle via wallet, some via invoice. Refactoring
now on the 1:1 assumption means refactoring again when wallets arrive.

**7. The system already works — fix immutability, not structure.** The flow IS
ledger-first: rate periods → post entries → query unsettled → project invoice
items → settle. Fix the three mutations and you have a sound architecture.

**8. Migration cost is disproportionate.** Replacing `invoice_items` requires
rewriting finalization (300+ lines), provider sync, UI components, and Stripe
webhook compatibility.

## Read First

- [../../internal/services/src/ledger/service.ts](../../internal/services/src/ledger/service.ts)
- [../../internal/services/src/ledger/service.test.ts](../../internal/services/src/ledger/service.test.ts)
- [../../internal/db/src/schema/ledger.ts](../../internal/db/src/schema/ledger.ts)
- [../../internal/db/src/validators/ledger.ts](../../internal/db/src/validators/ledger.ts)
- [../../internal/db/src/utils/constants.ts](../../internal/db/src/utils/constants.ts)
- [../../internal/db/src/utils.ts](../../internal/db/src/utils.ts) — `formatAmountDinero`
- [../../internal/db/src/validators/planVersionFeatures.ts](../../internal/db/src/validators/planVersionFeatures.ts) — `dineroSnapshotSchema`
- [../../internal/services/src/use-cases/billing/bill-meter-fact.ts](../../internal/services/src/use-cases/billing/bill-meter-fact.ts)
- [../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts](../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts)
- [../../internal/services/src/subscriptions/invokes.ts](../../internal/services/src/subscriptions/invokes.ts)
- [../../internal/services/src/context.ts](../../internal/services/src/context.ts)
- [./unprice-phase-04-ledger-foundation.md](./unprice-phase-04-ledger-foundation.md)
- [./unprice-phase-07-credits-wallets.md](./unprice-phase-07-credits-wallets.md)
- [`ricofritzsche/eventstore-typescript`](https://github.com/ricofritzsche/eventstore-typescript) — fold/decide/shell pattern reference, filter-scoped optimistic concurrency

## Guardrails

- `LedgerService` remains a leaf service — no peer domain service dependencies.
- ALL ledger mutations (posting, settling, confirming, reversing) must go
  through `LedgerService` methods. No direct table updates outside the service.
- Ledger entries are append-only. Never `UPDATE` any column on an existing
  entry. Settlement state lives in separate append-only tables. Corrections
  are reversal entries.
- Dinero.js is the money library for the **pricing/rating pipeline**. The
  ledger stores integers at a fixed internal precision (scale 6). Dinero
  objects are converted at the boundary via `formatAmountForLedger`. After
  that boundary, the ledger works with plain `bigint` arithmetic — no Dinero
  inside `LedgerService`.
- Do not introduce TypeScript `any` types.
- Keep orchestration in use cases, not adapters.
- Settlement type extensibility must not break existing `"invoice"` and
  `"manual"` settlement flows.
- Do not break the existing subscription invoicing flow in
  `subscriptions/invokes.ts` — it should work identically after this phase.
- Entitlement grants (`grants` table) are a separate domain from financial
  credits. Do NOT unify them or put entitlement data in the ledger.
- Invoice items stay materialized. Do NOT refactor invoices to pure ledger
  projections in this phase. Add `ledgerEntryId` FK for traceability instead.

## Dinero.js & Precision Strategy

### Where Dinero.js belongs

Dinero.js v2 (which you already use at `2.0.0-alpha.14`) is the right tool for
money arithmetic in the **pricing and rating pipeline**:

```
Plan configuration (Dinero snapshots in JSON)
  → RatingService.rateBillingPeriod / rateIncrementalUsage (Dinero arithmetic)
  → formatAmountForLedger(dineroObj) → { amount: bigint, currency }
  → LedgerService.postDebit (plain integer arithmetic)
```

**Dinero.js does NOT enter the ledger.** The ledger is integer-only. This keeps
the hot write path simple, avoids Dinero object creation overhead on every
balance update, and makes the ledger portable (any consumer can read integers
without importing Dinero.js).

### Fixed internal precision

Instead of per-entry `scale` (which creates mixed-scale arithmetic bugs), the
ledger uses a **single canonical precision** for all amounts and balances:

```
LEDGER_INTERNAL_SCALE = 6  (i.e., 1 USD = 1_000_000 minor units)
```

This handles sub-cent pricing natively:
- `$0.003/token` → `3_000` minor units (at scale 6)
- `$1.23` → `1_230_000` minor units (at scale 6)
- `$0.000001` → `1` minor unit (at scale 6)

All amounts in `ledger_entries`, `ledger_settlements`, and `ledgers` are stored
as `bigint` at scale 6. No per-row `scale` column needed.

### The conversion boundary

Today `formatAmountDinero` normalizes to the currency exponent (scale=2 for
USD). Replace it with a ledger-specific converter:

```typescript
// internal/db/src/utils.ts
import { toSnapshot, transformScale, up } from "dinero.js"

export const LEDGER_INTERNAL_SCALE = 6

export function formatAmountForLedger(
  price: Dinero<number>
): { amount: number; currency: Currency } {
  const scaled = transformScale(price, LEDGER_INTERNAL_SCALE, up)
  const { amount, currency } = toSnapshot(scaled)
  return {
    amount,
    currency: currency.code.toLowerCase() as Currency,
  }
}

// Reconstruct Dinero from ledger amount (for display/invoice formatting)
export function ledgerAmountToDinero(
  amount: number,
  currency: Currency
): Dinero<number> {
  return dinero({
    amount,
    currency: currencies[currency.toUpperCase() as keyof typeof currencies],
    scale: LEDGER_INTERNAL_SCALE,
  })
}

// Convert ledger scale-6 amount to provider scale-2 cents
export function ledgerAmountToCents(amount: number): number {
  return Math.round(amount / 10_000)   // scale 6 → scale 2
}
```

The existing `formatAmountDinero` stays unchanged for non-ledger uses (Stripe
payment amounts, UI display, etc.).

### Scale conversion at the invoice boundary

**Key rule**: invoice_items store scale-2 cents (provider-friendly). The ledger
stores scale-6 micro-units. Conversion happens at projection time in
`invoiceSubscription` via `ledgerAmountToCents()`. This keeps the invoice as a
human/provider-readable document. Stripe expects amounts in the currency's
smallest unit (cents for USD, scale 2).

### Summary

| Layer | Representation | Library |
|-------|---------------|---------|
| Plan config | Dinero snapshots in JSON | Dinero.js |
| Rating pipeline | Dinero objects with arbitrary scale | Dinero.js |
| **Conversion boundary** | `formatAmountForLedger()` | Dinero.js → integer |
| Ledger storage | `bigint` at fixed scale 6 | Plain arithmetic |
| Ledger running balances | `bigint` at fixed scale 6 | Plain arithmetic |
| **Invoice projection** | `ledgerAmountToCents()` | Scale 6 → scale 2 |
| Invoice items / display | Integer cents (scale 2) | Plain integers |
| Stripe/provider amounts | `formatAmountDinero()` (existing, scale 2) | Dinero.js |

## Primary Touchpoints

- `internal/db/src/schema/ledger.ts` — new settlement tables, drop settlement
  columns from entries, switch to bigint, add journalId
- `internal/db/src/schema/invoices.ts` — add `ledgerEntryId` FK to invoice_items
- `internal/db/src/schema/enums.ts` — drop settlement type enum after migration
- `internal/db/src/utils/constants.ts` — settlement types, statuses as const arrays
- `internal/db/src/validators/ledger.ts` — updated validators for new tables
- `internal/db/src/utils.ts` — add `formatAmountForLedger`, `ledgerAmountToDinero`,
  `ledgerAmountToCents`
- `internal/services/src/ledger/service.ts` — new settlement methods, refactored
  posting, settlement through append-only tables
- `internal/services/src/ledger/errors.ts` — new error codes
- `internal/services/src/use-cases/payment-provider/process-webhook-event.ts` —
  refactor to use `LedgerService` for all settlement operations
- `internal/services/src/use-cases/billing/bill-meter-fact.ts` — populate
  attribution context, use `formatAmountForLedger`
- `internal/services/src/subscriptions/invokes.ts` — adapt to new schema,
  use `formatAmountForLedger`, `ledgerAmountToCents`, set `ledgerEntryId`

## Execution Plan

### Target flow (after Phase 6.5)

```
  SUBSCRIPTION PATH                          METER FACT PATH

  Billing Period (pending)                   Meter Event
       │                                          │
       ▼                                          ▼
  Rating → LedgerService.postDebit()         Rating → LedgerService.postDebit()
       │  (immutable entry, scale 6)              │  (immutable, scale 6,
       │  (entry has NO settlement cols)          │   WITH subscriptionId, statementKey)
       │                                          │
       ▼                                          ▼
  getUnsettledEntries(statementKey)           Accumulates until Phase 7 settlement
       │  NOT EXISTS(settlement_line)         router groups into invoice or wallet
       ▼
  Create invoice + invoice_items
       │  (1:1, scale-2 amounts for Stripe)
       │  (ledgerEntryId FK for traceability)
       ▼
  LedgerService.settleEntries()  ←── APPEND-ONLY (new row in ledger_settlements +
       │                              settlement_lines, entries untouched)
       ▼
  finalizeInvoice() → Stripe sync
       │
       ▼
  Webhook: payment.succeeded
       │
       ▼
  LedgerService.confirmSettlement()  ←── UPDATE on settlement status only
       │                                  (pending → confirmed, logged in metadata)
       ▼
  Webhook: payment.failed
       │
       ▼
  LedgerService.reverseSettlement()  ←── APPEND reversal entries + new settlement record
       │                                  (originals untouched, full audit trail preserved)
       ▼
  Reversal entries born unsettled → re-invoiceable or wallet-settleable
```

### Slice 1: Settlement tables + drop settlement columns from entries

Add new tables to `internal/db/src/schema/ledger.ts`:

**Create `ledger_settlements`:**
```
ledger_settlements(
  id                      cuid PK (with projectId)
  projectId               cuid       NOT NULL FK → projects
  ledgerId                cuid       NOT NULL FK → ledgers
  type                    varchar(32) NOT NULL -- "invoice" | "manual" | "wallet" | "one_time"
  artifactId              varchar(160) NOT NULL -- invoice ID, wallet txn ID, etc.
  status                  varchar(32) NOT NULL -- "pending" | "confirmed" | "reversed"
  reversesSettlementId    cuid                 -- nullable self-FK for reversal tracking
  createdAtM              bigint     NOT NULL
  updatedAtM              bigint     NOT NULL
  metadata                jsonb               -- reason, notes, transition log
)
UNIQUE: (projectId, ledgerId, artifactId, type)
INDEX:  (projectId, type, artifactId)
INDEX:  (projectId, ledgerId, status)
```

**Create `ledger_settlement_lines`:**
```
ledger_settlement_lines(
  id                      cuid PK (with projectId)
  projectId               cuid       NOT NULL FK → projects
  settlementId            cuid       NOT NULL FK → ledger_settlements
  ledgerEntryId           cuid       NOT NULL FK → ledger_entries
  amountMinor             bigint     NOT NULL -- at scale 6, supports partial settlement
  createdAtM              bigint     NOT NULL
)
UNIQUE: (projectId, settlementId, ledgerEntryId)
INDEX:  (projectId, ledgerEntryId)
```

**Drop from `ledger_entries`** (after backfill migration):
- `settlementType`
- `settlementArtifactId`
- `settlementPendingProviderConfirmation`
- `settledAt`

**Drop**: `idxSettlementArtifact` index, `idxUnsettled` partial index (replace
with settlement-line-based query).

**Add to `invoice_items`**: `ledgerEntryId cuid` FK → ledger_entries (nullable,
for traceability).

**Files changed**:
- `internal/db/src/schema/ledger.ts` — new tables, drop settlement columns
- `internal/db/src/schema/invoices.ts` — add `ledgerEntryId` to `invoice_items`
- `internal/db/src/schema/enums.ts` — drop `ledgerSettlementTypeEnum` after migration
- `internal/db/src/validators/ledger.ts` — new validators for settlement tables
- `internal/db/src/utils/constants.ts` — `LEDGER_SETTLEMENT_TYPES`, `LEDGER_SETTLEMENT_STATUSES`

### Slice 2: LedgerService — fold/decide extraction + settlement methods

**Step A: Extract fold/decide pure functions.**

Create `internal/services/src/ledger/core.ts` — pure business logic, zero I/O:

```typescript
// --- fold functions ---

export function foldLedgerState(entries: LedgerEntry[]): LedgerState {
  return entries.reduce(
    (state, entry) => ({
      balanceMinor: state.balanceMinor + entry.signedAmountMinor,
      unsettledBalanceMinor: entry.settledViaLine
        ? state.unsettledBalanceMinor
        : state.unsettledBalanceMinor + entry.signedAmountMinor,
      entryCount: state.entryCount + 1,
    }),
    { balanceMinor: 0n, unsettledBalanceMinor: 0n, entryCount: 0 }
  )
}

export function foldSettlementState(
  settlement: LedgerSettlement,
  lines: LedgerSettlementLine[]
): SettlementState {
  return {
    status: settlement.status,
    totalSettledMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0n),
    lineCount: lines.length,
    transitions: settlement.metadata?.transitions ?? [],
  }
}

// --- decide functions ---

export function decideDebit(
  command: PostDebitInput,
  state: LedgerState
): Result<NewDebitEntry, LedgerError> {
  if (command.amountMinor <= 0n) return Err(new LedgerError("INVALID_AMOUNT"))
  const balanceAfterMinor = state.balanceMinor + command.amountMinor
  return Ok({
    entryType: "debit",
    amountMinor: command.amountMinor,
    signedAmountMinor: command.amountMinor,
    balanceAfterMinor,
    // ... remaining fields from command
  })
}

export function decideConfirm(
  state: SettlementState
): Result<StatusTransition, LedgerError> {
  if (state.status !== "pending")
    return Err(new LedgerError("SETTLEMENT_INVALID_TRANSITION"))
  return Ok({ from: "pending", to: "confirmed" })
}

export function decideReverse(
  state: SettlementState,
  reason: string
): Result<ReversalPlan, LedgerError> {
  if (state.status === "reversed")
    return Err(new LedgerError("SETTLEMENT_INVALID_TRANSITION"))
  return Ok({
    from: state.status,
    to: "reversed",
    reason,
    reversalEntries: /* one reversal entry per settlement line, opposite sign */,
  })
}
```

Types (`LedgerState`, `SettlementState`, `NewDebitEntry`, `StatusTransition`,
`ReversalPlan`) live in `internal/services/src/ledger/types.ts`. They are
ledger-internal — NOT exported to other services.

**Step B: Refactor shell methods.**

Refactor `postDebit` / `postCredit` in `service.ts` to call the pure functions:

```typescript
async postDebit(input) {
  return this.db.transaction(async (tx) => {
    // 1. lock + query (shell)
    const ledger = await this.acquireLedgerLock(tx, input)
    const entries = await this.getEntries(tx, ledger.id)
    // 2. fold (pure)
    const state = foldLedgerState(entries)
    // 3. decide (pure)
    const decision = decideDebit(input, state)
    if (decision.err) return decision
    // 4. persist (shell)
    return this.persistEntry(tx, ledger, decision.val)
  })
}
```

**Step C: Add settlement methods.**

Replace `markSettled()` and add new methods to
`internal/services/src/ledger/service.ts`:

```typescript
// Replace markSettled with:
settleEntries(input: {
  projectId: string
  ledgerId: string
  entryIds: string[]
  type: LedgerSettlementType        // "invoice" | "manual" | "wallet" | ...
  artifactId: string                // invoice ID, wallet txn ID, etc.
  db?: DbExecutor
}): Promise<Result<LedgerSettlement>>
// Creates ledger_settlement + ledger_settlement_lines
// Decrements ledger.unsettledBalanceCents
// Validates entries exist and are not already fully settled

confirmSettlement(input: {
  projectId: string
  artifactId: string
  type: LedgerSettlementType
  db?: DbExecutor
}): Promise<Result<LedgerSettlement>>
// Transitions status: pending → confirmed
// Logs transition in metadata.transitions[]
// Returns Err on invalid transition

reverseSettlement(input: {
  projectId: string
  artifactId: string
  type: LedgerSettlementType
  reason: string
  db?: DbExecutor
}): Promise<Result<{ settlement: LedgerSettlement; reversalEntries: LedgerEntry[] }>>
// 1. Reads settlement + settlement_lines for this artifact
// 2. Posts reversal entries (opposite sign, sourceType: "reversal_v1")
// 3. Creates new settlement with status: "reversed", reversesSettlementId: original.id
// 4. Original entries and settlement stay untouched
// 5. Reversal entries born unsettled (join unsettled pool)

reconcileUnsettledBalance(input: {
  projectId: string
  ledgerId: string
  db?: DbExecutor
}): Promise<Result<{ previous: number; reconciled: number }>>
// Computes correct value: SUM(signedAmountCents) for entries with
// no settlement_line, then updates ledger.unsettledBalanceCents
// Returns both values so drift is observable

getUnsettledEntries(input: {
  projectId: string
  customerId: string
  currency: Currency
  statementKey?: string
  subscriptionId?: string
  db?: DbExecutor
}): Promise<Result<LedgerEntry[]>>
// WHERE NOT EXISTS (SELECT 1 FROM ledger_settlement_lines
//   WHERE ledgerEntryId = entry.id AND projectId = entry.projectId)
// Index on settlement_lines(projectId, ledgerEntryId) makes this efficient
```

**Settlement status transitions enforced in LedgerService**:
- `pending → confirmed` (valid — payment success)
- `pending → reversed` (valid — payment failure before confirmation)
- `confirmed → reversed` (valid — chargeback/dispute)
- `reversed → *` (invalid — terminal state, re-settlement creates new record)

**Files changed**:
- `internal/services/src/ledger/core.ts` — new: pure fold/decide functions
- `internal/services/src/ledger/types.ts` — new: `LedgerState`, `SettlementState`, `NewDebitEntry`, `StatusTransition`, `ReversalPlan`
- `internal/services/src/ledger/service.ts` — refactored shell methods, new settlement methods, replace markSettled
- `internal/services/src/ledger/errors.ts` — new error codes:
  `SETTLEMENT_INVALID_TRANSITION`, `SETTLEMENT_NOT_FOUND`, `ENTRY_ALREADY_SETTLED`

### Slice 3: Move webhook settlement into LedgerService

**Remove** from `process-webhook-event.ts` (lines 127-215):
- `confirmLedgerSettlementByInvoiceId()` — replaced by
  `ledgerService.confirmSettlement()`
- `reopenLedgerSettlementByInvoiceId()` — replaced by
  `ledgerService.reverseSettlement()`

**Update** `applyWebhookEvent()` in `process-webhook-event.ts`:
- `payment.succeeded` → `deps.services.ledger.confirmSettlement({
  artifactId: invoiceId, type: "invoice" })`
- `payment.failed` / `payment.reversed` → `deps.services.ledger.reverseSettlement({
  artifactId: invoiceId, type: "invoice", reason })`
- Remove all direct `ledgerEntries` and `ledgers` table access

**Deps change**: `ProcessWebhookEventDeps` needs
`services: Pick<ServiceContext, "ledger">` instead of raw `db` for settlement
operations.

**Files changed**:
- `internal/services/src/use-cases/payment-provider/process-webhook-event.ts`

### Slice 4: Fixed precision (scale 6, bigint)

**Schema changes** (`internal/db/src/schema/ledger.ts`):
- `ledger_entries`: `amountCents`, `signedAmountCents`, `balanceAfterCents`,
  `unitAmountCents`, `amountSubtotalCents`, `amountTotalCents` → `bigint`
- `ledgers`: `balanceCents`, `unsettledBalanceCents` → `bigint`

**Add** to `internal/db/src/utils.ts`: `LEDGER_INTERNAL_SCALE`,
`formatAmountForLedger`, `ledgerAmountToDinero`, `ledgerAmountToCents` (see
Dinero.js section above for implementations).

**Callers updated**:
- `subscriptions/invokes.ts`: `formatAmountDinero(charge.price.totalPrice.dinero).amount`
  → `formatAmountForLedger(charge.price.totalPrice.dinero).amount`
- `bill-meter-fact.ts`: same replacement
- Invoice projection in `invokes.ts` (line 628-651): convert scale-6 entry
  amounts to scale-2 via `ledgerAmountToCents()` when populating `invoice_items`

**Files changed**:
- `internal/db/src/schema/ledger.ts`
- `internal/db/src/utils.ts`
- `internal/services/src/subscriptions/invokes.ts`
- `internal/services/src/use-cases/billing/bill-meter-fact.ts`

### Slice 5: Journal grouping + meter-fact attribution

**Add** to `ledger_entries`: `journalId varchar(64)` (nullable)
**Add** index: `(projectId, journalId) WHERE journal_id IS NOT NULL`

**Update `LedgerService`**:
- `postDebit` / `postCredit` accept optional `journalId`
- Add `getEntriesByJournal(projectId, journalId)` method
- Add `settleJournal(projectId, journalId, ...)` convenience method

**Update `billMeterFact`** (`bill-meter-fact.ts`):
- Populate `subscriptionId`, `subscriptionItemId` from grant context
- Populate `statementKey` from subscription billing config
- Generate `journalId` from billing fact identity for multi-dimensional grouping

This requires `billMeterFact` to receive subscription context from the billing
fact. Update `MeterBillingFact` type to carry optional `subscription_id` and
`subscription_item_id` fields — resolved from the grant context in the Durable
Object at outbox write time.

**Files changed**:
- `internal/db/src/schema/ledger.ts`
- `internal/services/src/ledger/service.ts`
- `internal/services/src/use-cases/billing/bill-meter-fact.ts`

### Slice 6: Adapt subscription invoicing to new schema

**Update `invoiceSubscription` in `invokes.ts`**:

1. Use `formatAmountForLedger` instead of `formatAmountDinero` for ledger posting
2. Convert scale-6 → scale-2 when building invoice_items (via `ledgerAmountToCents`)
3. Set `ledgerEntryId` on each invoice_item for traceability
4. Call `ledgerService.settleEntries()` instead of `ledgerService.markSettled()`
5. Handle reversal entries in projection: `sourceType: "reversal_v1"` → `kind: "refund"`

Verify the flow end-to-end:
- Rate billing period → post ledger debit (scale 6) → read unsettled
  entries → project invoice items (scale 2) → settle entries → confirm via webhook

**Files changed**:
- `internal/services/src/subscriptions/invokes.ts`

### Slice 7: Pure-function unit tests + integration tests against real Postgres

**Unit tests for fold/decide (fast, no DB):**

Add `internal/services/src/ledger/core.test.ts`:

- `foldLedgerState`: empty entries → zero balance; mixed debits/credits →
  correct signed sum; entries with settlement lines → correct unsettled balance
- `decideDebit`: zero amount → Err; negative → Err; valid → Ok with correct
  `balanceAfterMinor`; sub-cent precision preserved at scale 6
- `decideConfirm`: pending → Ok; confirmed → Err; reversed → Err
- `decideReverse`: pending → Ok with reversal entries; confirmed → Ok;
  reversed → Err (terminal); reversal entries have opposite sign and correct
  `sourceType: "reversal_v1"`
- `foldSettlementState`: correct total, line count, transition history

These are the fast tests that cover the combinatorial explosion of business
rules. They run in milliseconds with zero infrastructure.

**Integration tests against real Postgres:**

The current test suite mocks the entire DB layer. The critical ledger
invariants (`SELECT FOR UPDATE` serialization, `onConflictDoNothing`
idempotency, transaction isolation) are not tested.

Add integration tests using the project's existing test database setup:

- **Idempotency**: same `sourceType:sourceId` posted twice → one entry, one
  balance update
- **Serialization**: concurrent debits to the same ledger → deterministic
  `balanceAfterCents` ordering
- **Settlement**: settle entries → settlement + lines created, entries untouched
- **Confirmation**: settle pending → confirm → verify status transition
- **Reversal**: settle → reverse → reversal entries created, originals untouched,
  unsettled balance restored, audit trail preserved (3 settlement records exist)
- **Invalid transition**: reversed → confirm → Err returned
- **Partial settlement**: entry with $50 → settle $30 via wallet → verify
  `amountMinor` on settlement line is $30, $20 unsettled
- **Reconciliation**: post entries, settle some, manually drift
  unsettledBalanceCents, call reconcile → correct value restored, drift reported
- **Precision**: post entry with sub-cent amount → read back → verify amount
  at scale 6 is correct
- **Journal grouping**: post 3 entries with same `journalId` → settle by
  journal → all 3 settled atomically

Keep the existing unit tests for fast feedback on business logic.

**Files changed**:
- `internal/services/src/ledger/core.test.ts` — new: pure fold/decide unit tests
- `internal/services/src/ledger/service.test.ts` — extend with integration tests

### Slice 8: Migration

Write a Drizzle migration that:

1. Add new `bigint` columns alongside existing `integer` columns (non-breaking)
2. Create `ledger_settlements` table
3. Create `ledger_settlement_lines` table
4. Add `journalId` column to `ledger_entries`
5. Add `ledgerEntryId` column to `invoice_items`
6. Backfill: `new_bigint_col = old_int_col * 10000` (scale 2 → scale 6)
7. Backfill: create `ledger_settlements` + `ledger_settlement_lines` from
   existing `settlementType`/`settledAt`/`settlementArtifactId` on entries
8. Deploy service changes (reads from new columns/tables)
9. Drop old settlement columns from `ledger_entries`
10. Drop old integer columns (replaced by bigint)
11. Drop the `ledger_settlement_type` enum type
12. Add new indexes (settlement indexes, journal index)

Migration order matters:
1. Add new columns and tables (non-breaking)
2. Backfill data
3. Deploy service changes
4. Drop old columns (breaking — after service is deployed)

**Files changed**:
- `internal/db/src/migrations/` — new migration file(s)

## Design Decisions & Resolved Criticisms

### unsettledBalanceCents: keep the counter, add reconciliation

The hand-maintained counter stays for the hot read path (`getUnsettledBalance`
must be fast for real-time billing decisions). But add
`reconcileUnsettledBalance()` to LedgerService that recomputes from
`SUM(signedAmountCents) WHERE NOT EXISTS(settlement_line)` and updates the
cache. Run periodically or on-demand when drift is suspected. Returns both
previous and reconciled values for observability.

### getUnsettledEntries: NOT EXISTS is fine with proper indexes

After settlement moves to its own table, "unsettled" = `WHERE NOT EXISTS
(SELECT 1 FROM ledger_settlement_lines WHERE ledgerEntryId = entry.id)`. With
an index on `settlement_lines(projectId, ledgerEntryId)`, Postgres executes
this as an anti-join, which is O(1) per entry row via index lookup. This does
NOT degrade as entries accumulate — the index on settlement_lines keeps the
lookup constant. The old partial index `WHERE settledAt IS NULL` was equivalent
performance. No LEFT JOIN needed.

### Settlement status: mutable, but logged

`ledger_settlements.status` is the ONE mutable field. This is a pragmatic
compromise: settlement status is operational metadata, not a financial fact.
Entry immutability is what matters for financial integrity. Each status
transition appends to `metadata.transitions[]` with timestamp and reason,
providing an inline audit trail without a separate events table.

### Invoice items stay materialized

Invoices are NOT refactored to pure projections in this phase. The
`ledgerEntryId` FK on `invoice_items` provides traceability without
restructuring. Phase 7 settlement router is the right time to revisit invoice
projection, when the 1:1 entry→item relationship breaks due to wallet
settlement.

## Execution Order

```
Slice 1 (schema) ──→ Slice 2 (LedgerService) ──→ Slice 3 (webhook encapsulation)
                                                       │
Slice 4 (precision) ────────────────────────────────── │ ──→ Slice 6 (adapt invoicing)
                                                       │
Slice 5 (journal + meter-fact) ────────────────────────┘
                                                       │
                                             Slice 7 (tests) ──→ Slice 8 (migration)
```

Slices 1-3 are P0 (settlement table — the 80% change).
Slice 4 is P1 (precision — can parallel with slices 2-3).
Slices 5-6 are P2 (attribution + invoicing adaptation).
Slices 7-8 are P3 (validation + deploy).

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/db typecheck`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter @unprice/services test`
- `pnpm --filter api test`
- `pnpm --filter api type-check`

## Exit Criteria

- Ledger entries are truly append-only — no mutation of any column on existing
  entries, ever
- Settlement state lives in append-only `ledger_settlements` +
  `ledger_settlement_lines` tables, not on entries
- Settlement has a defined state machine: pending → confirmed → reversed, with
  reversed as terminal. Invalid transitions rejected.
- Settlement reversals create reversal entries, preserving full audit trail
- All ledger mutations (post, settle, confirm, reverse) flow through
  `LedgerService` — no direct table updates elsewhere
- All amounts and balances use fixed internal precision (scale 6, bigint)
- `formatAmountForLedger` converts Dinero objects at the boundary; no Dinero.js
  inside `LedgerService`
- `ledgerAmountToCents` converts at the invoice projection boundary; invoice
  items store scale-2 for provider compatibility
- Entries can be grouped by `journalId` for multi-dimensional charges
- Settlement types are `varchar` validated by Zod, not a Postgres enum
- `invoice_items` has `ledgerEntryId` FK for traceability
- `reconcileUnsettledBalance` can detect and correct cache drift
- **fold/decide/shell separation**: business logic (`core.ts`) is pure and
  independently unit-testable; the shell (`service.ts`) handles only I/O and
  transactions. `foldLedgerState` can recompute balance from any set of entries.
  `decideConfirm` / `decideReverse` enforce the settlement state machine as
  pure functions.
- Pure-function unit tests cover balance folding, settlement transitions, and
  edge cases without DB setup
- Integration tests verify idempotency, serialization, reversal, settlement
  state machine, partial settlement, reconciliation, and precision against
  real Postgres
- Existing subscription invoicing flow works identically
- Meter-fact entries carry attribution context for future settlement routing

## Out Of Scope

- Wallet infrastructure (Phase 7 — depends on this phase)
- Settlement router (Phase 7)
- Credit lots / wallet grants (Phase 7)
- Invoice-as-pure-projection refactoring (Phase 7 — wait for settlement router)
- Financial guardrails and spend controls (Phase 8)
- Optimistic concurrency (replacing `SELECT FOR UPDATE` with sequence-number-based
  append — the fold/decide extraction makes this a mechanical swap later)
- Retroactive repricing / event replay
- Multi-currency conversion within the ledger
- Context table split (deferred until write pressure is measured)
- Generic accounts abstraction
- Double-entry postings
- Upgrading Dinero.js to v2 stable (can be done independently)

## Deferred to future phases

### Invoice projection refactoring (deferred to Phase 7)

After the settlement router exists and charges can be settled by wallet, invoice,
or one-time payment, the 1:1 relationship between ledger entries and invoice items
breaks. At that point, design the invoice projection as "all entries settled via
settlement type = invoice for this artifact" — which is exactly what
`ledger_settlement_lines` enables. See "The Case Against Refactoring Invoicing Now"
section for the full rationale.

### Context table split (deferred — not in Phase 6.5)

The current `ledger_entries` table carries attribution metadata (subscriptionId,
billingPeriodId, featurePlanVersionId, cycle dates, etc.) alongside financial
data. At AI scale with thousands of entries/minute, this wide table could become
a write bottleneck.

**Why deferred:** The context split adds joins and migration cost without solving
the main correctness issues (immutability, settlement model, precision). Solve
correctness first. When write pressure becomes measurable, split to a
`ledger_entry_context` table with a 1:1 FK.

### Volumes / input-output counters (not adopted)

Formance stores `input` (total deposits) and `output` (total withdrawals) per
account instead of a running balance. This is useful for generalized accounting
queries across many account classes but adds complexity we don't need.

If we want this later, add `totalDebitsMinor` and `totalCreditsMinor` as derived
projections on the `ledgers` table. Don't redesign around volumes.
