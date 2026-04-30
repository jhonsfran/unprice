# Entitlements & Metering Architecture

> **Audience:** AI engineering agent implementing this system.
> **Read first:** `CLAUDE.md`, `docs/billing-hardening-plan.md`.

---

## Goal

Append-only grants in Postgres. Long-lived Durable Objects per `(customer, meter aggregation contract)` that drain grants by priority. Tinybird as the analytics & audit trail. Each grant carries its own refresh cadence and `feature_config` snapshot; subscriptions own invoicing.

Real-time hard caps for AI workloads. Stack grants of different cadences and validity windows on the same meter. Standalone-feature subscriptions with no packaged plan. Self-describing routing.

This plan is **only** the entitlement-grant fix. It must not redesign pricing, wallets, invoices, or settlement. The existing `plan_versions_features` row remains the product configuration template: it already owns `config`, `billing_config`, `reset_config`, `unit_of_measure`, and `meter_config`. Phase 5 snapshots the parts needed for entitlement routing, drain, and rating at grant issuance so later wallet and real-time-invoicing work can use the same entitlement surface.

---

## Three independent concerns — keep them separated

| Concern | Field | Lives on | Drives |
|---|---|---|---|
| How to aggregate usage events | `meter_config` + `unit_of_measure` | PVF template → Grant snapshot | DO routing identity |
| When this specific grant refills | `reset_config` | **Per grant** | Per-grant window rollover inside the DO |
| How this grant's drained units are rated | `feature_config` | PVF `config` / `features_config` → Grant snapshot → DO grant row | Priced facts, wallet reservation consumption, invoice audit |
| When to invoice or settle | `billing_config` / billing strategy | PVF / Subscription / phase | Legacy invoices, wallet-only settlement, real-time paths |

Conflating these is what got us into trouble before. Each is solved in its own layer.

---

## Big picture

```
                         ┌───────────┐
                         │ Postgres  │  append-only `grants`
                         │  grants   │  (system of record)
                         └─────┬─────┘
                               │  push (createGrant → refreshState RPC)
                               │  push (closeGrants on cancel/plan change)
                               ▼
   ┌──────────┐  event   ┌─────────────────────────────┐  drained_from   ┌───────────┐
   │  Worker  │ ───────▶ │  Durable Object             │ ──────────────▶ │ Tinybird  │
   │  (Hono)  │          │  per (customer, contract)   │   per event     │  (audit + │
   └──────────┘          │                             │                 │ analytics)│
                         │  • meter_window (singleton) │                 └─────┬─────┘
                         │  • grants (limit/reset/price)│                      │
                         │  • outbox                   │                       │
                         │  • event_idempotency        │             billing-time
                         └─────────────────────────────┘             usage queries
                                                                           │
                                                                           ▼
                                                                  ┌────────────────┐
                                                                  │  Subscription  │
                                                                  │  invoice gen   │
                                                                  │  (own cadence) │
                                                                  └────────────────┘
```

---

## Identity & routing

```
DO key = (env, project, customer_id, feature_slug, hash(meter_config + unit_of_measure))
```

The hash is over the meter's **aggregation contract**: how to count events. Not how grants refresh, not how billing rolls up. Two grants with different `reset_config` (monthly plan + yearly promo) stack in the **same** DO because they share the aggregation. Each grant ticks on its own clock.

The semantic shard already exists in the meter contract. Normalize the same fields the engine uses to derive the meter key: `event_slug`, `aggregation_method`, optional `aggregation_field`, optional filters/grouping/window size, plus `unit_of_measure`. Do **not** include `reset_config`, `billing_config`, `feature_config`, PVF id, subscription id, or grant id in `meter_hash`.

Rating is grant-local. Two grants with the same meter contract but different pricing still route to the same DO; the DO prices each drained slice with the exact PVF `feature_config` snapshotted on the grant that paid for that slice. In code, this is the current `plan_versions_features.config` payload stored in the `features_config` column and typed by `configFeatureSchema`. Do not split this into a new `price_config` model: keep the current Dinero.js payload intact. The only Phase 5 invariant is currency: all priced grants in one customer/meter DO must resolve to one Dinero currency code, or grant creation rejects the mixed-currency stack.

```
   Customer "acme" / feature "api-calls"
   │
   ├── meter_hash = h1 (sum, count by request_id)        → DO_1
   │     ├── plan grant     (1000/MONTH refresh)
   │     ├── promo grant    (10K one-shot, valid 1 year)
   │     └── operator credit (500 one-shot, valid 10 days)
   │
   └── meter_hash = h2 (sum tokens by token_count)       → DO_2
         └── different aggregation entirely → different DO
```

PVFs publish grants but the grant **snapshots** the meter contract at issuance. Two PVFs with byte-identical `meter_config + unit_of_measure` produce grants that route to the same DO — addons consolidate with their base plan automatically.

The current code's `streamId` includes reset config in the fungibility signature. Phase 5 removes that coupling: reset cadence is grant state, not stream identity.

---

## Postgres schema (system of record)

```sql
CREATE TABLE grants (
  id                 TEXT PRIMARY KEY,                       -- cuid
  project_id         TEXT NOT NULL,
  customer_id        TEXT NOT NULL,
  feature_slug       TEXT NOT NULL,                          -- routing identity
  -- Snapshotted meter aggregation contract (drives routing)
  meter_config       JSONB NOT NULL,
  unit_of_measure    TEXT NOT NULL,
  meter_hash         TEXT NOT NULL,                          -- canonical hash, indexed
  -- Snapshotted rating contract (exact PVF `config` / `features_config`)
  feature_config     JSONB NOT NULL,
  currency_code      TEXT NOT NULL,                          -- derived from feature_config; wallet invariant/cache only
  -- Per-grant refresh cadence (nullable = one-shot)
  reset_config       JSONB,
  amount             NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  -- Validity window
  effective_at       TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ,                            -- only mutable field; trigger move-earlier-only
  -- Drain order
  priority           INT NOT NULL,
  -- Provenance
  source             TEXT NOT NULL,                          -- subscription|addon|trial|promo|manual
  source_phase_id    TEXT,                                   -- audit; no FK
  metadata           JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (expires_at IS NULL OR expires_at > effective_at)
);

CREATE INDEX idx_grants_route
  ON grants (project_id, customer_id, feature_slug, meter_hash, effective_at);
```

**Mutability rule:** `grants.expires_at` is the only mutable column, and only allowed to move **earlier**. Enforce this with a `BEFORE UPDATE` trigger that compares `OLD.expires_at` and `NEW.expires_at`; a normal `CHECK` constraint cannot compare old vs. new values. Everything else is append-only.

Priority semantics must match the existing code unless an explicit migration changes them. Today higher priority drains first. Keep that direction for Phase 5:

`operator/manual=100`, `promo=70`, `trial=60`, `addon=20`, `subscription=10`.

---

## DO state (SQLite, durable)

This is the entitlement-grant state shape. Do not blindly delete the current `meter_window` table: in the existing DO it carries usage, outbox context, and wallet reservation bookkeeping. Phase 5 should remove **reset-period coupling** from the DO window model and move rating authority from `meter_window.price_config` / active PVF input to the per-grant `feature_config` rows. It may split/rename the current table, but it must preserve the existing wallet/reservation and priced-fact state.

```sql
-- Existing singleton/window row. Keep or rename only if the migration truly needs it.
-- It owns meter usage + wallet reservation state, not pricing and not entitlement reset.
CREATE TABLE meter_window (
  meter_key         TEXT PRIMARY KEY,
  customer_id       TEXT,
  feature_slug      TEXT,
  meter_hash        TEXT,
  usage             REAL NOT NULL DEFAULT 0,
  period_end_at     INTEGER,                            -- reservation/settlement metadata only
  hydrated_at       INTEGER NOT NULL,
  closing           INTEGER NOT NULL DEFAULT 0,
  -- keep existing reservation fields: reservation_id, allocation_amount,
  -- consumed_amount, flushed_amount, refill state, flush seqs, last_event_at,
  -- deletion/recovery flags, last_flushed_at
);

-- Long-lived: one row per grant. Per-grant window state for refreshable grants.
CREATE TABLE grants (
  grant_id                    TEXT PRIMARY KEY,
  amount                      REAL NOT NULL,
  feature_config              TEXT NOT NULL,                  -- JSON; exact snapshotted PVF config/features_config
  currency_code               TEXT NOT NULL,                  -- derived from feature_config; wallet invariant/cache only
  reset_config                TEXT,                          -- JSON; NULL = one-shot
  effective_at                INTEGER NOT NULL,
  expires_at                  INTEGER,
  priority                    INTEGER NOT NULL,
  -- Window state — semantics differ by grant type:
  --   recurring (reset_config NOT NULL): consumed_in_current_window resets at boundary
  --   one-shot  (reset_config IS NULL):  consumed_in_current_window is monotonic, window cols NULL
  consumed_in_current_window  REAL NOT NULL DEFAULT 0,
  current_window_start        INTEGER,
  current_window_end          INTEGER,
  consumed_lifetime           REAL NOT NULL DEFAULT 0,       -- monotonic audit counter
  exhausted_at                INTEGER,                       -- only meaningful for one-shots
  added_at                    INTEGER NOT NULL
);

CREATE INDEX grants_drain_order ON grants (priority, expires_at, grant_id);

-- Outbox: per allowed event, drained to Tinybird via queue
CREATE TABLE outbox (
  flush_id    TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,                                 -- JSON: {event_id, drained, priced_drains, ts, ...}
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);

CREATE INDEX outbox_pending ON outbox (created_at) WHERE sent_at IS NULL;

-- Per-event idempotency — only table with retention (MAX_EVENT_AGE_MS prune in alarm)
CREATE TABLE event_idempotency (
  event_id    TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  outcome     TEXT NOT NULL                                  -- ALLOW | DENY
);

CREATE INDEX idempotency_retention ON event_idempotency (applied_at);
```

No entitlement-wide reset window. No meter-wide rating config. Invoicing/settlement cadence stays outside grant rollover. The DO may still keep meter usage, priced-fact outbox, and wallet reservation state for the existing real-time path.

---

## Per-grant window logic

Each grant ticks on its own clock. Recurring grants roll their window forward lazily on first event past the boundary. One-shot grants never roll.

```
remaining_at(g, T):
  if g.expires_at != null AND T >= g.expires_at: return 0
  if T < g.effective_at:                          return 0

  if g.reset_config IS NULL:                                          -- one-shot
    return g.amount - g.consumed_in_current_window                    -- monotonic
  else:                                                               -- recurring
    if T >= g.current_window_end:
      // lazy rollover — runs inside the apply() transaction
      next_window = calculateCycleWindow(g.reset_config.anchor, g.reset_config, T)
      g.current_window_start = next_window.start
      g.current_window_end   = next_window.end
      g.consumed_in_current_window = 0
    return g.amount - g.consumed_in_current_window
```

The grant's `reset_config.resetAnchor` is the reference point for window math (typically `effective_at` or a billing-aligned timestamp at issuance). The window is fully derivable; we cache `current_window_*` only to avoid recomputing on every event.

```
   Plan grant (reset_config = MONTH, amount = 1000):

   Apr ────────────┐  May ────────────┐  Jun ────────────┐  …
   window_start    │  window_start    │  window_start    │
                   │                  │                  │
   consumed_in_w   │  consumed_in_w   │  consumed_in_w   │
        ┃          │       ┃          │       ┃          │
   refills ◀───────┘  refills ◀───────┘  refills ◀───────┘

   Promo grant (reset_config = NULL, amount = 10K, expires Dec 31):

   Apr ──── May ──── Jun ──── Jul ──── … ──── Dec
   consumed_in_w monotonic; window cols stay NULL
```

---

## Lifecycle

### 1. Hydration (first event ever, or DO restart)

Runs once per DO lifetime. SQLite is durable; subsequent events skip this entirely.

```
ensureHydrated():
  if meter_window row exists: return

  routing = decodeDOName()                             // env/project/customer/feature_slug/meter_hash
  grants  = repo.fetchGrantsForMeter(routing)
  if grants is empty: throw NO_GRANTS

  INSERT INTO meter_window (meter_key, customer_id, feature_slug, meter_hash, hydrated_at)
  VALUES (routing.meter_key, ..., now)

  for g in grants:
    initial_window = computeInitialWindow(g, now)      // null for one-shot
    INSERT INTO grants (
      grant_id, amount, feature_config, currency_code, reset_config, effective_at, expires_at, priority,
      consumed_in_current_window, current_window_start, current_window_end,
      consumed_lifetime, added_at
    ) VALUES (
      g.id, g.amount, g.feature_config, g.currency_code, g.reset_config,
      +g.effective_at, +g.expires_at?, g.priority,
      0, initial_window?.start, initial_window?.end,
      0, now
    ) ON CONFLICT (grant_id) DO NOTHING

  setAlarm(now + 30_000)                               // periodic flush + idempotency prune
```

### 2. Burn-down — `apply(event)`

```
event ──▶ apply(event) ──▶ ensureHydrated
                          ┌─ one SQLite transaction ───────────────────┐
                          │ 1. dedup via event_idempotency             │
                          │ 2. closing flag check (HARD-009)           │
                          │ 3. SELECT eligible grants, lazy-roll       │
                          │ 4. drain and rate by grant                 │
                          │ 5. wallet reservation check, if active     │
                          │ 6. UPDATE consumed_in_current_window +     │
                          │    consumed_lifetime per grant             │
                          │ 7. INSERT outbox row                       │
                          │ 8. INSERT event_idempotency                │
                          └────────────────────────────────────────────┘
                                            │
                                            ▼
                          waitUntil(flushOutbox()) → Queue → Tinybird
```

```typescript
async apply(event: UsageEvent): Promise<ApplyResult> {
  await this.ensureHydrated(event.routing);

  const result = this.sql.transaction(() => {
    const seen = this.sql.first(
      `SELECT outcome FROM event_idempotency WHERE event_id = ?`, event.id);
    if (seen) return { outcome: seen.outcome, replay: true };

    const meta = this.sql.first(`SELECT closing FROM meter_window LIMIT 1`);
    if (meta.closing) return { outcome: 'DENY', reason: 'METER_CLOSING' };

    const now = Date.now();

    // Eligibility: validity window + not exhausted (one-shots only)
    const eligible = this.sql.exec(`
      SELECT grant_id, amount, feature_config, currency_code, reset_config, expires_at,
             consumed_in_current_window, current_window_end
        FROM grants
       WHERE effective_at <= ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND (exhausted_at IS NULL)
       ORDER BY priority DESC, expires_at ASC NULLS LAST, grant_id ASC
    `, now, now).toArray();

    let qty = event.quantity;
    const updates: {
      grant_id: string;
      take: number;
      new_in_window: number;
      exhausted_at: number | null;
    }[] = [];
    const pricedDrains: {
      grant_id: string;
      units: number;
      amount_minor: number;
      currency: string;
    }[] = [];

    for (const b of eligible) {
      if (qty <= 0) break;

      // Lazy window rollover for recurring grants
      let consumedInWindow = b.consumed_in_current_window;
      if (b.reset_config && b.current_window_end !== null && now >= b.current_window_end) {
        const reset = JSON.parse(b.reset_config);
        const next  = calculateCycleWindow(reset.resetAnchor, reset, now);
        this.sql.exec(`
          UPDATE grants
             SET current_window_start = ?, current_window_end = ?, consumed_in_current_window = 0
           WHERE grant_id = ?
        `, +next.start, +next.end, b.grant_id);
        consumedInWindow = 0;
      }

      const remaining = b.amount - consumedInWindow;
      if (remaining <= 0) continue;

      const take = Math.min(qty, remaining);
      const newInWindow = consumedInWindow + take;
      const exhaust = (b.reset_config === null && newInWindow >= b.amount) ? now : null;

      pricedDrains.push({
        grant_id: b.grant_id,
        units: take,
        amount_minor: computeAmountMinorFromUsage({
          featureConfig: JSON.parse(b.feature_config),
          before: consumedInWindow,
          after: newInWindow,
        }),
        currency: b.currency_code,
      });

      updates.push({
        grant_id: b.grant_id,
        take,
        new_in_window: newInWindow,
        exhausted_at: exhaust,
      });

      qty -= take;
    }

    if (qty > 0) {
      this.sql.exec(`
        INSERT INTO event_idempotency (event_id, applied_at, outcome) VALUES (?, ?, 'DENY')
      `, event.id, now);
      return { outcome: 'DENY', reason: 'LIMIT_EXCEEDED', shortfall: qty };
    }

    assertSingleCurrency(pricedDrains);
    const totalCost = pricedDrains.reduce((sum, d) => sum + d.amount_minor, 0);
    checkLocalWalletReservation(totalCost);                 // existing reservation path

    for (const update of updates) {
      this.sql.exec(`
        UPDATE grants
           SET consumed_in_current_window = ?,
               consumed_lifetime          = consumed_lifetime + ?,
               exhausted_at               = ?
         WHERE grant_id = ?
      `, update.new_in_window, update.take, update.exhausted_at, update.grant_id);
    }

    const flushId = cuid();
    this.sql.exec(`
      INSERT INTO outbox (flush_id, payload, created_at) VALUES (?, ?, ?)
    `, flushId, JSON.stringify({
      event_id: event.id,
      drained: updates.map((u) => ({ grant_id: u.grant_id, amount: u.take })),
      priced_drains: pricedDrains,
      ts: event.timestamp,
    }), now);

    this.sql.exec(`
      INSERT INTO event_idempotency (event_id, applied_at, outcome) VALUES (?, ?, 'ALLOW')
    `, event.id, now);

    return { outcome: 'ALLOW', drained_from: pricedDrains, flush_id: flushId };
  });

  if (result.outcome === 'ALLOW') {
    this.state.waitUntil(this.flushOutbox());
  }

  return result;
}
```

`computeAmountMinorFromUsage()` is the existing rating idea with one important change: it prices `before → after` for the grant-local counter, not the meter-wide counter and not the currently active PVF. It receives the same `feature_config` payload used by `plan_versions_features.config`, including Dinero snapshots. This keeps tier/flat boundary math correct when one event drains multiple grants with different pricing. The wallet reservation path consumes the summed `amount_minor` after drain selection but before committing usage mutations, so a wallet denial rolls back the whole event.

### 3. Push channels — `refreshState` / `closeGrants` / `closeMeter`

```
createGrant [services]:
  INSERT INTO grants (...) VALUES (...)                -- Postgres, append-only
  await DO.refreshState({ reason: 'grant_added' })     -- best-effort

refreshState [DO]:
  routing = SELECT customer_id, feature_slug, meter_hash FROM meter_window LIMIT 1
  grants = repo.fetchGrantsForMeter(routing)
  for g in grants:
    INSERT INTO grants (...) VALUES (...) ON CONFLICT (grant_id) DO NOTHING
```

```
terminateGrants [services]:
  // expires_at can only move earlier; BEFORE UPDATE trigger enforces
  UPDATE grants SET expires_at = :terminated_at
   WHERE id = ANY(:ids) AND (expires_at IS NULL OR expires_at > :terminated_at)
  await DO.closeGrants({ grant_ids, terminated_at })   -- best-effort

closeGrants [DO]:
  for id in grant_ids:
    UPDATE grants SET expires_at = ? WHERE grant_id = ?
                                       AND (expires_at IS NULL OR expires_at > ?)
```

```
closeMeter [DO, HARD-009]:
  UPDATE meter_window SET closing = 1
  await flushOutbox()                                  // sync drain
  // Apply() returns METER_CLOSING from now on; DO reclaimed eventually
```

Use `closeMeter()` only when the entire meter contract is intentionally retired and no active/pending grants should remain. Subscription cancellation should usually close only the subscription-owned grants; promo/manual/standalone grants on the same meter must remain eligible.

### 4. Alarm — periodic flush + idempotency prune

```typescript
async alarm(): Promise<void> {
  const now = Date.now();

  await this.flushOutbox();

  this.sql.transaction(() => {
    this.sql.exec(
      `DELETE FROM event_idempotency WHERE applied_at < ?`, now - MAX_EVENT_AGE_MS);
  });

  await this.state.storage.setAlarm(now + 30_000);
}
```

No entitlement "end-of-period reset" alarm anymore. Each grant rolls its own window lazily inside `apply()`. The alarm still owns outbox flushing, idempotency cleanup, wallet/reservation freshness, and eventual DO cleanup where the existing DO needs those jobs.

---

## Plan change → grants close, then re-issue

Plan change is two operations on the grants table:

1. State machine calls `terminateGrants(old_grant_ids, phase_end)` — sets `expires_at = phase_end` on the old grants. DO stops draining them once `now >= phase_end`.
2. State machine inserts new grants with the new plan's `meter_config + unit_of_measure + reset_config + feature_config`. If the new `meter_config + unit_of_measure` matches the old hash, they land in the **same DO** even when `reset_config` or pricing differs. If the meter contract differs, they land in a new DO.

```
   Same meter_config + unit_of_measure (e.g., quantity bump):
   ─────────────────────────────────────────────────────────────
   Old grants  ━━━━━━━━━━━━━━━━━━━━━┫ phase_end
   New grants                       ┣━━━━━━━━━━━━━━━━━━━▶
   DO          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶  same DO

   Different meter_config (e.g., aggregation method changes):
   ─────────────────────────────────────────────────────────────
   Old grants  ━━━━━━━━━━━━━━━━━━━━━┫ phase_end
   Old DO      ━━━━━━━━━━━━━━━━━━━━━┫ closes when last grant expires

   New grants                       ┣━━━━━━━━━━━━━━━━━━━▶
   New DO                           ┣━━━━━━━━━━━━━━━━━━━▶  fresh
```

Subscription cancel: `terminateGrants(subscription_owned_grant_ids, cancel_at)` then `closeMeterIfNoEligibleGrantsRemain()`. DO marks `closing=1` only when this customer/meter has no remaining eligible grants from promo, manual, addon, trial, standalone feature, or project-level sources.

---

## Drain example — different cadences stacked

```
grants table (DO SQLite) at Apr 12, 14:00 (meter resets independent of grants):
┌──────────┬──────┬──────────────┬────────────┬─────────┬────────────────┬────────────┐
│ grant_id │ pri  │ reset_config │ amount     │ expires │ feature_config │ consumed_w │
├──────────┼──────┼──────────────┼────────────┼─────────┼────────────────┼────────────┤
│ g_op     │ 100  │ NULL         │       500  │ Apr 20  │ free/manual    │        0   │
│ g_promo  │  70  │ NULL         │   10,000   │ Dec 31  │ promo config   │      420   │
│ g_plan   │  10  │ MONTH/1      │    1,000   │ NULL    │ plan config    │       80   │
└──────────┴──────┴──────────────┴────────────┴─────────┴────────────────┴────────────┘

apply({ quantity: 800, ts: Apr 12 14:00 }):
  eligible (priority DESC, expires ASC NULLS LAST):
    1. g_op    — one-shot, 500 left
    2. g_promo — one-shot, 9,580 left
    3. g_plan  — recurring, 920 left in current April window

  drain:
    g_op    : take 500   →  rate 0→500 with g_op.feature_config, exhausted_at = now
    g_promo : take 300   →  rate 420→720 with g_promo.feature_config
  qty exhausted, stop

  outcome: ALLOW
  drained_from: [{ g_op, 500, amount_minor }, { g_promo, 300, amount_minor }]

May 1 → first event:
  g_plan window has rolled past Apr 30. Lazy rollover inside apply():
    current_window_start = May 1, current_window_end = Jun 1
    consumed_in_current_window = 0    (refilled to 1,000 capacity)
  g_promo carries on at consumed_in_window = 720.
  g_op was exhausted, stays exhausted.
```

---

## Invoicing — subscription's job, not the DO's

This section is about legacy plan-based invoicing only. The existing real-time/wallet path continues using the DO's priced facts and reservation flushes, but those facts now come from grant-local pricing. Phase 5 must make entitlement routing compatible with both paths; it does not move invoice or wallet settlement logic into the grant model.

For legacy invoices, subscriptions own the invoice cadence. At billing time:

1. State machine determines the invoice period from `billing_config` (e.g., monthly billing).
2. Queries Tinybird for priced grant drains in that period:
   `SELECT grant_id, SUM(units), SUM(amount_minor) FROM event_drains WHERE customer = X AND feature_slug = Y AND meter_hash = Z AND ts ∈ [period_start, period_end) GROUP BY grant_id`
3. Generates invoice lines from the already-rated drain facts. Do not re-rate historical usage from the current PVF; the grant snapshot is the audit source.

Customers without invoice-backed subscriptions never trigger legacy invoicing. Drain still works, attribution still flows, and wallet-only settlement can use the existing reservation path.

---

## Edge cases & invariants

| # | Case | Behavior |
|---|------|----------|
| 1 | Yearly + monthly + operator stacked | Same DO (shared meter contract). Drained by priority. Each grant ticks its own window. |
| 2 | Late event after grant window end | Lazy rollover at apply: window walks forward to contain `now`. No retroactive crediting. |
| 3 | New grant added mid-cycle | `refreshState` INSERTs into DO grants table. Eligible on next event. |
| 4 | Grant terminated early | `terminateGrants` UPDATEs `expires_at` to earlier value (only direction allowed). DO honors via eligibility filter. Already-drained consumption is **not** refunded — refunds are explicit. |
| 5 | Plan change, same meter_hash | New grants land in same DO. Old grants' `expires_at` set to phase_end. |
| 6 | Plan change, different meter_hash | Old DO drains and closes; new DO bootstraps from new grants. |
| 7 | Subscription cancel | `terminateGrants` on subscription-owned grants. Only call `closeMeter` if no eligible grants remain for that customer/meter. |
| 8 | DO restart mid-cycle | SQLite is durable. State survives. Outbox replays unsent rows. Idempotency prevents double-drain. |
| 9 | Concurrent events | The DO is single-threaded per object; drain + window roll happen in one SQLite tx. No race. |
| 10 | Reservation routing | Reservation row carries `(customer, feature_slug, meter_hash)` — routes back to same DO regardless of grant lifecycle. |
| 11 | Same meter, different pricing | Same DO. Drain by priority, rate each drained slice with that grant's `feature_config`. |
| 12 | Mixed currency on same meter | Reject at grant creation for Phase 5. One customer/meter DO has one wallet reservation currency resolved from Dinero snapshots. |

---

## Hot meter scaling note

Cloudflare documents an individual Durable Object soft limit around 1,000 requests/sec. Phase 5 does not implement hot-meter sharding, but the routing key should leave room for it.

The first shard boundary is already semantic: `meter_hash` is derived from the aggregation contract. Different event slugs, aggregation fields, filters, group keys, windows, or units naturally produce different DOs.

If a single customer + single semantic meter is still hot, use a parent/child lease design later:

1. Parent DO key: `(env, project, customer_id, feature_slug, meter_hash)`.
2. Child DO key: `(env, project, customer_id, feature_slug, meter_hash, shard=N)`.
3. Parent owns canonical grant hydration and wallet reservation allocation.
4. Children receive leased unit/money capacity per grant/currency_code and drain locally.
5. Children flush usage/drains back to parent or directly to Tinybird with shard id.

This keeps hard-cap error bounded by lease size instead of total concurrency. Do not add random sharding in Phase 5; just make `meter_hash` stable and explicit so a `shard` suffix can be added later.

---

## Reduction pass

Smallest Phase 5 that satisfies the requirements:

1. Keep one DO per `(customer, feature_slug, meter_hash)`. Do not create a rating DO, invoice DO, or wallet DO.
2. Keep the existing wallet reservation and priced-fact plumbing. Move only the rating authority from `meter_window.price_config` / active PVF input into the DO `grants.feature_config`.
3. Keep the existing `configFeatureSchema` + `calculatePricePerFeature` semantics. Call it with grant-local `before → after` counters for each drained slice. Do not invent a new rating DSL or a new price-config shape.
4. Stop routing by `periodKey`; keep period start/end only as reservation and settlement metadata.
5. Stop re-rating at invoice time. Invoice from the already-rated grant drain facts emitted by the DO.
6. Defer parent/child hot-meter sharding, multi-currency stacks, operator UI, and wallet-priority redesign. They are not required to prove grant-local reset + rating.
7. Avoid table renames unless a migration truly needs them. A boring migration that removes reset-period identity and moves feature config to grants is better than a clean-looking rewrite.

The load-bearing requirement is not "build a new billing architecture." It is: when an event arrives, choose the eligible grants, drain them in priority order, rate each drained slice using that grant's PVF-compatible `feature_config` snapshot, and commit the entitlement + priced-fact + reservation mutation atomically.

---

## Implementation phases

### Phase 1 — Schema + migration foundation [done]

- `internal/db/src/schema/entitlements.ts` — append-only `grants`
- `internal/db/src/schema/entitlementReservations.ts` — routing columns
- Drop `entitlementMergingPolicyEnum`, `ENTITLEMENT_MERGING_POLICY` constants
- Trim `SUBJECT_TYPES` to `["customer", "project"]`

### Phase 2 — Service layer [done]

- `internal/services/src/entitlements/grants.ts` — `createGrant`, `getGrantsForMeter`, default priorities
- Tests: priority drain order, eligibility, stacking

### Phase 3 — Ingestion routing [done]

- `internal/services/src/ingestion/message.ts` — DO routing key wiring
- `internal/services/src/ingestion/service.ts` — service plumbing

### Phase 4 — DO bucket drain [done]

- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` — drain, refresh, close, alarm
- 4.5 collapsed sibling-equality machinery; PVF was the meter contract authority

### Phase 5 — Per-grant reset_config + meter contract hash routing [next]

The current implementation routes ingestion through `streamId + periodKey`: `streamId` hashes the fungibility signature, and that signature currently includes `reset_config`; `periodKey` then adds the active reset window. `reset_config` and PVF `config` are sourced from the active grant's PVF at apply time. This phase moves to:

- **Routing identity** = `hash(meter_config + unit_of_measure) + feature_slug`. Grants snapshot `meter_config + unit_of_measure + meter_hash` at issuance.
- **`reset_config` moves from PVF to grant** (snapshot at issuance). PVF can still hold a template.
- **`feature_config` moves from active PVF input to grant** (snapshot at issuance). This is the exact PVF `config` / `features_config` payload, including Dinero.js price/currency snapshots. The DO rates each drained grant slice with its own feature config.
- **Remove reset-period and rating authority from the DO window.** Per-grant windows replace the single entitlement reset window. Preserve existing meter usage, priced-fact outbox, and wallet reservation state.
- **`grants.expires_at` becomes mutable** with a `BEFORE UPDATE` trigger enforcing move-earlier-only.
- **Add `closeGrants` + `terminateGrants` RPC + service path** for plan change / cancel.
- **Reservations** carry enough routing context to find the same semantic meter: `(customer, feature_slug, meter_hash)`. Keep period start/end for settlement; do not use `period_key` as routing identity.

Sub-tasks:

1. Schema: snapshot columns on `grants` (`meter_config`, `unit_of_measure`, `meter_hash`, `feature_config`, `currency_code`, `reset_config`, `feature_slug`); move-earlier trigger on `expires_at`; reservation routing columns if missing.
2. Service: `createGrant` snapshots meter, reset, feature config, and derived currency code from PVF; reject mixed-currency stacks for one `(customer, feature_slug, meter_hash)`; `terminateGrants` UPDATEs `expires_at` and dispatches `closeGrants`.
3. Ingestion: build DO name from `hash(meter_config + unit_of_measure) + feature_slug`; stop treating `periodKey`, `featurePlanVersionId`, or active PVF `config` as DO identity/rating authority.
4. DO: remove reset-period coupling from `meter_window`; move feature config into DO grants table; add per-grant window state; rate drained slices by grant; preserve priced facts and wallet reservation columns; add `closeGrants` RPC.
5. Reservations: route by `meter_hash`/feature where needed; size/refill from the summed grant-local event cost; keep period boundaries for reservation lifecycle and settlement.
6. Tests: drain across cadences, lazy rollover, grant-specific pricing, wallet denial rollback, terminate-via-expires_at, plan change consolidation.

### Phase 6 — End-to-end + cleanup

Manual scenarios:

1. Subscription create → first event → drain refreshable bucket
2. Mid-cycle operator credit (highest priority) → next event drains it first
3. Standalone-feature subscription (no plan) → grant directly on contract
4. Plan upgrade with same meter_hash → grants consolidate, no DO churn
5. Plan migration with different meter_hash → old DO closes, new DO fresh
6. Yearly promo + monthly plan stacked → promo carries across cycles, plan refreshes
7. Same meter with plan config + promo config → one DO, grant-local priced drain facts

---

## Files to modify (Phase 5)

```
internal/db/src/schema/entitlements.ts                   add snapshot cols + move-earlier trigger
internal/db/src/schema/entitlementReservations.ts        add feature_slug/meter_hash if needed; keep period bounds
internal/db/src/migrations/0006_per_grant_reset.sql      NEW
internal/services/src/entitlements/grants.ts             snapshot meter/reset/feature_config/currency_code; terminateGrants; closeGrants RPC dispatch
internal/services/src/ingestion/message.ts               build DO name from meter_hash + feature_slug
internal/services/src/ingestion/service.ts               stop using period_key/active PVF config as DO identity/rating authority
internal/services/src/wallet/service.ts                  reservation input shape change
apps/api/src/ingestion/entitlements/db/schema.ts         preserve meter/window wallet state; move feature_config to grants; add per-grant window state
apps/api/src/ingestion/entitlements/drizzle/0011_*.sql   NEW migration
apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts
                                                          ▸ remove reset-period coupling
                                                          ▸ rate each drained slice with grant.feature_config
                                                          ▸ per-grant lazy window rollover in apply()
                                                          ▸ closeGrants RPC
                                                          ▸ alarm: outbox/idempotency/wallet cleanup only; no entitlement reset
apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts  rotation + termination tests
```

---

## Functions to reuse

- `calculateCycleWindow` in `@unprice/db/validators` — per-grant window math
- `getAnchor` in `@unprice/db/utils`
- `MeterConfig` and `ResetConfig` Zod schemas in `internal/db/src/validators/shared.ts`
- `configFeatureSchema` / `ConfigFeatureVersionType` — same PVF config semantics, including Dinero snapshots
- `calculatePricePerFeature` / current `computeAmountMinor` logic — reuse for grant-local `before → after` rating
- `LedgerGateway.createTransfer` (money side, untouched)
- `WalletService.flushReservation` (untouched)
- Canonical JSON hashing for `meter_hash` — use stable canonicalization matching `deriveMeterKey` normalization, then SHA-256

---

## Out of scope

- Wallet/money grant priority — `wallet_grants` keeps current FIFO-by-expiry drain.
- Refund semantics — refunds are explicit `consumption_adjustment` operations, separate concern.
- Catastrophic SQLite recovery — DO durability assumed; no replay-from-Tinybird path.
- Workspace-level grants — `subject_type` is `customer | project` only.
- Operator UI for issuing manual grants.
- Hot-meter parent/child lease sharding — document only; implement after Phase 5 if real traffic demands it.
- Mixed-currency stacks on one semantic meter — reject in Phase 5; revisit only with a real customer case.

---

## Working agreement for AI agent

- Pick one phase, complete it cleanly, run `pnpm typecheck` + tests, stop for human review before the next phase.
- Phase 5 must NOT touch `features.ts` or `validators/features.ts`.
- Phase 5 must not add a new rating service or price-config shape; grant-local rating reuses the existing PVF `config` and calculator.
- Within each phase, prefer landing schema/type changes first and consumer updates next.
- Rewrite failing tests rather than skipping them.
- If a phase plan turns out wrong, leave partial work uncommitted and write a `Plan revision needed:` note inline.
- No backward-compatibility shims. Pre-GA codebase, clean deletion is the goal.

---

## Status

| Phase | Status |
|-------|--------|
| 1     | done — schema foundation |
| 2     | done — service layer |
| 3     | done — ingestion routing on PVF + period_key |
| 4     | done — DO bucket drain, refreshState, closeReservation, alarm |
| 5     | not started — per-grant reset_config + feature_config; meter contract hash routing; remove reset-period/rating coupling from meter_window; closeGrants |
| 6     | not started — end-to-end + cleanup |
