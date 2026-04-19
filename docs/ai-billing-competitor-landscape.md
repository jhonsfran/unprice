# AI & Usage-Based Billing: The Competitive Landscape

A field guide to how the five most relevant usage-based billing platforms —
**Lago**, **OpenMeter**, **Flexprice**, **Polar.sh**, and **Metronome** —
actually work under the hood, and where Unprice differs.

This doc is for someone who has shipped software but hasn't spent years in
billing systems. It explains the shared patterns first, then walks through
each competitor, then states what Unprice does differently and why that
matters.

---

## The problem everyone is solving

A modern billing platform has to do three things at once, and they pull in
opposite directions:

1. **Ingest events fast.** An agent making 10,000 LLM calls per minute
   produces 10,000 billable events per minute. The ingestion endpoint has to
   accept them without queueing up, without dropping them, and without making
   the customer wait.
2. **Enforce limits and balances in real time.** If a customer has a $100
   spending cap or a 10,000-request quota, event #10,001 has to be rejected
   before it costs you money. "Real time" here means the decision lands
   before the response goes back to the end user — typically under 100ms
   total.
3. **Bill correctly and auditably.** Every event that was accepted eventually
   turns into money on an invoice, or a debit against a prepaid credit
   balance. Nothing can be double-counted, lost, or silently dropped. Auditors
   and finance teams need to be able to trace every dollar back to the events
   that generated it.

These three goals fight each other:

- **Speed vs. correctness.** The fastest place to accept an event is an
  in-memory counter. The most correct place is a write-ahead-logged database
  with constraints. You can't have both without some architecture.
- **Ingest vs. enforce.** Enforcement requires knowing the current state
  (balance, quota used, spend so far). That state needs to be queryable
  within the admission path. Distributed state is expensive to query fast.
- **Real-time vs. audit trail.** An append-only audit log is slow to read.
  A cached balance is fast to read but can drift from the log.

Every platform in this space makes a specific set of choices about how to
reconcile those goals. The choices are the architecture.

---

## The shared vocabulary

Before comparing them, here are the concepts that show up across all five.

### Event

One usage record. "User X called feature Y at time T with these properties."
Identified by a globally unique `event_id` (or `transaction_id`) so the
platform can dedupe retries.

### Meter

A definition of "how to count events into a billable quantity." Examples:
`count events where feature='api_call'`, `sum properties.tokens`, or
`distinct count properties.session_id`. A meter converts raw events into a
scalar usage number per customer per period.

### Rating

Turning usage into money. "5,000 API calls × $0.01 each = $50." Rating
applies pricing rules: flat fees, tiered rates, volume discounts, package
pricing, free tiers.

### Ledger

An append-only record of money movements. "At time T, customer C was
charged $0.50 for event E." A true double-entry ledger records every charge
as a transfer between two named accounts (customer and revenue), so the
books always balance.

### Wallet / Credits

A prepaid balance the customer has funded. Consumed as usage is billed. When
it runs out, new events are rejected (hard cap) or queued for invoicing
(soft cap).

### Settlement

The act of converting billable charges into money-in-the-bank. Invoice
generation, payment capture, wallet debits. Settlement is usually the
slowest part of the pipeline — it involves tax calculation, payment
providers, webhooks, and retries.

### Idempotency

The property that doing the same thing twice has the same effect as doing
it once. Essential because networks retry, Kafka delivers at-least-once, and
distributed systems double-fire. Every event, every ledger entry, every
payment attempt must be idempotent.

---

## The architectural patterns

There are roughly four patterns the field has converged on. Every platform
uses some mix of these.

### Pattern 1: Rate at ingest

When an event arrives, look up the meter, compute the priced amount right
then, and write a "priced fact" to storage. The fact carries both the raw
usage (`delta_units`) and the money (`amount_cents`).

**Pro:** downstream systems (analytics, billing, dashboards) read a single
priced fact without re-rating. Rating is pure math at query time.

**Con:** if the price changes mid-period, historical events carry the old
price. Reprocessing requires rerunning rating over raw events.

Used by: Flexprice (`events_processed`), Lago (`events_enriched`), Unprice.

### Pattern 2: Rate at read

Store raw events only. Compute price whenever you need to know it — usually
at invoice time via an aggregation query.

**Pro:** price changes reflect immediately on all historical events (good
for correction flows and test pricing).

**Con:** every report or invoice runs a full aggregation. Expensive at
scale. Requires a columnar database (ClickHouse, Druid) to stay fast.

Used by: OpenMeter (evaluates meter SQL against ClickHouse at read time).

### Pattern 3: Priced-fact columnar store

Store the priced events in a columnar database (ClickHouse, BigQuery,
Tinybird). Use the columnar store for analytics, dashboards, and rolled-up
billing. Use a transactional database (Postgres) only for money movements.

**Pro:** analytics are cheap and fast. Transactional load on Postgres stays
small (dozens of entries per customer per month, not millions).

**Con:** the columnar store is eventually consistent. Admission decisions
can't read from it directly — they need a separate hot-state store.

Used by: Flexprice (ClickHouse), Polar (Tinybird mirror), Lago (enriched),
Unprice (Tinybird).

### Pattern 4: Credit grant + replay

Store credit grants as rows with a timestamp. Compute balance by replaying
usage against grants from the beginning (or since the last snapshot). Cheap
to write, expensive to read — solved by periodic balance snapshots.

**Pro:** no cached balance to drift. Balance is always recomputable from
first principles.

**Con:** reads are slow without snapshots. Can't do hard reservations
("this chunk of balance is mine for the next hour") because balance is
computed, not held.

Used by: OpenMeter (grants + `balance.Snapshot` + replay engine).

### Pattern 5: Reservation / allocation

Pull a chunk of balance out of the wallet into a named "reserved" account.
Consume against the reservation locally. Refill when low. Reconcile unused
at period end.

**Pro:** hot-path consumption is local to wherever the reservation lives —
no wallet round-trip per event. Hard caps are possible (reservation runs
out = hard stop). Ledger writes are few (a handful per customer per period).

**Con:** small overdraft bound equal to refill chunk size. Requires a
refill orchestrator.

Used by: Lago (`WalletTransactionConsumption` rows), Unprice (the full
reservation primitive — see Phase 7).

---

## The five competitors

### Lago

**Origin:** French open-source billing platform, founded 2021. Ruby on
Rails monolith, Postgres primary store, ClickHouse for high-volume raw
events. Positioned as the Stripe Billing alternative for usage-based SaaS.

**Event ingest path:**
`HTTP POST /events` → `Events::CreateService` → save event to Postgres
(or send to Kafka for ClickHouse organizations) → enqueue `Events::PostProcessJob`
async.

The sync path is fast (a few ms) because pricing work is deferred to the
async job. The async job enriches the event (`events_enriched` table)
with the computed fee amount. If the event is "pay-in-advance" (charge on
admission), a `Fees::CreatePayInAdvanceJob` processes it separately.

**Storage:** Postgres for most customers. ClickHouse optional for very
high-volume customers, populated via Kafka.

**Ledger:** Rolled-up wallet transaction ledger. `wallet_transactions` is
split into `inbound` (credit, has `remaining_amount_cents`) and `outbound`
(debit). A `wallet_transaction_consumption` join table records which
inbound rows funded which outbound rows, in priority order. This **is** an
allocation ledger — it's the pattern Unprice Phase 7 adopts.

**Wallet / credits:** First-class. Inbound transactions have priorities and
expiries. Consumption picks the oldest-expiring, highest-priority inbound
first (FIFO within priority). Credits are modeled as inbound wallet
transactions with `source='system'`.

**Spending caps:** Eventually consistent. A `UsageMonitoring::ProcessWalletAlertsJob`
runs after events post-process and fires webhooks when thresholds trip.
Enforcement is app-side (customer's code must block on alerts).

**Rating location:** Post-process async job. `events_enriched` carries the
priced amount.

**What Lago does well:** The allocation ledger. `wallet_transaction_consumption`
is a clean, auditable way to record "which credits paid for which usage."
Unprice Phase 7 borrows this shape directly.

**What Lago doesn't do:** Synchronous admission control. Because rating is
async, Lago can't stop event #10,001 from being accepted when the cap is
10,000. The spend-alert path is informational, not blocking.

### OpenMeter

**Origin:** Open-source metering platform built specifically for AI usage.
Go backend, Kafka for ingest, ClickHouse for storage. Focus on developer
experience and integration with LLM platforms.

**Event ingest path:**
`HTTP POST /events` (CloudEvents format) → Kafka → sink worker batches
→ ClickHouse `om_events` via `BatchInsert`. The Kafka partition key is a
hash of the event ID, which gives them automatic deduplication and
per-customer ordering.

**Storage:** ClickHouse is the primary event store. Postgres holds the
configuration: meters, grants, subscriptions.

**Ledger:** No written ledger. OpenMeter computes balance on the fly by
replaying grants against usage. A `balance.Snapshot` row periodically
captures a known-good balance state, so replay only needs to cover "events
since last snapshot."

**Wallet / credits:** Grants have priority, recurrence rules, and expiry.
No explicit allocation row — balance = `sum(grant amounts) − usage since
grant start`, computed by the replay engine at read time. This means
there's nothing to "hold" — you can't make a hard reservation because there's
nothing to put the reservation on.

**Spending caps:** Query-time. When usage is read, the replay engine
returns current balance. Enforcement is the application's job — call the
balance API, check, decide. Not synchronous in the admission path unless
the app adds its own caching layer.

**Rating location:** Read time. Meter definitions are SQL templates that
run against ClickHouse. Pricing is applied when results are returned.

**What OpenMeter does well:** The grant model is elegant. Everything
derives from first-principles event history; nothing can drift because
there's no cached state to drift. The snapshot + replay pattern is clever.

**What OpenMeter doesn't do:** Hard reservations. Synchronous real-time
enforcement. Low-latency admission against a wallet balance. These are
architectural choices — they match OpenMeter's "metering platform, bring
your own enforcement" positioning, but they don't match the "AI-native
spending control" use case.

### Flexprice

**Origin:** Newer (2024) open-source AI-first billing platform. Go
backend, Kafka via Watermill, ClickHouse for both raw and processed
events. Direct competitor framing against OpenMeter and Lago.

**Event ingest path:**
`HTTP POST /events` → Kafka (via Watermill) → ClickHouse `events` (raw).
A second topic carries events into a post-processing consumer that looks up
the meter, looks up the price, computes the billable amount, and writes to
`events_processed` — a ClickHouse table with columns `qty_billable`,
`unit_cost`, `cost`, `tier_snapshot`, and a `sign` column that enables
correction via `CollapsingMergeTree` (writing a `sign=-1` row effectively
negates a `sign=+1` row during merges).

Partitioning is manual — Kafka partition key is `tenant_id:external_customer_id`,
giving per-customer ordering.

**Storage:** ClickHouse for raw and processed events; Postgres for
configuration and the `wallet_transactions` ledger.

**Ledger:** `wallet_transactions` (credit/debit), idempotent, with prorated
top-ups and conversion rates. Balance is cached; reconciled against
pgledger-equivalent data periodically.

**Wallet / credits:** First-class. Prepaid wallets with conversion rates.
Credit grants via `source='system'` wallet transactions.

**Spending caps:** `wallet_balance_alert` triggered post event-processing.
Same limitation as Lago — informational, not blocking.

**Rating location:** Post-processing consumer (Pattern 1, rate-at-ingest).
They explicitly built `raw_events_reprocessing.go` to handle the case where
prices change and historical events need rerating.

**What Flexprice does well:** The `events_processed` schema is clean —
`qty_billable`, `unit_cost`, `cost`, `tier_snapshot` on every row. The
reprocessing path is a first-class concern. The ClickHouse `sign` column
for corrections is clever.

**What Flexprice doesn't do:** Synchronous admission. Hard reservations.
Same gap as Lago and OpenMeter — Kafka-based pipelines don't give
sub-100ms admission decisions.

### Polar.sh

**Origin:** Open-source monetization platform for developers. Python
(SQLAlchemy + FastAPI), Postgres primary, Tinybird for analytics. Focus
on developer products (GitHub sponsors-like, Creator-as-a-service).

**Event ingest path:**
`HTTP POST /v1/events` → SQLAlchemy `Event.insert` → Postgres (sync) +
async mirror to Tinybird via `events_to_tinybird`. Synchronous insertion
to Postgres means the admission path is blocking on a DB write — fast but
has throughput limits.

**Storage:** Postgres primary (source of truth). Tinybird mirror for
analytics and dashboards. The mirror runs via a background task.

**Ledger:** `customer_meter` table holds rolled-up per-customer state:
`consumed_units`, `credited_units`, `balance`, `last_balanced_event_id`.
Not a true double-entry ledger. `billing_entry` carries debit/credit
direction at invoice-time materialization.

**Wallet / credits:** `account_credit` and `customer_meter.credited_units`.
Credits are events with `source='system'` that bump `credited_units`.
Balance = `credited_units − consumed_units`.

**Spending caps:** Webhook-driven from `billing_entry` summation. Not
pre-ingest.

**Rating location:** Invoice materialization. `BillingEntryService.compute_pending_subscription_line_items`
runs when invoices are cut.

**What Polar does well:** The Postgres + Tinybird dual-storage mirror is a
clean way to separate transactional and analytical concerns. The
`customer_meter` rollup table is a simple, queryable representation of
"where does this customer stand right now."

**What Polar doesn't do:** Async ingestion (they're sync-to-Postgres, which
limits scale). Reservations. Real-time enforcement.

### Metronome

**Origin:** YC-backed 2019, closed-source commercial platform. Snowflake
and OpenAI are customers. Heavy Kafka/Confluent infrastructure. Aimed at
high-volume enterprise usage billing.

**Event ingest path:**
`HTTP POST /ingest` or batch → Confluent Kafka → proprietary stream
processors → internal storage. Metronome is explicit about being a
"streaming billing platform" — every step is Kafka-mediated.

**Storage:** Proprietary. Public docs hint at Kafka-backed event storage
with periodic aggregation into a rating engine. No public schema.

**Ledger:** Contract-level drawdown. "Commits" are prepaid amounts that
draw down as usage accrues. Minimum spend commitments are tracked at the
contract level, not per-event.

**Wallet / credits:** "Commits" are Metronome's version of prepaid
credits — they're drawn down by usage at configurable rates. Refill is
manual or automatic on contract renewal.

**Spending caps:** Evaluated inline on the Kafka stream. Alerts fire
webhooks; enforcement is app-side. This is the closest any of these
competitors get to "real-time enforcement," but it's still
stream-processor latency (tens of ms), not synchronous admission.

**Rating location:** Stream processing during aggregation + final pass at
invoice time.

**What Metronome does well:** Scale. Their architecture is genuinely
built for the billions-of-events-per-day tier (OpenAI, Snowflake). The
contract-based commit model is sophisticated.

**What Metronome doesn't do:** Open source (obviously). Sub-100ms
synchronous admission. Customer-accessible architecture for custom
integrations.

---

## Comparison table

| | Lago | OpenMeter | Flexprice | Polar.sh | Metronome | **Unprice** |
|---|---|---|---|---|---|---|
| **Ingest** | Async (Kafka or Postgres + job) | Async (Kafka) | Async (Kafka via Watermill) | Sync (Postgres) + async Tinybird mirror | Async (Kafka) | **Sync (DO) + async Queue mirror** |
| **Raw event store** | Postgres or ClickHouse | ClickHouse | ClickHouse | Postgres + Tinybird | Proprietary Kafka-backed | **Tinybird (DO outbox flush)** |
| **Ledger model** | `wallet_transactions` + consumption rows (allocation ledger) | Grants + snapshots + replay (no ledger rows per event) | `wallet_transactions` + cached balance | `customer_meter` rollup + `billing_entry` | Contract-level drawdown | **pgledger double-entry + reservation primitive** |
| **Wallet / credits** | Priority-ordered inbound/outbound (FIFO consumption) | Grants with replay | Prepaid wallets + conversion rates | `customer_meter.credited_units` | "Commits" drawn down by usage | **Priority-ordered funding sources; reservation chunks** |
| **Spending cap enforcement** | Post-process webhooks (informational) | Query-time (app-side) | Post-process alerts | Webhook from billing_entry | Stream-processor alerts (app-side) | **Synchronous in DO (sub-100ms)** |
| **Rating location** | Post-process async job | Query time (SQL on ClickHouse) | Post-process async job | Invoice materialization | Stream + invoice | **At admission (DO with snapshotted rate card)** |
| **Hard reservation possible?** | No (consumption is FIFO post-hoc) | No (balance is computed) | No (balance is cached) | No (rollup is post-hoc) | Limited (via commits at contract level) | **Yes (per-entitlement allocation)** |
| **Open source?** | Yes (AGPL) | Yes (Apache 2) | Yes (AGPL) | Yes (Apache 2) | No | Yes |

---

## Where Unprice is different

Unprice is architecturally closer to the field than it looks — priced-fact-in-columnar-store
is the dominant pattern, and Unprice's Tinybird flush matches it. But two
things are genuinely different, and they compound.

### 1. Synchronous admission control via Durable Objects

Every other platform in this list runs events through Kafka, async jobs, or
post-process pipelines before decisions get made. Their "real time" is
tens-of-milliseconds-to-seconds latency for a limit decision to reach
the application.

Unprice uses Cloudflare Durable Objects sharded per `(customer, meter)`.
Each DO is a single-threaded actor with co-located SQLite. When an event
arrives:

- The request lands at the edge (CF Worker).
- The worker calls the appropriate DO instance via RPC.
- The DO checks idempotency, applies the meter logic, checks unit + spend
  caps, and returns a decision.
- The whole round-trip is sub-50ms in-region.

No Kafka. No stream processor. No post-process job. The admission decision
is made inline with the request, by a single process that owns all of this
customer's state for this meter.

**Why this matters for AI workloads:** agents make decisions based on
whether a request was allowed. If the decision takes 500ms, the agent stalls
or makes the call anyway (blowing the cap). If the decision is
synchronous and fast, the agent can branch on the response and stay within
budget. This is the difference between "metering platform + your own
enforcement" and "an actual API gateway that tells your agent to stop."

The DO pattern also gives free per-customer serialization. When three
events for the same customer+meter arrive in parallel, they're processed
serially by the DO. No distributed locks. No optimistic retry loops. No
"last writer wins" races.

### 2. Reservations with hard caps

OpenMeter can't do reservations because balance is computed from event
replay. Lago comes close with its `wallet_transaction_consumption` rows,
but the consumption happens after the event is accepted — you can overrun
between the event and the post-process fee computation.

Unprice's reservation primitive (Phase 7) pulls a chunk of funded money
out of the customer wallet, gives it to the DO, and lets the DO consume it
locally. The DO enforces `allocation_remaining ≥ amount_cents` before
admitting any priced event. When the allocation runs out and no refill is
in flight, the DO denies — **synchronously, before the event lands**.

This is what makes "spending caps on AI workloads" tractable. An agent
calling an LLM 10,000 times per minute cannot be rate-limited by a
Postgres write per call. It can be rate-limited by a local SQLite
decrement per call, which is what the DO provides.

The overdraft bound is `refill_chunk × concurrent_meters_per_customer` —
in practice, a few dollars on a $100 cap. That's a rounding error, not a
financial loss. Lago's post-hoc consumption has an unbounded overdraft
(whatever slipped through between event and job).

### 3. Ledger writes stay small

Because the DO holds allocation locally, the ledger only sees money
movements at reservation creation, refill, and reconciliation. For a
customer with 1M events per month, pgledger sees roughly 10 entries —
not 1M. This is the Idiot Index insight: you're paying OLTP IOPS for
operations that fundamentally don't need OLTP guarantees. Unprice doesn't.

OpenMeter sidesteps this by not having a ledger at all. Lago and Flexprice
pay the OLTP cost. Metronome has custom infrastructure at a scale most
teams can't replicate. Unprice runs on Postgres + pgledger, which any team
can deploy, at a write volume any Postgres can handle.

### 4. Pricing snapshotted onto the DO

OpenMeter and Flexprice both rate events either at read time or in a
post-process job. Both have a "what if prices change mid-period" problem
they solve differently — OpenMeter re-rates every read; Flexprice has an
explicit `raw_events_reprocessing` path.

Unprice snapshots the rate card onto the DO at entitlement activation. The
DO computes the priced amount using pure math, inline with the event.
Price changes mid-period create a new entitlement version (standard billing
practice — contracts don't retroactively re-price). No reprocessing needed
for the common case.

This also means rating is testable as pure math. No database, no Kafka,
no side effects — `calculatePricePerFeature(rateCard, usage)` is a
deterministic function. That's a huge correctness win over async rating
pipelines where the test requires spinning up the whole stack.

### 5. Credits and wallets as funding sources, not special cases

Credit grants in Unprice are pgledger accounts. Wallets are pgledger
accounts. Postpaid accrual is a pgledger account. All three participate in
the same funding priority order at reservation creation. There's no
"SettlementRouter" deciding per event where money comes from — the
funding strategy is chosen once at entitlement creation, and the DO doesn't
care.

This is a conceptual simplification. Lago's wallet is first-class but
credits layer on top as "wallet transactions with `source='system'`."
OpenMeter's grants are separate machinery from any wallet concept. Unprice
treats them all as the same primitive: an account that holds money that
can fund reservations. Adding a new funding type (e.g., "sponsored
credits from a partner") is a new row in a funding-strategy config, not a
new code path.

---

## When a competitor might be the right choice

Unprice's bet is specific: AI-native workloads with synchronous admission
control. That's not always what someone needs.

- **Low-volume SaaS billing where spending caps don't matter:** Lago is
  great. Simpler to deploy, mature feature set, large community, battle-tested
  invoicing.
- **Metering platform where the customer brings their own enforcement
  layer:** OpenMeter. Their architecture is cleaner for "give me an API
  that tracks usage, I'll handle the business logic."
- **Enterprise contract billing with commits and minimum spends:**
  Metronome. If you're already using Snowflake-scale infrastructure and
  have a finance team that speaks in "true-ups" and "overage rates," they
  have the depth.
- **Creator / solo-dev monetization:** Polar.sh is purpose-built for that
  market.
- **Ship-fast prototype without Durable Objects:** Flexprice's
  Kafka + ClickHouse stack is the mainstream choice if you're already
  running that infrastructure.

Unprice wins specifically when:
- Latency matters (AI agents, real-time decisions).
- Spending caps are a hard requirement (wallets, regulated workloads,
  cost-sensitive customers).
- Credits and wallets are core to the product, not an afterthought.
- The team wants to deploy on Cloudflare + Postgres without standing up a
  Kafka + ClickHouse pipeline.

---

## Further reading

- [Phase 6.7 — Agent Billing Simplification](./plans/unprice-phase-06.7-agent-billing-simplification.md)
  — the DO becomes a clean priced-fact producer.
- [Phase 7 — Credits, Wallets & Reservation-Based Allocation](./plans/unprice-phase-07-credits-wallets.md)
  — the reservation primitive.
- [Lago on GitHub](https://github.com/getlago/lago-api) — especially
  `app/services/events/` and `app/models/wallet_transaction*.rb`.
- [OpenMeter on GitHub](https://github.com/openmeterio/openmeter) —
  especially `openmeter/credit/engine/` and `openmeter/sink/`.
- [Flexprice on GitHub](https://github.com/flexprice/flexprice) — especially
  `internal/service/event_post_processing.go` and
  `internal/repository/clickhouse/processed_event.go`.
- [Polar on GitHub](https://github.com/polarsource/polar) — especially
  `server/polar/event/` and `server/polar/models/customer_meter.py`.
- [How Metronome Works](https://docs.metronome.com/guides/get-started/how-metronome-works).
