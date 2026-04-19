# Phase 6.7: Simplify the Agent Billing Pipeline

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)
PR title: `refactor: strip billing + rating out of EntitlementWindowDO`
Branch: `refactor/agent-billing-simplification`

**Prerequisite:** [Phase 6.6 — pgledger service](./unprice-phase-06.6-new-ledger.md).
**Next:** [Phase 7 — Wallets & Reservations](./unprice-phase-07-credits-wallets.md).

## Mission

`EntitlementWindowDO` today does four unrelated jobs in `alarm()`: flush
analytics to Tinybird, drive billing into Postgres via `processBillingBatch`,
reconcile `billedAt` on the outbox, and self-destruct. It imports
`LedgerService`, `RatingService`, and `createConnection` — three services the
hot path must never touch. Rating runs at billing time, so every billing cycle
re-looks-up plan-version pricing in Postgres.

Phase 6.7 rips the billing driver out of the DO. The alarm becomes a single
concern: batch priced facts to Tinybird. Rating becomes pure math inside
`applyEventSync` against a price config snapshotted at entitlement activation.
No Postgres client in the DO. No ledger writes anywhere in this phase.

Outcome:

- `EntitlementWindowDO` runtime deps are `analytics` (Tinybird) and `logger`.
  That's it. No ledger service, no rating service, no `createConnection`, no
  CF Queue producer for billing.
- Rating is pure math. Price config snapshotted at activation. `applyEventSync`
  returns a priced fact with `amount_cents` and `currency`.
- The outbox is single-purpose: DO → Tinybird. **Zero per-event ledger
  writes exist.** `bill-meter-fact.ts` and `processBillingBatch` are deleted
  with no replacement.
- Idempotency stores in columns, not JSON blobs.
- Tinybird failure path: outbox rows stay for retry on next alarm. No
  dual-write, no separate DLQ queue. `FALLBACK_ANALYTICS` deleted.

## Scope reduction — no per-event ledger work

This phase ships no replacement for the deleted per-event ledger path.
Explicitly not built:

- `BILL_METER_FACT_QUEUE` CF Queue.
- `apps/api/src/queues/bill-meter-fact-consumer.ts`.
- `ctx.waitUntil(queue.send(...))` in `apply()`.
- `RatingService.rateIncrementalUsage` per-event call (replaced by local `calculatePricePerFeature` double-call-and-diff in the DO).
- Per-meter spend caps. Phase 7 owns spend enforcement via the reservation primitive.
- `analytics-flush-dlq` CF Queue. The outbox is the retry buffer.

Phase 7's reservation primitive pre-moves funds into a reserved account
before the DO sees an event. Building a per-event ledger write now, only to
delete it on the Phase 7 cutover, is wasted engineering and a double-book
risk.

**The gap.** Between Phase 6.7 and Phase 7 shipping, agent meter facts
produce **no ledger entries**. Tinybird still records every priced fact with
full detail (delta, valueAfter, amount_cents, currency).
`customer.{id}.consumed` does not advance for agent usage during the gap.
Subscription billing via `invoiceSubscription` is unaffected — it uses its
own path through `RatingService.rateBillingPeriod` and `LedgerService`.

Acceptable because: agent billing is freshly shipped with limited rollout,
Phase 7 is the very next merge, and replaying Tinybird into Phase 7's
reservation lifecycle is mechanically possible if a specific customer needs
back-fill. If the gap matters, accelerate Phase 7 — do not reinflate 6.7.

## Dependencies

- Phase 6 landed (`EntitlementWindowDO`, `billMeterFact`, outbox table).
- Phase 6.6 landed (`LedgerService`, `Dinero<number>` at service boundaries).

## Read first

- `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` — everything changes here.
- `apps/api/src/ingestion/entitlements/db/schema.ts` — outbox, idempotency, meter_state; gains `meter_pricing`.
- `internal/services/src/use-cases/billing/bill-meter-fact.ts` — deleted.
- `internal/db/src/validators/subscriptions/prices.ts` — `calculatePricePerFeature` is reused, not rewritten.

## Guardrails

- Zero wallets, zero reservations, zero credits, zero spend caps. That's Phase 7.
- No new pricing math. `calculatePricePerFeature` and its tier helpers are the only price functions the DO calls.
- No backward-compatibility shims. Drop columns, drop JSON blobs, migrate cleanly.
- DO ends the phase with zero Postgres client. If `createConnection` appears under `apps/api/src/ingestion/entitlements/`, the refactor is unfinished.
- `RatingService.rateBillingPeriod` stays put — subscription billing is not touched here.

## Slices

### 6.7.1 — Delete billing from the DO alarm and the use case behind it

Intent: remove the billing driver from `EntitlementWindowDO` and the use
case it calls. Alarm becomes analytics-only. No replacement.

Changes:

- Remove `processBillingBatch` from the DO and all call sites.
- Remove imports: `LedgerService`, `RatingService`, `GrantsManager`, `billMeterFact`, `MeterBillingFact`.
- Remove `createConnection` and the `billingDb` block (`EntitlementWindowDO.ts:168-189`).
- Remove `this.rating`, `this.ledger` fields.
- `alarm()` reduces to: flush to Tinybird + stale idempotency cleanup + self-destruct / reschedule.
- Delete `internal/services/src/use-cases/billing/bill-meter-fact.ts` and its test. Delete `MeterBillingFact` and related exports from `internal/services/src/use-cases/index.ts`. The `billing/` directory may be empty — delete it if so.
- Do not add a CF Queue binding, consumer, or per-event validator. Phase 7 owns the next ledger model.

Completion check:

```
rg "createConnection|LedgerService|RatingService|billMeterFact" apps/api/src/ingestion/entitlements/
# → empty
rg "bill-meter-fact|billMeterFact|MeterBillingFact" internal/ apps/
# → empty
```

### 6.7.2 — Snapshot pricing onto the DO at activation

Intent: pricing is pure math inside the DO. No runtime DB lookup, no
re-rating at billing time.

Schema (DO SQLite, `apps/api/src/ingestion/entitlements/db/schema.ts`):

```ts
export const meterPricingTable = sqliteTable("meter_pricing", {
  meterKey: text("meter_key").primaryKey(),
  currency: text("currency").notNull(),
  priceConfig: text("price_config", { mode: "json" }).$type<PriceConfig>().notNull(),
  pinnedPlanVersionId: text("pinned_plan_version_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

Where `PriceConfig` = `z.infer<typeof configFeatureSchema>` from
`internal/db/src/validators/planVersionFeatures`.

API:

- Extend `applyInputSchema` with `priceConfigs: Record<MeterKey, PriceConfig>`.
- The activation caller already loads `featurePlanVersion`; extract the config from `featurePlanVersion.config` and pass it in.
- First `apply()` per meter upserts the row. Subsequent calls verify `pinnedPlanVersionId`; mismatch = new entitlement = new DO instance.

Rating inside the DO:

- In `applyEventSync`'s `beforePersist` hook: after `{delta, valueAfter}` is produced, look up the snapshotted price config and compute the price delta using the same double-call-and-diff pattern that `RatingService.rateIncrementalUsage` uses today:
    1. `priceBefore = calculatePricePerFeature({ quantity: valueAfter - delta, featureType, config })` (usage before this event)
    2. `priceAfter  = calculatePricePerFeature({ quantity: valueAfter, featureType, config })` (usage after this event)
    3. `amountCents = priceAfter.totalPrice.dinero - priceBefore.totalPrice.dinero`
  This is pure math — no DB, no `RatingService` instance. The config and `featureType` come from the snapshotted `meter_pricing` row.
- Extended fact shape: `{ meterKey, delta, valueAfter, amountCents, currency }`.

Outcome: `buildOutboxFactPayload` fills priced fields directly. No async
pricing lookup anywhere in the DO.

### 6.7.3 — Priced fact becomes the outbox payload

Intent: downstream is pure transport.

Validator (`outboxFactSchema`) gains:

```ts
amount_cents: z.number().int().nonnegative(),
currency: z.string().length(3),
priced_at: z.number().int(),
```

No `tier_breakdown`. The outbox transports `amount_cents` and `currency` —
that's what Tinybird aggregates need. Tier decomposition is internal to
`calculatePricePerFeature` and doesn't belong in the transport schema. If
tier debug data is needed, log it.

Tinybird: mirror the new columns in `entitlement_meter_fact_v2`. Keep v1
for in-flight drain until cutover, then drop v1.

### 6.7.4 — Single-purpose outbox

Intent: one producer (DO), one consumer (Tinybird), one lifecycle.

- Drop `billedAt` from `meterFactsOutboxTable` (raw `ALTER TABLE DROP COLUMN`).
- Replace `deleteFlushedAndBilledRows` with:

  ```ts
  this.db.delete(meterFactsOutboxTable)
    .where(inArray(meterFactsOutboxTable.id, flushedIds))
    .run()
  ```

- Emit `outbox_depth` gauge on every alarm. Alert on > 1,000 rows per DO (Tinybird flush failing).

### 6.7.5 — Idempotency table hygiene

Intent: queryable columns, not a JSON cell.

```ts
export const idempotencyKeysTable = sqliteTable("idempotency_keys", {
  eventId: text("event_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  allowed: integer("allowed", { mode: "boolean" }).notNull(),
  deniedReason: text("denied_reason"),
  denyMessage: text("deny_message"),
})
```

Delete: `parseStoredResult`, `parseApplyInput` re-parse, the redundant
`outboxFactSchema.parse` inside `buildOutboxFactPayload`. Boundary
validation once at `apply()` entry is enough.

### 6.7.6 — Alarm scheduling correctness

Intent: remove the in-memory lie.

Problem: `isAlarmScheduled` is a TS field. After DO eviction the field
resets to `false` while `ctx.storage` may still have an alarm pending.

Fix: delete the field. Use `ctx.storage.getAlarm()` for truth:

```ts
private async scheduleAlarm(target: number): Promise<void> {
  const existing = await this.ctx.storage.getAlarm()
  if (existing !== null && existing <= target) return
  await this.ctx.storage.setAlarm(target)
}
```

### 6.7.7 — Kill FALLBACK_ANALYTICS, outbox as retry buffer

Intent: stop the unowned dual-write branch in `flushToTinybird`.

Changes:

- Delete `writeBatchToFallbackAnalytics` and the `fallbackAnalytics` field from the DO.
- Remove the `FALLBACK_ANALYTICS` binding from wrangler config and the test mock.
- On Tinybird flush failure: log the error, leave unflushed rows in the outbox. The next alarm retries them.

The outbox *is* the retry buffer. Rows that fail to flush stay put and get
picked up on the next alarm cycle. The `outbox_depth` gauge from 6.7.4
alerts if retries aren't clearing. No new CF Queue, no new binding. If
outbox depth alerts start firing in production and retries aren't sufficient,
build a DLQ then — not now.

Completion check:

```
rg "FALLBACK_ANALYTICS|fallbackAnalytics|writeBatchToFallback" apps/api/src/ingestion/entitlements/
# → empty
```

### 6.7.8 — Tests

`apps/api/src/ingestion/entitlements/EntitlementWindowDO.spec.ts`:

- **Snapshot pricing parity:** DO `amount_cents` matches `calculatePricePerFeature` across flat / tier / package pricing.
- **Idempotency:** repeat `apply()` with same key returns stored result from columns; no new outbox row.
- **Alarm:** `scheduleAlarm` is idempotent across simulated eviction.
- **Outbox depth:** 10k events → 10k rows, post-flush → 0 rows.
- **Flush retry:** failed flush leaves rows in outbox; next alarm retries successfully; outbox drains to 0.
- **Zero billing side effects:** 10k `apply()` calls create no pgledger entries, open no Postgres connection from the DO, invoke no `LedgerService` / `RatingService` method. Regression guard for 6.7.1.

### 6.7.9 — Load validation experiment (the gate for Phase 7)

Intent: before declaring 6.7 done, prove the simplified DO holds up under
agent-scale load. Phase 7 does not open until this slice passes.

Setup: single DO instance pinned to one `(customer, meter)`. Representative
AI-pricing price config (tiered per-token). Event cost `$0.001`. 10,000
events/sec sustained for 60 seconds (600k total) from a synthetic loadgen
hitting the ingestion adapter. Tinybird `entitlement_meter_fact_v2` ready.

Targets:

| Metric | Target | Failure means |
|---|---|---|
| `apply()` p50 | < 5 ms | — |
| `apply()` p95 | < 20 ms | — |
| `apply()` p99 | < 50 ms | Hot path still doing DB / async work |
| DO Postgres connections opened | 0 | `createConnection` not fully removed |
| `LedgerService` calls from DO | 0 | Stale import or call site |
| `RatingService` calls from DO | 0 | Stale import; rating must be local |
| pgledger entries during run | 0 | Per-event path still wired; 6.7.1 incomplete |
| Tinybird flush success | 100% | Investigate outbox depth |
| Outbox depth post-burst | 0 within 2× flush interval | Flush bottleneck |
| Idempotency replay | duplicate key returns stored result, no extra outbox row | 6.7.5 incomplete |

Failure-mode playbook:

- **p99 > 50 ms** → instrument `applyEventSync` stage-by-stage (price config lookup, delta compute, SQLite write). One is the culprit.
- **Outbox grows monotonically during burst** → Tinybird flush is the bottleneck. Tune `FLUSH_INTERVAL_MS` and batch size.
- **Any pgledger entry appears** → 6.7.1 missed a call site. `rg "ledger|LedgerService|billMeterFact" apps/api/src/ingestion/entitlements/` must be empty.
- **Postgres connection from DO** → `createConnection` survived. `rg "createConnection" apps/api/src/ingestion/entitlements/` must be empty.

Exit criteria: all targets pass on a clean run, numbers in the PR
description (not just "green"), no manual intervention. Do not merge with
a failing experiment marked "we'll fix in Phase 7" — Phase 7 is unsafe
without this baseline.

## Non-goals

- Per-event ledger writes. Phase 7 owns this via the reservation primitive.
- Reprocessing path for mid-period price changes. Known gap.
- Spend caps (per-meter or cross-meter). Phase 7 owns spend enforcement.
- Moving subscription billing to a queue. Period-close stays synchronous.
- Backward compatibility for the DO's v1 outbox payload or for deleted use cases.
- Tier breakdown in the outbox payload. Internal to pricing math.

## Risks

**DO price config drifts from plan version.** `pinnedPlanVersionId` is checked
on every `apply()`. Plan-version change = new entitlement = new DO instance.

**Agent meter usage produces no ledger entries during the 6.7 → 7 gap.**
Documented. Tinybird captures every priced fact; replay into Phase 7's
reservation lifecycle is mechanically possible if needed.

**Subscription billing breaks because `invoiceSubscription` calls into the
deleted use case.** It doesn't. Verify with
`rg "billMeterFact" internal/services/src/subscriptions/` (must be empty)
before merging 6.7.1.

## Rollout

Single rollout, no feature flag. DO self-destructs at
`periodEndAt + MAX_EVENT_AGE_MS`, so new code takes effect per-entitlement
on the next activation.

1. Migration adds `meter_pricing` columns.
2. Deploy DO code and the Tinybird `entitlement_meter_fact_v2` datasource.
3. Run slice 6.7.9 against staging. Must pass.
4. Production deploy. Existing DOs run pre-6.7 code until they self-destruct.
5. After 24h, drop v1 Tinybird datasource and the v1 flush branch.

Alternative: force-drain outboxes during a maintenance window and cutover
to v2 only. Pick based on ops preference.
