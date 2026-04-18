# Phase 6.6: Replace Hand-Rolled Ledger With pgledger

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
PR title: `feat: replace hand-rolled ledger with pgledger`
Branch: `feat/pgledger-core`

**Next:** [Phase 7](./unprice-phase-07-credits-wallets.md) rebuilds wallets,
credit grants, and the settlement router from scratch **on top of** the
gateway that lands here. Phase 6.6 is scoped to the ledger substrate only.

## Mission

Delete the hand-rolled ledger and replace it with a single typed
**`LedgerGateway`** over [pgledger](https://github.com/dynajoe/pgledger)
(or equivalent SQL-only distribution), plus a thin **`LedgerService`** that
owns customer / house transfers, refunds, and statement-key reads. Money is
a `Dinero<number>` end-to-end. One rollout, no dual-writes, no migration from
legacy tables — the branch wipes prior ledger state and starts clean.

Wallets and credit grants are **not** in scope. The previous wallet +
settlement modules have already been deleted from the tree; Phase 7 rebuilds
them from scratch against the contracts this phase publishes.

Outcome:

- Balance drift becomes impossible by construction (pgledger updates
  `account_current_balance` in the same SQL statement that inserts the entry,
  guarded by row versioning).
- Roughly 1k LOC of repository indirection, balance math, reconcile code, and
  settlement-state machinery deletes.
- True double-entry: every charge is a transfer between two named accounts
  (`customer:<id>` → `house:revenue`), so downstream P&L and revenue
  recognition queries become one `GROUP BY` over the pgledger entries view.
- Money stays `Dinero<number>` end-to-end — from rating through the gateway
  into pgledger's `numeric` column at scale 6 — and reconstructs losslessly
  on read. The ad-hoc `bigint` minor-unit / `cents` conversions that live at
  every module boundary today collapse into one gateway-level serializer.
- Phase 7 lands on a clean foundation: grant accounts, the waterfall
  decision, and WalletDO all compose against the same gateway this phase
  ships.

## Dependencies

- Phase 1 rating service (`rateIncrementalUsage`) — untouched.
- Phase 6 agent billing / `billMeterFact` use case — rewrites its ledger
  calls, keeps its shape.

Phases 4, 5, 6.5 hand-rolled ledger tables, settlement state machine, and
drift reconciliation: superseded by this phase. The wallet and settlement
modules those phases introduced have been removed from the tree and will be
reintroduced by **Phase 7** against this gateway.

## Read First

- [../../internal/services/src/ledger/service.ts](../../internal/services/src/ledger/service.ts)
- [../../internal/services/src/ledger/core.ts](../../internal/services/src/ledger/core.ts)
- [../../internal/services/src/ledger/repository.ts](../../internal/services/src/ledger/repository.ts)
- [../../internal/services/src/use-cases/billing/bill-meter-fact.ts](../../internal/services/src/use-cases/billing/bill-meter-fact.ts)
- [../../internal/db/src/migrate.ts](../../internal/db/src/migrate.ts) — the
  `pnpm migrate:custom` entrypoint that will also install pgledger.
- [../../internal/db/src/schema/ledger.ts](../../internal/db/src/schema/ledger.ts)
  — the legacy schema this phase drops.
- pgledger source SQL (to be vendored into
  `internal/db/src/migrations/pgledger/`).

## Guardrails

- One rollout. No feature flag, no dual-write, no shim to the old `ledgers`
  or `ledger_entries` tables. The branch drops them outright.
- pgledger must be distributed as plain SQL (`\i pgledger.sql`) so it runs
  on Neon, Supabase, and local Postgres without platform-specific extension
  allowlists. Verify before slice 1.
- Vendor pgledger's SQL into the repo under
  `internal/db/src/migrations/pgledger/` with a pinned version hash. The
  project owns the SQL — forkable at any time.
- All pgledger access goes through a single typed gateway. No raw
  `db.execute` calls to pgledger functions from services, use cases, or
  adapters.
- No `balance` / `remaining` / `lifetime_*` columns anywhere. Anything that
  needs a balance reads from the gateway.
- Idempotency is enforced at the ledger-write boundary. Every transfer
  carries `(project_id, source_type, source_id)` in metadata and is deduped
  via a unique index before reaching pgledger.
- `Dinero<number>` is the canonical money type at every module boundary
  (rating, ledger gateway, use cases, future wallet + settlement).
  Plain numbers, `bigint` minor units, and "cents" are forbidden outside
  the gateway's serialization helpers. `formatAmountForLedger` and
  `ledgerAmountToCents` in `@unprice/db/utils` get deleted — the gateway
  owns the conversion.
- pgledger install happens in the `migrate:custom` script
  (`internal/db/src/migrate.ts`). Fresh environments bootstrap the ledger
  schema by running `pnpm migrate:custom` alongside Drizzle migrations. The
  rollout assumes a database reset — there is no migration-time bulk seed
  of house accounts over existing projects. The four canonical house
  accounts per `(project, currency)` are ensured idempotently on first use
  at runtime (see `gateway.seedHouseAccounts`).
- No TypeScript `any`. Pgledger's numeric-as-string responses are narrowed
  at the gateway edge into `Dinero<number>` with the account's currency.
- The gateway is **wallet-agnostic**. It knows about account kinds and
  currencies, not about grants, burn rates, or wallet rows. Phase 7 composes
  wallet semantics on top; 6.6 does not pre-bake them.

## Scope in one table

| | **In scope (6.6)** | **Out of scope (deferred to Phase 7)** |
|--|---|---|
| Infra | Install pgledger via `migrate:custom`. Vendor SQL + VERSION file. | — |
| Data | `ledger_idempotency` table. Drop legacy ledger tables. | `wallets`, `credit_grants`, `credit_burn_rates` tables. |
| TS | `LedgerGateway`, `LedgerService`, `accounts.ts`, `money.ts`. | `WalletService`, `WalletGateway`, `SettlementRouter`, WalletDO. |
| Accounts | `house:*` (4 kinds), `customer:<id>:<currency>`. Seeded on demand. | `grant:<grant_id>` accounts. |
| Flows | Usage charge (customer→revenue), refund/reversal (revenue→customer). | Credit grant issuance, credit burn waterfall, grant expiry / revocation. |
| Use cases | `bill-meter-fact.ts` rewritten. | `purchase-credits.ts`, DO outbox flush, grant expiry cron. |

## The Model

### Account taxonomy (per project, per currency)

Defined in this phase:

| Account key | `allow_negative` | Purpose |
|---|---|---|
| `house:revenue:<project_id>:<currency>` | `true` | Revenue sink. Receives charges. |
| `house:credit_issuance:<project_id>:<currency>` | `true` | Source for funded credit grants. Seeded now; no transfers post to it until Phase 7. |
| `house:expired_credits:<project_id>:<currency>` | `true` | Sink for expired grant remainders. Seeded now; unused until Phase 7. |
| `house:refunds:<project_id>:<currency>` | `true` | Source for refund transfers. |
| `customer:<customer_id>:<currency>` | `true` | One per customer. Negative balance = receivables. Created on demand. |

Reserved for Phase 7 (documented here as a forward-looking contract, **not**
implemented now):

| Account key | `allow_negative` | Purpose |
|---|---|---|
| `grant:<grant_id>` | `false` | One per credit grant. Pgledger rejects overdraw. |

`allow_positive_balance` is `true` everywhere — unused but left at the
default.

### Flow: usage charge (invoice / receivables mode)

```
rating → transfer(customer:<id> → house:revenue, amount, metadata={
  source_type: "meter_fact_v1",
  source_id:  "<project>:<customer>:<feature>:<idempotency_key>",
  subscription_id, subscription_item_id, feature_plan_version_id,
  statement_key,
  dinero: { amount, scale: 6, currency }
})
```

The customer account balance goes more negative by `amount`. At invoice
time, the invoicing use case queries `pgledger_entries_view` filtered by
`metadata->>'statement_key'` to enumerate uncollected charges. Payment is a
transfer in the opposite direction (recorded through the adapter that
reconciles provider payouts — not in this phase).

### Flow: refund / reversal

```
transfer(house:revenue → customer:<id>, amount, metadata={
  source_type: "reversal_v1",
  source_id:   "<original_transfer_id>",
  dinero: { amount, scale: 6, currency }
})
```

No `ledger_settlements` table. No status machine. A refund is just another
transfer pointing at the original via metadata.

### Flow: credit issuance / burn (documented, deferred to Phase 7)

Included here so the gateway's shape does not have to change when Phase 7
lands. The gateway and account taxonomy already support these flows — Phase
7 writes the orchestration.

- **Issuance:**
  `transfer(house:credit_issuance → grant:<grant_id>, amount, metadata={
    source_type:'credit_purchase', source_id:'<provider_invoice_id>',
    wallet_id, expires_at, priority, dinero:{...} })`
- **Burn (waterfall):**
  `createTransfers([ transfer(grant:<g1> → house:revenue, line_1, ...),
    transfer(grant:<g2> → house:revenue, line_2, ...), ... ])`
  One `pgledger_create_transfers` call per burn event; grant accounts have
  `allow_negative_balance=false`, so overdraw rejects at the SQL boundary.
- **Expiry:**
  `transfer(grant:<id> → house:expired_credits, remaining, metadata={
    source_type:'grant_expiry', source_id:'expire:<grant_id>:<expires_at>' })`.

### Money modeling (Dinero end-to-end)

Money crosses every module boundary as `Dinero<number>`. The gateway is the
only place that serializes it for storage and deserializes it on read.

Canonical internal scale: `LEDGER_INTERNAL_SCALE = 6`. 1 USD = `1.000000`
at scale 6, which handles sub-cent AI pricing (e.g. $0.003/token) without
precision loss and matches what pgledger's `numeric` column stores
natively.

Write path (`gateway.createTransfer(..., amount: Dinero<number>, ...)`):

1. Validate `amount.currency.code` matches the `from` and `to` account
   currencies. Reject at the gateway, not deeper.
2. `transformScale(amount, LEDGER_INTERNAL_SCALE, up)` to normalize
   precision on the way in.
3. `toDecimal(scaled)` yields a lossless decimal string like `"0.003000"`.
4. Pass the string into `pgledger_create_transfer(..., ${decimal}::numeric,
   ...)`. pgledger's `numeric` column stores the value exactly.
5. Persist a round-trip snapshot into the transfer's `metadata`:
   `{ dinero: { amount: <integer>, scale: 6, currency: '<ISO>' },
   source_type, source_id, ... }`. The snapshot is redundant with the
   numeric column but makes replays trivial — the snapshot is the source
   of truth for reconstruction and the numeric column is the source of
   truth for balances.

Read path (`gateway.getEntries`, `gateway.getAccountBalance`):

1. Read `amount` as a numeric string and the account's `currency` column.
2. Reconstruct via `fromLedgerAmount(str, currency)` in `money.ts`. Prefer
   reading the `dinero` snapshot from metadata when present — it's exact by
   construction.
3. Return `Dinero<number>`. Callers never see the numeric string.

Consequences:

- `@unprice/db/utils#formatAmountForLedger`, `ledgerAmountToDinero`, and
  `ledgerAmountToCents` delete. Their callers (currently
  `bill-meter-fact.ts`) switch to passing the `Dinero<number>` straight
  through.
- `amountMinor: bigint` fields disappear from every ledger-facing type.
  Wherever a caller needed "the amount," it gets a `Dinero<number>`.
- Invoice / Stripe projection (future) reads the Dinero, converts to
  provider scale (`2` for Stripe) at the Stripe adapter boundary — not at
  the ledger boundary.

### Idempotency

One Postgres table `ledger_idempotency`:

```sql
CREATE TABLE ledger_idempotency (
  project_id   text   NOT NULL,
  source_type  text   NOT NULL,
  source_id    text   NOT NULL,
  transfer_id  uuid   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_type, source_id)
);
```

Gateway wraps every transfer in: `INSERT INTO ledger_idempotency ... ON
CONFLICT DO NOTHING RETURNING transfer_id`. If the insert returned a row,
call `pgledger_create_transfer` and link the returned id. If the insert
conflicted, select the existing `transfer_id` and return the prior
result. Same pattern for the batched `createTransfers` — one idempotency
row per line (sharing the same `source_id` is allowed when lines share a
source, but `source_type` + `source_id` + line index must be unique).

## Primary Touchpoints

### New files

- `internal/db/src/migrations/pgledger/pgledger.sql` — vendored pgledger
  SQL with pinned version hash.
- `internal/db/src/migrations/pgledger/VERSION` — pinned upstream commit.
- `internal/db/src/schema/ledger-idempotency.ts` — the idempotency table.
- `internal/services/src/ledger/gateway.ts` — typed wrapper over pgledger
  functions. All money flows as `Dinero<number>`; gateway serializes to
  numeric at scale 6 internally. Methods: `createAccount`,
  `createTransfer`, `createTransfers`, `getAccount`, `getAccountBalance`,
  `getEntries`, `getEntriesBySource`, `getEntriesByStatementKey`,
  `seedHouseAccounts(projectId, currency)`. ~200 LOC including Dinero
  (de)serialization helpers. Public API stable across Phase 6.6 and Phase 7.
- `internal/services/src/ledger/accounts.ts` — pure helpers that build the
  canonical account keys (`customerAccountKey`, `houseAccountKey`, plus
  `grantAccountKey` exported as a forward-looking helper for Phase 7) and
  the canonical set of house-account kinds per `(project, currency)`.
- `internal/services/src/ledger/money.ts` — `toLedgerAmount(Dinero) →
  string` and `fromLedgerAmount(string, Currency) → Dinero` helpers, used
  only by the gateway. The rest of the codebase never imports this file.

### Rewritten files

- `internal/services/src/ledger/service.ts` — shrinks from 634 → ~150 LOC.
  Methods: `postCharge(customerId, amount: Dinero, ...)`, `postRefund`,
  `getCustomerBalance() → Dinero`, `getEntriesBySource`,
  `getEntriesByStatementKey`. All delegate to the gateway. No credit or
  grant methods — those live on `WalletService` in Phase 7.
- `internal/services/src/ledger/core.ts` — shrinks from 100 → ~20 LOC.
  Only amount validators remain; `decideDebit`/`decideCredit`/
  `foldLedgerState` go away (pgledger does the math).

### Cross-cutting (use cases + DB tooling)

- `internal/services/src/use-cases/billing/bill-meter-fact.ts` — updated to
  pass the rating result's `Dinero` straight through to `postCharge`. Drops
  the `formatAmountForLedger` + `BigInt(amount)` conversions and the
  `amountMinor: bigint` field on `BillMeterFactOutput`. Return becomes
  `{ amount: Dinero<number>, sourceId, state }`.
- `internal/db/src/migrate.ts` — extended to execute the vendored
  `pgledger.sql` idempotently at migration time. Runs as part of `pnpm
  migrate:custom`. No house-account enumeration over `projects`; the
  reset rollout does not backfill accounts at migrate time.
- `@unprice/db/utils` — `formatAmountForLedger`, `ledgerAmountToDinero`,
  `ledgerAmountToCents`, `LEDGER_INTERNAL_SCALE` delete. The scale
  constant moves into `internal/services/src/ledger/money.ts` as a
  gateway-private value.

### Deleted files

- `internal/services/src/ledger/repository.ts`
- `internal/services/src/ledger/repository.drizzle.ts`
- `internal/services/src/ledger/repository.memory.ts`
- `internal/services/src/ledger/service.test.ts` (rewritten much smaller)
- `internal/services/src/ledger/core.property.test.ts` (invariants now
  live in pgledger's own tests)
- `internal/services/src/ledger/core.test.ts` (most cases obsolete; any
  surviving validator cases fold into a small new test)
- `internal/services/src/ledger/types.ts` (replaced by gateway-local types)
- `internal/db/src/schema/ledger.ts` — tables `ledgers`, `ledger_entries`,
  `ledger_settlements`, `ledger_settlement_lines`.

## Hooks for Phase 7

Published by this phase so Phase 7 slots in cleanly without touching 6.6
code:

1. **`grantAccountKey(grantId)` helper** exported from
   `ledger/accounts.ts` returning `grant:<grant_id>`. Phase 7 imports it;
   6.6 does not call it internally. Keeping the helper co-located with the
   other account-key builders prevents a Phase 7 fork of the same naming
   convention.
2. **Idempotent `seedHouseAccounts(projectId, currency)`** already seeds
   `house:credit_issuance` and `house:expired_credits` even though 6.6
   posts no transfers to them. Phase 7's `WalletService.addCredits` /
   grant-expiry cron can assume those house accounts exist after the first
   ledger call for any `(project, currency)` pair, without coordinating
   with this phase.
3. **Forward-looking metadata keys** (`wallet_id`, `grant_id`,
   `expires_at`, `priority`) are documented in this doc as the canonical
   shape. The gateway accepts arbitrary `metadata: Record<string, unknown>`
   — Phase 7 populates these keys without gateway changes.
4. **`createTransfers` batch API** is implemented in 6.6 even though no
   6.6 call path uses it. Phase 7's burn waterfall calls `createTransfers`
   with N lines in one SQL round trip; shipping the batch path now avoids
   a gateway API extension in Phase 7.
5. **`getAccountBalance(accountKey) → Dinero`** is implemented and
   covered by integration tests in 6.6. Phase 7's `WalletService.getBalance`
   sums over grant account balances via this gateway method plus a
   Phase-7-owned Drizzle query that enumerates the wallet's grants.
6. **`grant:*` accounts have `allow_negative_balance=false`** documented as
   the contract Phase 7 must pass when it first calls `createAccount`.
   pgledger enforces this at the SQL level — the contract is a reminder,
   not a runtime check on 6.6's side.

Phase 7 must **not** modify:

- `LedgerGateway` public surface (extend by adding methods, never by
  changing existing signatures).
- The account-key builders in `ledger/accounts.ts`.
- The Dinero serialization in `ledger/money.ts`.

If Phase 7 discovers the gateway is missing something, the fix is a new
gateway method, not a carve-out that bypasses it.

## Execution Plan

### Slice 1: Install pgledger via custom migration

1. Verify pgledger installs as plain SQL (no superuser / extension
   allowlist). If it requires `CREATE EXTENSION`, stop and revisit.
2. Vendor the upstream SQL under
   `internal/db/src/migrations/pgledger/pgledger.sql` plus a `VERSION`
   file recording the upstream commit hash.
3. Add a Drizzle migration (next numbered file in
   `internal/db/src/migrations/`) that creates only the
   `ledger_idempotency` table. Drizzle stays responsible for schema
   managed by the app.
4. Extend `internal/db/src/migrate.ts` (the `pnpm migrate:custom`
   entrypoint) so that, after `migrate(db, { migrationsFolder })` runs,
   it also:
   - Reads `migrations/pgledger/pgledger.sql` from disk and executes it
     wrapped in a transaction. The file must be idempotent — pgledger's
     SQL uses `CREATE ... IF NOT EXISTS` and `CREATE OR REPLACE FUNCTION`,
     so re-running it is safe.
   - Logs the installed pgledger `VERSION` and refuses to downgrade
     (compare against a `pgledger_install_version(text)` row inserted on
     first run).
5. Fresh environments bootstrap with `pnpm migrate:custom` as a single
   command. No separate pgledger install step, no manual `psql \i`.

### Slice 2: Gateway + Dinero boundary

1. Write `internal/services/src/ledger/money.ts` —
   `toLedgerAmount(Dinero) → string` (uses `transformScale(..., 6, up)`
   then `toDecimal`) and `fromLedgerAmount(numericString, Currency) →
   Dinero<number>`. Property tests: round-trip preserves the amount for
   all supported currencies including zero, sub-cent (0.000001), and
   large values.
2. Write `internal/services/src/ledger/accounts.ts` — all canonical key
   builders including `grantAccountKey` (exported for Phase 7 use) plus
   the `HOUSE_ACCOUNT_KINDS` enum used by `seedHouseAccounts`.
3. Write `internal/services/src/ledger/gateway.ts`: one class, one
   dependency (`Database`). All public methods take/return
   `Dinero<number>`. Methods as listed in "New files". Idempotency:
   `INSERT INTO ledger_idempotency ... ON CONFLICT DO NOTHING RETURNING
   transfer_id` before every write; if conflict, return the prior
   transfer_id's entry.
4. On every write, persist a `dinero: { amount, scale, currency }`
   snapshot into the transfer metadata alongside `source_type` /
   `source_id`. On read, prefer the metadata snapshot over the numeric
   column for reconstruction.
5. Implement `createTransfers(batch)` as one SQL call to
   `pgledger_create_transfers` inside one transaction. Shape the input so
   Phase 7 can use it directly for the burn waterfall.
6. Integration-test the gateway against local Postgres (the existing
   `createConnection` helper). Cover: idempotent replay returns the same
   transfer, `allow_negative_balance=false` on a test grant account
   rejects overdraw, concurrent transfers honor pgledger's version field,
   Dinero round-trips losslessly across write+read for sub-cent amounts,
   currency mismatch between Dinero and account rejects at the gateway
   before reaching pgledger, `createTransfers` atomically rolls back all
   lines if any one line fails.

### Slice 3: Runtime house accounts (no migrate-time seed)

1. Implement `gateway.seedHouseAccounts(projectId, currency)`.
   Idempotently creates the four canonical house accounts for the tuple:
   `house:revenue`, `house:credit_issuance`, `house:expired_credits`,
   `house:refunds`. All `allow_negative_balance=true`.
2. `LedgerService` calls `seedHouseAccounts` before the first transfer
   for each `(project, currency)` pair. Caching per-process via a
   `Set<string>` (keyed by `projectId:currency`) is enough to skip the
   round trip after first use. Phase 7's `WalletService` does the same
   against the same method.
3. Do not enumerate `projects` in `migrate.ts` for this rollout — the
   database is reset with the branch; there is no backfill of house
   accounts at install time.

### Slice 4: Rewrite LedgerService

1. Reduce the public API to: `postCharge(customerId, amount, ...)`,
   `postRefund(originalTransferId, amount, ...)`,
   `getCustomerBalance(customerId, currency) → Dinero`,
   `getEntriesBySource(sourceType, sourceId)`,
   `getEntriesByStatementKey(statementKey)`. Every call delegates to the
   gateway. No transactions opened at this layer — pgledger functions
   are atomic per call.
2. Ensure customer accounts are created on demand:
   `gateway.createAccount(customerAccountKey(customerId, currency),
   currency, allow_negative=true)` before the first charge, cached
   per-process by key.
3. Collapse `core.ts` to amount validators (positive-only for charges,
   positive-only for refunds). Everything else leaves.
4. Rewrite `service.test.ts` as a short integration suite: post charge,
   post refund referencing a prior transfer, query by source, query by
   statement key, idempotent replay returns the existing transfer, unseen
   `(project, currency)` triggers house-account seeding exactly once.
5. Delete `repository.ts`, `repository.drizzle.ts`, `repository.memory.ts`,
   `types.ts`, and the old property tests.

### Slice 5: Rewrite bill-meter-fact use case

1. Update `internal/services/src/use-cases/billing/bill-meter-fact.ts`:
   - Pass `ratingResult.val.deltaPrice.totalPrice.dinero` straight
     through to `deps.services.ledger.postCharge({ customerId, currency,
     amount: Dinero, sourceType: 'meter_fact_v1', sourceId, statementKey,
     metadata })`.
   - Change `BillMeterFactOutput` from `{ amountMinor: bigint, sourceId,
     state }` to `{ amount: Dinero<number>, sourceId, state }`.
   - Remove the `formatAmountForLedger` import and the
     `BigInt(amount)` conversion.
   - The zero-amount guard stays — check `isZero(ratingResult...dinero)`
     instead of `amountMinor <= 0n`.
2. Update every caller of `billMeterFact` to handle `Dinero<number>`
   instead of `bigint`. At time of writing the caller set is internal to
   `services/src/billing/*` and the agent-billing DO path; adapters that
   format for display stay at the edge.
3. Delete `@unprice/db/utils#formatAmountForLedger`,
   `ledgerAmountToDinero`, `ledgerAmountToCents`, and the exported
   `LEDGER_INTERNAL_SCALE` constant. Move the scale constant into
   `internal/services/src/ledger/money.ts` as a module-private value.

### Slice 6: Delete legacy state

1. Drop legacy Drizzle tables `ledgers`, `ledger_entries`,
   `ledger_settlements`, `ledger_settlement_lines` in one migration.
   Delete `internal/db/src/schema/ledger.ts`.
2. Delete all TS references (schemas, validators, types, exports) to the
   dropped tables.
3. `knip` + `tsc` + `pnpm test` green.

## Acceptance

- `grep -r "reconcileBalance\|balance_cents\|lifetime_credits_cents\|ledger_settlements\|formatAmountForLedger\|ledgerAmountToCents\|amountMinor" internal/`
  returns nothing outside the gateway's private `money.ts`.
- `wc -l internal/services/src/ledger/*.ts` is under 500 total (down
  from ~2000). The only files present are
  `gateway.ts`, `service.ts`, `core.ts`, `accounts.ts`, `money.ts`,
  `errors.ts`, `index.ts`, and their tests.
- `pnpm migrate:custom` on a fresh Postgres produces: pgledger functions
  + views installed, and the `ledger_idempotency` table exists. House
  accounts appear when the first ledger operation runs for a `(project,
  currency)` pair (via `seedHouseAccounts`), not during migrate.
- Re-running `pnpm migrate:custom` is a no-op (idempotent pgledger
  install, no duplicate schema objects).
- Property test: `fromLedgerAmount(toLedgerAmount(d)) === d` for every
  supported currency and for amounts including 0, 1 minor unit, sub-cent
  (e.g. $0.000001), $999.999999, and large values.
- Integration test: post 1000 concurrent meter charges for the same
  customer using `Dinero<number>` inputs including sub-cent amounts;
  final `customer:<id>` account balance equals `-sum(amounts)` as Dinero
  with zero drift, zero duplicates.
- Integration test: every transfer's metadata contains a `dinero`
  snapshot that reconstructs to the same Dinero passed at write time.
- Integration test: `gateway.createTransfers` on a batch where one line
  would overdraw a non-negative-allowed test account rolls back all
  other lines in the batch.
- Integration test: `seedHouseAccounts` is safe to call concurrently from
  two workers — no duplicate-key errors, exactly four accounts per
  `(project, currency)`.
- `pgledger_entries_view` + `metadata->>'statement_key'` returns the same
  charges the old `findUnsettledEntries` returned for a given
  customer/window (checked against a fixture snapshot).
- `WalletService` and `SettlementRouter` do **not** exist in the tree at
  the end of this phase (they return in Phase 7). `bill-meter-fact.ts`
  does not import anything called "wallet" or "settlement".

## Non-Goals

- No migration of historical data. Existing ledger state is discarded
  when the branch lands.
- No wallet, credit-grant, settlement-router, or WalletDO code. Those
  land in Phase 7 against this gateway.
- No change to rating, ingestion, entitlements, payment-provider, or
  subscription code beyond what's required to swap `amountMinor: bigint`
  for `amount: Dinero<number>` at call sites of `billMeterFact`.
- No DO-side changes in this phase. Phase 7 introduces WalletDO.
