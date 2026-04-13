# Phase 7: Credits, Wallets & Settlement Router

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add credits, wallets, and settlement router`  
Branch: `feat/credits-wallets`

## Mission

Add prepaid credits as the universal billing abstraction for AI workloads.
Credits decouple customer-facing pricing from volatile underlying costs. Introduce
the settlement router that decides how rated charges are collected: via invoice,
wallet deduction, or one-time provider charge.

Real-time wallet balance enforcement happens at the edge via a Durable Object
(`WalletDO`), mirroring the proven `EntitlementWindowDO` pattern: state lives
in the DO for fast reads, an outbox flushes authoritative settlements to
Postgres.

## Dependencies

- Phase 4 for `LedgerService`
- Phase 5 for settlement webhooks (credit purchase confirmation)
- Phase 6 for `billMeterFact` use case (agent/meter billing)
- Phase 6.5 for append-only settlement tables and fold/decide pattern

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
- **reading wallet balance from Postgres on every meter event kills the latency
  advantage of DOs** — the wallet state must be at the edge

## Read First

- [../../internal/services/src/ledger/service.ts](../../internal/services/src/ledger/service.ts)
- [../../internal/db/src/schema/ledger.ts](../../internal/db/src/schema/ledger.ts)
- [../../internal/db/src/schema/invoices.ts](../../internal/db/src/schema/invoices.ts) — existing `creditGrants` and `invoiceCreditApplications` tables (to be replaced)
- [../../internal/services/src/use-cases/billing/bill-meter-fact.ts](../../internal/services/src/use-cases/billing/bill-meter-fact.ts)
- [../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts](../../internal/services/src/use-cases/payment-provider/process-webhook-event.ts)
- [../../internal/services/src/payment-provider/interface.ts](../../internal/services/src/payment-provider/interface.ts)
- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts) — reference pattern for WalletDO
- [../../apps/api/src/ingestion/entitlements/db/schema.ts](../../apps/api/src/ingestion/entitlements/db/schema.ts) — DO SQLite schema pattern
- [`ricofritzsche/eventstore-typescript`](https://github.com/ricofritzsche/eventstore-typescript) — fold/decide/shell pattern reference
- [./unprice-phase-04-ledger-foundation.md](./unprice-phase-04-ledger-foundation.md)
- [./unprice-phase-05-settlement-webhooks.md](./unprice-phase-05-settlement-webhooks.md)
- [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md)
- [./unprice-phase-06.5-ledger-hardening.md](./unprice-phase-06.5-ledger-hardening.md)

## Two-Layer Architecture: WalletDO + WalletService

The wallet uses the same two-layer architecture as entitlement metering:

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
                       │  (ACID transactions, ledger posts,    │
                       │   source of truth)                    │
                       └──────────────────────────────────────┘
```

| Layer | Responsibility | Storage | Latency |
|-------|---------------|---------|---------|
| **WalletDO** | Real-time balance enforcement, grant consumption, outbox | DO SQLite | < 1ms (co-located) |
| **WalletService** | ACID settlement, ledger posts, grant persistence, source of truth | Postgres | ~5-20ms |

### Why two layers?

1. **Speed.** `EntitlementWindowDO.processBillingBatch()` calls `billMeterFact`
   which needs to check wallet balance and deduct credits. If that hits Postgres
   per event, you add 5-20ms per deduction on the hot billing path — inside a DO
   alarm that processes batches of 1000. With a WalletDO, the balance check and
   local deduction are sub-millisecond DO-to-DO calls.

2. **Consistency model matches metering.** Meters already accept "DO is real-time
   truth, Postgres is durable truth." Wallet balance works the same way: the DO
   holds the live balance, the outbox ensures Postgres catches up. Same mental
   model, same failure modes, same recovery strategy.

3. **Single-threaded serialization for free.** Cloudflare guarantees one
   concurrent request per DO instance. No `SELECT ... FOR UPDATE`, no deadlocks,
   no optimistic retry loops. The WalletDO per `(customerId, currency)` is a
   natural serialization boundary.

### Grant synchronization: push model

When wallet state changes in Postgres (credit purchase confirmed, grant revoked,
manual adjustment), the mutating code path pushes the update to the WalletDO:

```
Stripe webhook → processWebhookEvent → WalletService.addCredits() (Postgres)
                                             │
                                             ▼
                                        walletDO.sync({ grant, balance })
                                        (push via DO stub fetch)
```

The WalletDO exposes a `sync()` method that accepts grant additions, revocations,
or a full state snapshot. On receipt, it updates its local SQLite tables and
adjusts the cached balance. This keeps the DO fresh without polling.

**Why push over pull:**
- Pull requires the DO to wake up periodically and query Postgres — wasteful
  when nothing changed, and stale between polls
- Push is event-driven — the DO learns about changes the moment they happen
- The mutating code path already knows what changed — it has the data in hand
- Matches how `EntitlementWindowDO` receives its configuration: the caller
  provides the state at call time, the DO doesn't fetch it

**Consistency guarantee:** The DO is eventually consistent with Postgres. The
push ensures convergence within the same request that caused the change. If a
push fails (DO unavailable), the next deduction request can carry a fallback
full-sync from Postgres. The outbox flush also serves as a consistency checkpoint
— if the DO's balance diverges from what Postgres expects, the flush detects it.

### The fold/decide pattern in the DO

Following the pattern from Phase 6.5 and
[`ricofritzsche/eventstore-typescript`](https://github.com/ricofritzsche/eventstore-typescript):

```
fold:    foldWalletState(grants[]) → { balance, grantsByPriority[], expired[] }
decide:  decideDeduct(command, state) → Ok(ConsumptionPlan) | Err(InsufficientBalance)
shell:   WalletDO.deduct() — read local SQLite, fold, decide, persist + outbox
```

The pure `foldWalletState` and `decideDeduct` functions live in
`internal/services/src/wallet/core.ts` and are shared between the DO (edge)
and WalletService (Postgres). Same business logic, two execution contexts.
Unit-testable without any infrastructure.

### Deduction flow (detailed)

```
EntitlementWindowDO.processBillingBatch()
  │
  │  for each unbilled meter fact:
  │    1. billMeterFact() → rate usage → post ledger debit
  │    2. settlement router checks preference
  │    3. if "wallet": walletDO.deduct({ amount, sourceType, sourceId })
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
  │  4. Apply ConsumptionPlan to local SQLite:
  │     - Decrement remainingCents on consumed grants
  │     - Update wallet_state balance
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
  │    - Posts ledger debit with sourceType: "credit_burn"
  │    - Updates wallet.balanceCents
  │    - Decrements credit_grants.remainingCents
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
  │  1. Create credit_grant row
  │  2. Post ledger credit (sourceType: "credit_purchase")
  │  3. Increment wallet.balanceCents, lifetimeCreditsCents
  │
  ▼
walletDO.sync({ type: "grant_added", grant: { id, amount, remaining, priority, expiresAt } })
  │  (push via DO stub fetch)
  │
  ▼
WalletDO.sync()
  │  1. Insert/update grant in local credit_grants_local SQLite table
  │  2. Recalculate cached balance from foldWalletState(all local grants)
  │  3. Return Ok
```

## Guardrails

- `WalletService` is a leaf service like `LedgerService` — no peer domain service
  dependencies.
- Credit deductions must be atomic — if balance insufficient, reject entirely
  (no partial deduction). This holds in both the DO (local SQLite transaction)
  and Postgres (DB transaction on flush).
- Credits are ledger entries. `addCredits` posts a ledger credit with
  `sourceType: "credit_purchase"`. `deductCredits` posts a ledger debit with
  `sourceType: "credit_burn"`. **The ledger is the source of truth.** The
  wallet table in Postgres and the wallet state in the DO are both denormalized
  caches — reconcilable from the ledger.
- The DO is the real-time enforcement layer. Postgres is the durable settlement
  layer. The outbox bridges them (same pattern as `EntitlementWindowDO`).
- Burn rates are versioned with `effectiveAt`/`supersededAt`. Changing a burn rate
  never modifies existing subscriptions or historical ledger entries.
- Use `CreditGrant` naming everywhere to avoid confusion with the existing
  `GrantsManager` (which manages entitlement grants, a different concept).
- Do not introduce TypeScript `any` types.
- Keep orchestration in use cases, not adapters.

## Primary Touchpoints

- `internal/db/src/schema/wallets.ts` — new
- `internal/db/src/schema/invoices.ts` — replace existing `creditGrants` and `invoiceCreditApplications` tables
- `internal/db/src/schema/credit-burn-rates.ts` — new
- `internal/db/src/utils/constants.ts` — extend `LEDGER_SETTLEMENT_TYPES` with `"wallet"`
- `internal/db/src/validators/wallets.ts` — new
- `internal/services/src/wallet/service.ts` — new (Postgres-side)
- `internal/services/src/wallet/core.ts` — new (pure fold/decide, shared by DO and service)
- `internal/services/src/wallet/types.ts` — new (WalletState, ConsumptionPlan, etc.)
- `internal/services/src/settlement/router.ts` — new
- `internal/services/src/use-cases/wallet/purchase-credits.ts` — new
- `internal/services/src/use-cases/billing/bill-meter-fact.ts` — wire settlement router
- `internal/services/src/context.ts` — register WalletService
- `apps/api/src/ingestion/wallet/WalletDO.ts` — new (edge-side)
- `apps/api/src/ingestion/wallet/db/schema.ts` — new (DO SQLite schema)
- `apps/api/wrangler.jsonc` — register WalletDO binding
- `apps/api/src/env.ts` — add wallet DO namespace to Env
- `apps/api/src/middleware/init.ts` — expose WalletService to route handlers
- `apps/api/src/hono/env.ts` — add wallet to HonoEnv services type
- `apps/api/src/routes/` — new wallet endpoints
- `packages/api/src/openapi.d.ts` — SDK types
- dashboard UI: wallet page, credit purchase flow, burn rate editor

## Execution Plan

### Slice 1: Wallet & credit grant schema (Postgres)

Create `internal/db/src/schema/wallets.ts`:

```
wallets(
  id, projectId, customerId, currency,
  balanceCents,           -- denormalized cache (updated atomically on flush)
  lifetimeCreditsCents,   -- total credits ever purchased
  lifetimeDebitsCents,    -- total credits ever consumed
  createdAt, updatedAt
)
-- unique: (projectId, customerId, currency)
```

The `balanceCents` column is a **denormalized cache**, not the source of truth.
Updated within the same DB transaction as ledger posts. If drift is ever
suspected, the ledger can be replayed to recompute the correct balance.

Add `credit_grants` to the wallets schema (replaces the existing `creditGrants`
table in `invoices.ts`):

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

**Migration note:** Remove the old `creditGrants` and `invoiceCreditApplications`
tables from `internal/db/src/schema/invoices.ts`. Remove their relations. No
backward compatibility needed — drop and replace. Update the schema barrel
export to include the new wallets schema.

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

The burn rate is a **post-rating conversion layer**. The pricing pipeline is:
`usage → RatingService.rateIncrementalUsage() (cents) → burn rate (credits) → WalletDO.deduct()`.
The burn rate converts rated cents to credits. It does not replace the rating
service — it sits after it.

### Slice 2: Settlement type enum + settlement preference schema

Extend `LEDGER_SETTLEMENT_TYPES` in `internal/db/src/utils/constants.ts`:

```typescript
export const LEDGER_SETTLEMENT_TYPES = ["invoice", "manual", "wallet"] as const
```

Add settlement preference to subscription phases (or customer billing config).
This column does not exist today — it must be created:

```
-- on subscription_phases or a new customer_billing_config table:
settlementPreference  -- "invoice" | "wallet" (nullable, defaults to "invoice")
```

Defaults:
- subscriptions: `"invoice"`
- meter/agent usage: `"wallet"` (falls back to `"invoice"` if no wallet exists)

Run migration for both the new tables, dropped tables, and enum extension.

### Slice 3: Validators

Add validators for all new tables (`wallets`, `credit_grants`,
`credit_burn_rates`). Export from the schema and validator barrels.

Use `drizzle-zod` `createSelectSchema` / `createInsertSchema` following the
existing pattern in `internal/db/src/validators/ledger.ts`.

### Slice 4: Pure wallet logic (fold/decide)

Create `internal/services/src/wallet/core.ts` — pure business logic, zero I/O.
This module is shared by both `WalletDO` (edge) and `WalletService` (Postgres).

```typescript
// --- types ---

interface WalletState {
  balanceMinor: bigint
  grantsInOrder: CreditGrant[]    // sorted: priority ASC, expiresAt ASC NULLS LAST
  expiredGrantIds: string[]
}

interface ConsumptionPlan {
  totalMinor: bigint
  lines: { grantId: string; amountMinor: bigint }[]
  balanceAfterMinor: bigint
}

// --- fold ---

export function foldWalletState(grants: CreditGrant[], now: number): WalletState {
  const active: CreditGrant[] = []
  const expiredGrantIds: string[] = []

  for (const grant of grants) {
    if (grant.revokedAt) continue
    if (grant.expiresAt && grant.expiresAt <= now) {
      expiredGrantIds.push(grant.id)
      continue
    }
    if (grant.remainingCents <= 0) continue
    active.push(grant)
  }

  // sort: priority ASC, expiresAt ASC (nulls last — non-expiring grants consumed last)
  active.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    if (!a.expiresAt && !b.expiresAt) return 0
    if (!a.expiresAt) return 1
    if (!b.expiresAt) return -1
    return a.expiresAt - b.expiresAt
  })

  const balanceMinor = active.reduce(
    (sum, g) => sum + BigInt(g.remainingCents), 0n
  )

  return { balanceMinor, grantsInOrder: active, expiredGrantIds }
}

// --- decide ---

export function decideDeduct(
  amountMinor: bigint,
  state: WalletState
): Result<ConsumptionPlan, WalletError> {
  if (amountMinor <= 0n) return Err(new WalletError("INVALID_AMOUNT"))
  if (amountMinor > state.balanceMinor) return Err(new WalletError("INSUFFICIENT_BALANCE"))

  let remaining = amountMinor
  const lines: ConsumptionPlan["lines"] = []

  for (const grant of state.grantsInOrder) {
    if (remaining <= 0n) break
    const available = BigInt(grant.remainingCents)
    const take = remaining < available ? remaining : available
    lines.push({ grantId: grant.id, amountMinor: take })
    remaining -= take
  }

  return Ok({
    totalMinor: amountMinor,
    lines,
    balanceAfterMinor: state.balanceMinor - amountMinor,
  })
}
```

Create `internal/services/src/wallet/types.ts` for `WalletState`,
`ConsumptionPlan`, `WalletError`, and shared types used by both DO and service.

**Files changed**:
- `internal/services/src/wallet/core.ts` — new
- `internal/services/src/wallet/types.ts` — new

### Slice 5: WalletDO (edge-side, real-time enforcement)

Create `apps/api/src/ingestion/wallet/WalletDO.ts` following the
`EntitlementWindowDO` pattern.

**DO SQLite schema** (`apps/api/src/ingestion/wallet/db/schema.ts`):

```typescript
export const walletStateTable = sqliteTable("wallet_state", {
  key: text("key").primaryKey(),         // "balance" | "customerId" | "currency" | "walletId"
  value: text("value").notNull(),
})

export const creditGrantsLocalTable = sqliteTable("credit_grants_local", {
  id: text("id").primaryKey(),            // mirrors Postgres credit_grants.id
  amountCents: integer("amount_cents").notNull(),
  remainingCents: integer("remaining_cents").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  expiresAt: integer("expires_at"),       // epoch ms, nullable
  priority: integer("priority").notNull(),
  revokedAt: integer("revoked_at"),       // epoch ms, nullable
  syncedAt: integer("synced_at").notNull(), // when this row was last synced from Postgres
})

export const walletOutboxTable = sqliteTable("wallet_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),           // "deduction" | "expiration"
  payload: text("payload").notNull(),     // JSON: { amount, sourceType, sourceId, grantConsumptions[] }
  settledAt: integer("settled_at"),       // epoch ms, null until flushed to Postgres
})

export const walletIdempotencyTable = sqliteTable("wallet_idempotency", {
  key: text("key").primaryKey(),
  createdAt: integer("created_at").notNull(),
  result: text("result").notNull(),       // JSON: DeductResult
})
```

**WalletDO class:**

```typescript
export class WalletDO extends DurableObject {
  // --- same infra setup as EntitlementWindowDO ---
  // db: DrizzleSqliteDODatabase, logger, ready (migration), isAlarmScheduled
  // walletService: WalletService (constructed from Postgres connection, same as
  //   EntitlementWindowDO constructs LedgerService + RatingService)

  // --- public methods ---

  /** Check balance without mutating. Called by settlement router for fast gating. */
  public async hasEnoughCredits(amount: bigint): Promise<boolean> {
    await this.ready
    const grants = this.loadLocalGrants()
    const state = foldWalletState(grants, Date.now())
    return state.balanceMinor >= amount
  }

  /** Deduct credits. Returns new balance or InsufficientBalance error. */
  public async deduct(input: DeductInput): Promise<Result<DeductResult, WalletError>> {
    await this.ready
    const { amount, sourceType, sourceId } = input

    // idempotency check
    const existing = this.checkIdempotency(sourceId)
    if (existing) return existing

    const result = this.db.transaction((tx) => {
      const grants = this.loadLocalGrants(tx)
      const state = foldWalletState(grants, Date.now())
      const plan = decideDeduct(BigInt(amount), state)

      if (plan.err) {
        this.storeIdempotency(tx, sourceId, { ok: false, error: plan.err.code })
        return plan
      }

      // apply consumption plan to local SQLite
      for (const line of plan.val.lines) {
        tx.update(creditGrantsLocalTable)
          .set({ remainingCents: sql`remaining_cents - ${Number(line.amountMinor)}` })
          .where(eq(creditGrantsLocalTable.id, line.grantId))
          .run()
      }

      // update cached balance
      tx.update(walletStateTable)
        .set({ value: String(plan.val.balanceAfterMinor) })
        .where(eq(walletStateTable.key, "balance"))
        .run()

      // write to outbox for Postgres settlement
      tx.insert(walletOutboxTable)
        .values({
          type: "deduction",
          payload: JSON.stringify({
            amount,
            sourceType,
            sourceId,
            grantConsumptions: plan.val.lines,
            balanceAfter: Number(plan.val.balanceAfterMinor),
          }),
        })
        .run()

      const deductResult = { ok: true, newBalance: Number(plan.val.balanceAfterMinor) }
      this.storeIdempotency(tx, sourceId, deductResult)
      return Ok(deductResult)
    })

    // schedule alarm if not already running
    if (!this.isAlarmScheduled) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      this.isAlarmScheduled = true
    }

    return result
  }

  /** Push-based sync from Postgres. Called after addCredits/revokeGrant. */
  public async sync(input: SyncInput): Promise<void> {
    await this.ready

    switch (input.type) {
      case "grant_added":
        this.db.insert(creditGrantsLocalTable)
          .values({ ...input.grant, syncedAt: Date.now() })
          .onConflictDoUpdate({
            target: creditGrantsLocalTable.id,
            set: { ...input.grant, syncedAt: Date.now() },
          })
          .run()
        break

      case "grant_revoked":
        this.db.update(creditGrantsLocalTable)
          .set({ revokedAt: Date.now(), syncedAt: Date.now() })
          .where(eq(creditGrantsLocalTable.id, input.grantId))
          .run()
        break

      case "full_snapshot":
        // Nuclear option: replace all local grants with Postgres state.
        // Used as recovery mechanism if drift is detected during flush.
        this.db.delete(creditGrantsLocalTable).run()
        for (const grant of input.grants) {
          this.db.insert(creditGrantsLocalTable)
            .values({ ...grant, syncedAt: Date.now() })
            .run()
        }
        break
    }

    // recalculate cached balance
    const grants = this.loadLocalGrants()
    const state = foldWalletState(grants, Date.now())
    this.db.update(walletStateTable)
      .set({ value: String(state.balanceMinor) })
      .where(eq(walletStateTable.key, "balance"))
      .run()
  }

  // --- alarm: flush outbox to Postgres ---

  async alarm(): Promise<void> {
    this.isAlarmScheduled = false

    const batch = this.db.select()
      .from(walletOutboxTable)
      .where(isNull(walletOutboxTable.settledAt))
      .orderBy(asc(walletOutboxTable.id))
      .limit(1000)
      .all()

    for (const row of batch) {
      const result = await this.settleInPostgres(row)
      if (result.ok) {
        this.db.update(walletOutboxTable)
          .set({ settledAt: Date.now() })
          .where(eq(walletOutboxTable.id, row.id))
          .run()
      } else if (result.err?.code === "BALANCE_DRIFT") {
        // Postgres balance doesn't match — trigger full sync
        await this.requestFullSync()
      }
    }

    // cleanup settled rows
    this.db.delete(walletOutboxTable)
      .where(isNotNull(walletOutboxTable.settledAt))
      .run()

    // cleanup stale idempotency keys (30 days)
    this.db.delete(walletIdempotencyTable)
      .where(lt(walletIdempotencyTable.createdAt, Date.now() - 30 * 86_400_000))
      .run()

    const remaining = this.db.select({ count: sql`count(*)` })
      .from(walletOutboxTable)
      .where(isNull(walletOutboxTable.settledAt))
      .get()

    if (remaining && Number(remaining.count) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      this.isAlarmScheduled = true
    }
  }

  private async settleInPostgres(row: OutboxRow): Promise<Result<void, WalletError>> {
    const payload = JSON.parse(row.payload)
    return this.walletService.deductCredits({
      walletId: this.walletId,
      amount: payload.amount,
      sourceType: payload.sourceType,
      sourceId: payload.sourceId,
      grantConsumptions: payload.grantConsumptions,
    })
  }

  private async requestFullSync(): Promise<void> {
    const grants = await this.walletService.getActiveGrants(this.walletId)
    await this.sync({ type: "full_snapshot", grants })
  }
}
```

**Wrangler registration:**

Add to `wrangler.jsonc` durable_objects bindings:
```jsonc
{ "name": "wallet", "class_name": "WalletDO" }
```

Add to migrations:
```jsonc
{ "tag": "vN", "new_sqlite_classes": ["WalletDO"] }
```

**DO identity:** `env.wallet.idFromName(`${customerId}:${currency}`)` — one
WalletDO per customer per currency. Mirrors the EntitlementWindowDO pattern
where identity is derived from the business key.

**Files changed**:
- `apps/api/src/ingestion/wallet/WalletDO.ts` — new
- `apps/api/src/ingestion/wallet/db/schema.ts` — new
- `apps/api/src/ingestion/wallet/drizzle/migrations/` — new (DO SQLite migrations)
- `apps/api/wrangler.jsonc` — add WalletDO binding + migration tag
- `apps/api/src/env.ts` — add `wallet` DO namespace
- `apps/api/src/index.ts` — export WalletDO class

### Slice 6: WalletService (Postgres-side, ACID settlement)

Create `internal/services/src/wallet/` with:

- `service.ts` — `WalletService`
- `errors.ts` — `UnPriceWalletError`
- `index.ts` — barrel

Constructor deps: `db`, `logger`, `metrics`, `ledgerService` (near-leaf — depends
only on LedgerService).

Methods:

- `getOrCreateWallet(projectId, customerId, currency)` — idempotent
- `addCredits(walletId, amount, sourceType, sourceId, expiresAt?, priority?)`
  — runs in a **single DB transaction** that:
  1. Creates a `credit_grant` row
  2. Posts a ledger credit via `LedgerService.postCredit()` with
     `sourceType: "credit_purchase"`
  3. Increments wallet `balanceCents` and `lifetimeCreditsCents`
  4. Returns the grant data needed for DO push sync
- `deductCredits(walletId, amount, sourceType, sourceId, grantConsumptions?)`
  — runs in a **single DB transaction** that:
  1. If `grantConsumptions` provided (from DO outbox flush): applies the specific
     grant decrements the DO already computed. Validates grants still exist and
     have sufficient remaining.
  2. If no `grantConsumptions` (direct API call, not via DO): runs the full
     fold/decide locally against Postgres grants.
  3. Posts a ledger debit with `sourceType: "credit_burn"`
  4. Decrements wallet `balanceCents` and increments `lifetimeDebitsCents`
  If balance is insufficient, the **entire transaction rolls back**.
- `getBalance(walletId)` — returns cached `balanceCents` from wallet table
- `getGrantHistory(walletId)` — credit grant timeline with remaining amounts
- `getActiveGrants(walletId)` — returns grants for DO sync (full snapshot)
- `reconcileBalance(walletId)` — recomputes balance from ledger entries,
  updates wallet cache, returns drift amount for observability

Register in `internal/services/src/context.ts`. Construct after `LedgerService`,
pass `ledgerService` as a constructor dep.

**Files changed**:
- `internal/services/src/wallet/service.ts` — new
- `internal/services/src/wallet/errors.ts` — new
- `internal/services/src/wallet/index.ts` — new
- `internal/services/src/context.ts` — register WalletService

### Slice 7: SettlementRouter

Create `internal/services/src/settlement/router.ts`.

The router decides how a rated or ledger-backed charge should be settled.

Routing modes:

- `invoice` — accumulate into periodic invoice (existing BillingService flow)
- `wallet` — deduct from credit balance via WalletDO (real-time) with outbox
  flush to WalletService (ACID)
- `one_time` — charge via provider immediately (uses normalized provider
  runtime, leaves room for crypto-backed collectors)

The router takes:
- the settlement preference (from subscription phase or customer config)
- the charge amount and context
- access to the WalletDO stub (for wallet mode)
- and dispatches to the appropriate handler

If `wallet` mode is selected but no wallet exists or balance is insufficient,
fall back to `invoice` mode. The `hasEnoughCredits` check on the WalletDO
is sub-millisecond — the fallback decision is fast.

### Slice 8: Wire wallet settlement into meter billing

Update `billMeterFact` (`internal/services/src/use-cases/billing/bill-meter-fact.ts`)
to:

1. Rate the usage (existing — `RatingService.rateIncrementalUsage()`)
2. Post ledger debit (existing — `LedgerService.postDebit()`)
3. Route through SettlementRouter
4. If `wallet`: convert cents to credits via burn rate, call
   `walletDO.deduct()` (DO-to-DO call from EntitlementWindowDO context)
5. If `invoice`: accumulate for next billing cycle (existing behavior)

Update `BillMeterFactDeps` to include wallet DO stub access.

**Important integration detail:** `EntitlementWindowDO.processBillingBatch()`
already calls `billMeterFact`. The WalletDO stub must be available in the DO
context. Add `env.wallet` to the EntitlementWindowDO constructor and pass
the stub through to `billMeterFact`.

**Files changed**:
- `internal/services/src/use-cases/billing/bill-meter-fact.ts`
- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` — pass wallet DO stub

### Slice 9: Credit purchase flow

Create `internal/services/src/use-cases/wallet/purchase-credits.ts`.

Use case `purchaseCredits`:

- accepts a credit pack selection (amount, currency)
- creates a Stripe checkout session (or equivalent provider session) for the
  credit pack amount
- on payment success webhook:
  1. `WalletService.addCredits()` — Postgres ACID (source of truth)
  2. `walletDO.sync({ type: "grant_added", grant })` — push to DO
- idempotent: same `sourceId` returns existing grant

Update `processWebhookEvent` to handle credit purchase confirmation events
(new outcome type alongside existing invoice payment flow). The webhook handler
is responsible for both the Postgres write and the DO push.

### Slice 10: API endpoints

New routes (all POST, matching existing convention):

- `POST /v1/wallet/balance` — check credit balance (reads from WalletDO for
  speed, falls back to WalletService if DO unavailable)
- `POST /v1/wallet/purchase` — initiate credit purchase (returns checkout URL)
- `POST /v1/wallet/grants` — list credit grants with remaining amounts
  (reads from Postgres — authoritative view)

Register routes in `apps/api/src/index.ts`.

Add WalletService to `apps/api/src/middleware/init.ts` service exposure
(alongside existing `subscription`, `entitlement`, `customer`, etc.) and
update `apps/api/src/hono/env.ts` services type.

Update `packages/api/` OpenAPI types.

### Slice 11: UI — wallet dashboard & balance

- **Wallet dashboard:** current balance display, grant history timeline showing
  purchases/burns/expirations, burn rate over time chart
- **Customer billing page:** show wallet balance alongside subscription status.
  If wallet-based, show "Credits remaining: $X" prominently.

### Slice 12: UI — credit purchase flow

- **Credit purchase flow:** select credit pack → Stripe checkout → confirmation
  callback → balance updated

### Slice 13: UI — burn rate & settlement config

- **Burn rate configuration:** per-feature credit cost editor on the plan version
  feature configuration page. Shows current rate and effective date.
- **Settlement preference:** per-subscription or per-customer toggle between
  invoice and wallet settlement modes

### Slice 14: Tests

**Pure-function unit tests** (`internal/services/src/wallet/core.test.ts`):
- `foldWalletState`: priority sorting, expiry sorting, expired grant exclusion,
  revoked grant exclusion, zero-remaining exclusion, balance computation
- `decideDeduct`: insufficient balance rejection, exact balance consumption,
  FIFO grant consumption order, multi-grant spanning, zero/negative amount
  rejection

**WalletService integration tests** (against real Postgres):
- wallet creation idempotency
- credit grant with priority and expiry
- FIFO/priority consumption order
- expired grants skipped during deduction
- atomic deduction (insufficient balance rejection, full rollback)
- wallet `balanceCents` stays in sync with ledger after add/deduct
- `reconcileBalance` detects and corrects drift

**WalletDO tests** (using miniflare or DO test harness):
- deduction idempotency (same sourceId → same result)
- local balance tracks after sequential deductions
- outbox rows created for each deduction
- sync: grant_added → balance increases
- sync: grant_revoked → balance decreases, revoked grant skipped in deduction
- sync: full_snapshot → local state matches snapshot
- alarm flush → outbox rows settled and cleaned up
- drift detection → full_snapshot recovery triggered

**End-to-end tests:**
- settlement router routing logic per mode (wallet, invoice, fallback)
- purchase → webhook → WalletService.addCredits → DO sync → balance available
- `billMeterFact` with wallet settlement mode → DO deduction → outbox flush
- burn rate versioning (rate change mid-period uses new rate for new events)
- wallet balance consistency under concurrent deductions via DO serialization

## Execution Order

```
Slice 1 (schema) ──► Slice 2 (enums) ──► Slice 3 (validators)
                                               │
Slice 4 (pure fold/decide) ───────────────────►│
                                               │
                          Slice 5 (WalletDO) ◄─┤──► Slice 6 (WalletService)
                                               │
                          Slice 7 (SettlementRouter) ◄─┘
                                               │
                          Slice 8 (wire meter billing)
                                               │
                          Slice 9 (credit purchase + push sync)
                                               │
                          Slice 10 (API endpoints)
                                               │
               Slice 11-13 (UI) ◄──────────────┘
                                               │
                          Slice 14 (tests)
```

Slices 1-4 are P0 (schema + pure logic — foundation).
Slices 5-6 are P1 (DO + service — the two layers).
Slices 7-9 are P2 (wiring — settlement router, meter billing, purchase flow).
Slice 10 is P3 (API).
Slices 11-13 are P4 (UI).
Slice 14 runs throughout (tests at each slice).

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
- agent/meter usage can be settled by wallet deduction or invoice accumulation
- wallet deductions happen at the edge via WalletDO (sub-millisecond balance
  checks, no Postgres round-trip on the hot path)
- WalletDO and WalletService share the same pure fold/decide logic (`core.ts`)
- push-based grant synchronization: Postgres mutations push state to WalletDO
- outbox pattern: DO deductions flush to Postgres WalletService for ACID
  settlement (same pattern as EntitlementWindowDO → billMeterFact)
- burn rates are versioned and can be changed without modifying subscriptions
- settlement router correctly routes charges to the configured mode
- wallet `balanceCents` in Postgres is a denormalized cache of ledger state
- wallet balance in DO is a real-time cache, reconcilable from Postgres
- `reconcileBalance` can detect and correct drift between layers
- existing `creditGrants` and `invoiceCreditApplications` tables are removed
- SDK exposes wallet balance and purchase endpoints
- dashboard shows wallet state and allows credit purchases

## Out Of Scope

- wallet top-up subscriptions (recurring auto-purchase)
- credit transfer between customers
- multi-currency wallet conversion
- crypto-backed credit purchase (the `one_time` settlement mode leaves room for
  this but implementation is not in scope)
- real-time spending caps / kill-switch at apply() time (Phase 8 — uses the
  WalletDO.hasEnoughCredits() method introduced here, but enforcement policy
  and UX are Phase 8 scope)

## Design Decisions

### Why not keep wallets in Postgres only?

`EntitlementWindowDO.processBillingBatch()` processes up to 1000 meter facts
per alarm tick. Each fact that routes through wallet settlement needs a balance
check + deduction. At ~10ms per Postgres round-trip, that's 10 seconds of
serial DB calls per batch — per customer per feature. The DO eliminates this
bottleneck entirely: balance check + deduction are local SQLite operations
within the same Cloudflare colo.

### Why not put wallet state inside EntitlementWindowDO?

The EntitlementWindowDO is scoped per `(customer, feature, window)`. A wallet
is scoped per `(customer, currency)`. If 5 features meter concurrently, 5
EntitlementWindowDOs would need independent wallet state copies — and they'd
diverge immediately when any one of them deducts. A dedicated WalletDO per
`(customer, currency)` is the natural serialization boundary.

### Why push over pull for grant sync?

Pull (DO polls Postgres periodically) is wasteful when nothing changed, stale
between polls, and creates unnecessary Postgres load. Push is event-driven:
the code path that mutates grants in Postgres already has the data in hand —
it just forwards it to the DO. The DO learns about changes within the same
request that caused them. If a push fails, the next deduction can carry a
fallback full-sync, and the outbox flush serves as a consistency checkpoint.

### What if the DO and Postgres disagree?

The outbox flush is the reconciliation point. When `WalletDO.settleInPostgres()`
calls `WalletService.deductCredits()`, the service validates that the grants
still exist and have sufficient remaining balance. If they don't (e.g., a grant
was revoked in Postgres but the push to the DO failed), the service returns a
`BALANCE_DRIFT` error. The DO responds by requesting a `full_snapshot` sync
on the next interaction, which replaces all local state with Postgres truth.

This is the same eventual-consistency model as metering: the DO is optimistic,
Postgres is authoritative, and the outbox flush is the convergence mechanism.
