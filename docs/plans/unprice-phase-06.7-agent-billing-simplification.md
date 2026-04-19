# Phase 6.7: Simplify Agent Billing Pipeline

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
PR title: `refactor: simplify entitlement DO and agent billing pipeline`
Branch: `refactor/agent-billing-simplification`

**Prerequisite:** [Phase 6.6 — pgledger gateway](./unprice-phase-06.6-new-ledger.md)
must ship first. This phase rewrites the call sites that land in Phase 6 and
Phase 6.6 — it does not invent new ledger or rating primitives.

**Next:** [Phase 7](./unprice-phase-07-credits-wallets.md) adds wallets and
the reservation pattern on top of the simplified DO that lands here.

## Mission

The current `EntitlementWindowDO` is overloaded. `alarm()` flushes analytics,
drives billing into Postgres via `processBillingBatch`, reconciles `billedAt`
on the outbox, and schedules self-destruct. The DO imports `LedgerGateway`,
`RatingService`, and `createConnection` — three services the hot path should
never touch. Rating happens inside the alarm at billing time, which means
every billing cycle re-looks-up plan version pricing in Postgres.

Phase 6.7 is the cleanup that makes Phase 7 safe. Reservation refills
(Phase 7) require the DO to own **local priced consumption** cleanly, with
ledger writes happening outside the hot path. If billing is still inside the
alarm when refills arrive, every hot-path event contends with every cold-path
ledger call for the same DO CPU budget. The DO's value — synchronous
admission control — collapses.

Outcome of this phase:

- `EntitlementWindowDO` has no Postgres client, no `LedgerGateway`, no
  `RatingService`. Its runtime deps are `analytics` (Tinybird), `logger`, and
  a CF Queue producer.
- Rating is pure math inside the DO. The rate card is snapshotted at
  entitlement activation; `applyEventSync` produces a priced fact with
  `amount_cents`, `currency`, and `tier_breakdown`.
- Per-meter spend caps enforce in the hot path alongside unit caps.
- The outbox is single-purpose (DO → Tinybird). Billing to pgledger runs off
  a CF Queue, not off the DO alarm.
- Idempotency storage stops serializing JSON blobs. Columns only.
- Fallback analytics becomes one owned path (DLQ), not a reactive on-failure
  branch.

## Dependencies

- Phase 6 (agent billing foundation) must have landed: `EntitlementWindowDO`
  exists, `billMeterFact` use case exists, the outbox table exists.
- Phase 6.6 (pgledger gateway) must have landed: `LedgerGateway.createTransfers`
  is the only path into pgledger; `Dinero<number>` is the money type at
  service boundaries.

## Read First

- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
  — everything changes here.
- [../../apps/api/src/ingestion/entitlements/db/schema.ts](../../apps/api/src/ingestion/entitlements/db/schema.ts)
  — idempotency + outbox + meter_state tables; adds `meter_pricing`.
- [../../internal/services/src/rating/](../../internal/services/src/rating/)
  — `ratePricedFact` wrapper lands here.
- [../../internal/services/src/use-cases/billing/bill-meter-fact.ts](../../internal/services/src/use-cases/billing/bill-meter-fact.ts)
  — moves from DO import to Queue consumer.
- [../../internal/db/src/validators/subscriptions/prices.ts](../../internal/db/src/validators/subscriptions/prices.ts)
  — `calculatePricePerFeature` is reused, not rewritten.

## Field Validation (April 2026)

Ratings-at-ingest with priced-fact-in-columnar-store is the dominant pattern
across open-source competitors:

- **Lago** writes `events_enriched` with fees computed in a post-process job
  (`Fees::CreatePayInAdvanceJob`). Raw events go to `events_raw` or Postgres;
  enriched rows carry the priced amount.
- **Flexprice** writes `events_processed` in ClickHouse with `qty_billable`,
  `unit_cost`, `cost`, `tier_snapshot`, and a `sign` column (CollapsingMergeTree)
  for corrections. Rating happens in the Kafka post-processing consumer.
- **Polar** mirrors events from Postgres to Tinybird via
  `events_to_tinybird`. Rolled-up state lives in `customer_meter`.
- **OpenMeter** is the outlier: rates at query time via ClickHouse SQL. Their
  grant+snapshot+replay engine exists because recomputing balance over millions
  of events without hot state is expensive. We sidestep this by holding hot
  state in the DO.

The DO's per-`(customer, meter)` sharding gives us **synchronous admission
control** (sub-50ms) that none of these systems have — Metronome is the
closest and still only "stream-processor latency." That is our differentiator.
Don't compromise it by putting billing in the alarm.

## Guardrails

- Zero wallets, zero reservations, zero credits. Those are Phase 7.
- No new pricing math. `calculatePricePerFeature`, `calculateTierPrice`,
  `calculateWaterfallPrice` etc. are the only price functions the DO calls.
- No backward-compatibility shims. Drop columns, drop JSON blobs, migrate
  cleanly.
- DO ends the phase with **zero Postgres client**. If `createConnection`
  appears anywhere under `apps/api/src/ingestion/entitlements/`, the refactor
  is unfinished.
- `RatingService.rateBillingPeriod` stays put (subscription billing). Only
  the event-time path changes.

## Execution Order

The slices below are ordered so each leaves the tree compilable and the DO
functional. Slices 6.7.1–6.7.3 are the architectural core; 6.7.4–6.7.9 are
hygiene and correctness.

### 6.7.1 — Delete billing from the DO alarm

**Intent:** Remove the billing driver from `EntitlementWindowDO`. Alarm becomes
analytics-only.

**Changes:**

- Remove `processBillingBatch` and all call sites.
- Remove imports: `LedgerGateway`, `RatingService`, `GrantsManager`,
  `billMeterFact`, `MeterBillingFact`.
- Remove `createConnection` and the `billingDb` construction block
  (`EntitlementWindowDO.ts:168-189`).
- Remove `this.rating`, `this.ledger` fields.
- `alarm()` reduced to: `flushToTinybird` batch + stale idempotency cleanup +
  self-destruct / reschedule.

**Outcome:** DO constructor is ~30 lines shorter. Alarm path has one concern.

**Completion check:** `rg "createConnection|LedgerGateway|RatingService" apps/api/src/ingestion/entitlements/` returns empty.

### 6.7.2 — Snapshot pricing onto the DO at activation

**Intent:** Make pricing pure math inside the DO. No runtime DB lookup per
event, no re-rating at billing time.

**Schema additions (DO SQLite):**

```ts
// apps/api/src/ingestion/entitlements/db/schema.ts
export const meterPricingTable = sqliteTable("meter_pricing", {
  meterKey: text("meter_key").primaryKey(),
  currency: text("currency").notNull(),
  // Serialized rate card: tiers, packages, free units, aggregation method.
  // Shape mirrors the plan version's feature config so calculatePricePerFeature
  // can consume it directly.
  rateCard: text("rate_card", { mode: "json" }).$type<RateCard>().notNull(),
  pinnedPlanVersionId: text("pinned_plan_version_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

**API surface:**

- Extend `applyInputSchema` with `rateCards: Record<MeterKey, RateCard>`.
- The entitlement activation path (caller of `apply()`) is already loading
  `featurePlanVersion`; extract the rate card from `featurePlanVersion.config`
  and pass it in.
- First `apply()` call for a meter key upserts the row. Subsequent calls
  verify the `pinnedPlanVersionId` matches — mismatch = new entitlement, new
  DO instance.

**Rating inside the DO:**

- Add `applyEventSync`'s `beforePersist` hook computation: after the engine
  produces `{ delta, valueAfter }`, look up the meter's rate card and call
  `calculatePricePerFeature` with `usageBefore = valueAfter - delta`,
  `usageAfter = valueAfter`. Delta in price is `amount_cents`.
- Return shape of fact extends: `{ meterKey, delta, valueAfter, amountCents,
  currency, tierBreakdown }`.

**Outcome:** `buildOutboxFactPayload` fills priced fields directly. No
async pricing lookup anywhere in the DO.

### 6.7.3 — Priced fact becomes the outbox payload

**Intent:** Downstream (Tinybird + pgledger worker) is pure transport.

**Schema change (DO SQLite):** none (payload is already JSON).

**Validator change:** extend `outboxFactSchema` with:

```ts
amount_cents: z.number().int().nonnegative(),
currency: z.string().length(3),
tier_breakdown: z.array(
  z.object({
    tierIndex: z.number().int(),
    units: z.number(),
    unitPriceCents: z.number(),
  })
).optional(),
priced_at: z.number().int(),
```

**Tinybird schema:** mirror the new columns in the
`entitlement_meter_fact_v2` datasource. Keep `v1` for reprocessing until the
cutover is complete, then drop v1.

**Match to field:**

- Flexprice `events_processed` columns: `qty_billable`, `unit_cost`, `cost`,
  `tier_snapshot`. Ours maps cleanly: `delta` → `qty_billable`, derived unit
  cost → `unit_cost`, `amount_cents` → `cost`, `tier_breakdown` →
  `tier_snapshot`.
- Lago `events_enriched`: fees already computed. Equivalent.

### 6.7.4 — Per-meter spend cap enforcement

**Intent:** Real-time spend cap in the hot path, definitive per-meter.

**Schema change (DO SQLite):** extend `meterStateTable`:

```ts
spendCapCents: integer("spend_cap_cents"),  // nullable
spendSoFarCents: integer("spend_so_far_cents").notNull().default(0),
```

**Input surface:** `applyInputSchema.spendCapCents: z.number().int().nullable()`.

**Enforcement:** extend `findLimitExceededFact` to accept `spendCapCents` and
the priced fact. Compare `spendSoFarCents + amountCents > spendCapCents`.
Throw `EntitlementWindowSpendCapExceededError` with dedicated reason.

**Denial reason enum:** `LIMIT_EXCEEDED | SPEND_CAP_EXCEEDED | WALLET_EMPTY`
(last one lands in Phase 7 — reserve the slot now).

**Cross-meter:** not in scope. Spend caps are per-meter (definitive). Cross-meter aggregation requires a fan-in DO and is explicitly excluded.

### 6.7.5 — Single-purpose outbox

**Intent:** One producer (DO), one consumer (Tinybird flush), one lifecycle.

**Schema change:** drop `billedAt` from `meterFactsOutboxTable`. Migration is
a raw SQL `ALTER TABLE DROP COLUMN` in the DO migration set.

**Code change:** delete `deleteFlushedAndBilledRows`. Replace with:

```ts
// After successful flush
this.db.delete(meterFactsOutboxTable)
  .where(inArray(meterFactsOutboxTable.id, flushedIds))
  .run()
```

**SLO metric:** emit `outbox_depth` gauge on every alarm. Alert on backlog >
1,000 rows per DO (indicates Tinybird flush failing).

### 6.7.6 — Idempotency table hygiene

**Intent:** Stop storing JSON in a cell. Queryable columns instead.

**Schema change:**

```ts
export const idempotencyKeysTable = sqliteTable("idempotency_keys", {
  eventId: text("event_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  allowed: integer("allowed", { mode: "boolean" }).notNull(),
  deniedReason: text("denied_reason"),   // enum TEXT or null
  denyMessage: text("deny_message"),     // nullable
})
```

**Code changes:**

- Delete `parseStoredResult`. Return `{ allowed, deniedReason, message }`
  from columns directly.
- Delete `parseApplyInput` re-parse. The boundary (`apply()` caller) validates
  with Zod once; re-validation inside the DO is waste.
- Delete redundant `outboxFactSchema.parse` call inside `buildOutboxFactPayload` —
  we construct the object; we don't need to re-validate it.

### 6.7.7 — Alarm scheduling correctness

**Intent:** Remove the in-memory lie.

**Problem:** `isAlarmScheduled` is a TS field. After DO eviction the field
resets to `false`, but `ctx.storage` may still have an alarm pending. Next
`apply()` attempts to schedule a second alarm.

**Fix:** delete the field. Use `ctx.storage.getAlarm()` for truth. Schedule
with:

```ts
private async scheduleAlarm(target: number): Promise<void> {
  const existing = await this.ctx.storage.getAlarm()
  if (existing !== null && existing <= target) return
  await this.ctx.storage.setAlarm(target)
}
```

Idempotent, survives eviction, no races.

### 6.7.8 — Extract billing worker to CF Queue consumer

**Intent:** Ledger writes move to a pull-based worker outside the DO.

**Flow:**

```
DO.apply()
  ├─ insert outbox row (SQLite, durable)
  └─ ctx.waitUntil(queue.send(pricedFact))  // at-least-once
                                ↓
                    bill-meter-fact-queue
                                ↓
              bill-meter-fact-consumer.ts
                                ↓
         RatingService.ratePricedFact()   ← validates DO math
                                ↓
         LedgerGateway.createTransfers()  ← idempotent by eventId
```

**Implementation:**

- Add CF Queue binding `BILL_METER_FACT_QUEUE` in `wrangler.toml`.
- Create `apps/api/src/queues/bill-meter-fact-consumer.ts`.
- Consumer reads batch of messages, calls `ratePricedFact` per message (new
  thin method — see next bullet), batches ledger transfers into a single
  `createTransfers` call.

**New `RatingService.ratePricedFact`:**

```ts
async ratePricedFact(fact: PricedFact): Promise<Result<LedgerTransfer, RatingError>>
```

- Validates: `amount_cents` matches a fresh `calculatePricePerFeature` run
  against the plan version. Drift = `LEDGER_INVARIANT_VIOLATION`; event is
  quarantined, not silently overwritten (prevents DO clock-skew attacks).
- Returns a `LedgerTransfer` object ready for `createTransfers`.
- Does NOT re-rate — validates the DO rating. If the plan version was deleted
  or archived, transfer still posts against a frozen snapshot (consistent
  with the DO's snapshotted rate card).

**Why validate:** the DO is trusted but not privileged. A stale rate card in
the DO would otherwise propagate silently to the ledger. Validation fails
loud, routes to DLQ, requires operator replay. This is the seam where
"reprocessing on price change" (Flexprice pattern) will eventually hook in.

**Idempotency:** Queue delivery is at-least-once. Consumer uses
`sourceType: "meter_fact_v1"` + `sourceId: fact.id`. Duplicate delivery =
`LedgerGateway.createTransfers` no-ops (pgledger idempotency table from 6.6).

**Backpressure:** Queue DLQ after N retries. DLQ consumer surfaces to ops
dashboard; no silent drops.

### 6.7.9 — Fallback analytics: pick one

**Intent:** Stop the unowned dual-write branch in `flushToTinybird`.

**Current behavior:** on Tinybird failure, write to Analytics Engine. If both
succeed intermittently, data double-lands. If both fail, the outbox row stays
and we retry. No owner for the consistency invariant.

**Decision:** Tinybird + DLQ.

- On Tinybird flush failure, push the failed batch to a dedicated DLQ
  (`analytics-flush-dlq` CF Queue).
- DLQ consumer exposes a replay endpoint. Ops can replay manually or after
  Tinybird SLO restores.
- Delete `writeBatchToFallbackAnalytics` and the `fallbackAnalytics` binding.

**Why not dual-write:** dual-write doubles storage cost without improving
durability (both destinations can fail together if the shared serializer
breaks). DLQ is explicit and cheap.

### 6.7.10 — Tests

- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.spec.ts`:
  - DO snapshot pricing parity: given a rate card, DO-computed `amount_cents`
    matches `RatingService.rateIncrementalUsage` for the same input across
    flat / tier / package pricing.
  - Spend cap enforcement: unit cap + spend cap independent; deny reasons
    distinct; priced fact produced up to the cap, event at the cap denied.
  - Idempotency table: repeated `apply()` with same `idempotencyKey` returns
    stored result from columns (no JSON parse); no new outbox row.
  - Alarm correctness: after simulated DO eviction, `scheduleAlarm` is
    idempotent.
  - Outbox depth: 10k events produce 10k rows; after flush, 0 rows.
- `apps/api/src/queues/bill-meter-fact-consumer.spec.ts`:
  - At-least-once: duplicate message = single ledger transfer.
  - Validation drift: DO-computed `amount_cents` disagreeing with fresh
    `calculatePricePerFeature` routes to DLQ with
    `LEDGER_INVARIANT_VIOLATION`.
  - Batch processing: N messages in → N ledger entries out via one
    `createTransfers` call.
- `internal/services/src/rating/service.spec.ts`:
  - `ratePricedFact` returns `LedgerTransfer` with correct
    `sourceType`/`sourceId`.
  - Stale plan version: rate card snapshot respected; validation against
    current plan still raises drift.

## Non-Goals

- Reprocessing path for price changes mid-period (Flexprice
  `raw_events_reprocessing` equivalent). Document as a known gap.
- Cross-meter spend aggregation. Per-meter is definitive.
- Moving subscription billing to Queue-based. Subscription rating stays
  synchronous at period close.
- Backward compatibility for the DO's v1 outbox payload. Cutover is clean.

## Risk & Mitigations

**Risk: DO rate card drifts from plan version.**
Mitigation: `pinnedPlanVersionId` check on every `apply()`. Plan version
change = new entitlement = new DO instance. Rate card cannot drift without
operator action.

**Risk: Queue send failure inside `apply()` loses billing data.**
Mitigation: outbox row is the durable commit. Queue send is best-effort via
`waitUntil`. A separate periodic sweep (cron or DO alarm fallback) scans
outbox rows older than 5× flush interval and re-enqueues them. Low-frequency
safety net, not hot path.

**Risk: DLQ replay creates duplicate ledger entries.**
Mitigation: `LedgerGateway.createTransfers` idempotency covers this. Same
`sourceId` = no new entry.

**Risk: Removing `RatingService` from DO breaks current behavior where DO
rates at billing time.**
Mitigation: this is the whole point. Rating moves to the Queue consumer.
Behavior change is intentional and documented; tests validate parity.

## Rollout

Single rollout, no feature flag. The DO is stateless between periods
(self-destructs at `periodEndAt + MAX_EVENT_AGE_MS`), so deploying the new
DO code takes effect on the next `apply()` for each entitlement. In-flight
outbox rows with the v1 payload shape need a migration step:

- Deploy with Tinybird v2 datasource already created.
- On first alarm per DO, the flush writes v1 rows to v1 datasource; once
  v1 rows are drained, subsequent flushes write v2 rows to v2.
- After observing v1 datasource drain across fleet (24h), drop v1 datasource
  and the v1 flush branch.

Alternative if simpler: force-drain all outboxes during a maintenance window
before deploy, cutover to v2 only. Pick based on ops preference; the plan
doesn't depend on which.
