# Billing Primitives Industry Survey: Wallets vs. Subscription Allowances vs. Grants

**Author:** research commissioned for Unprice architectural decision
**Date:** 2026-04-20
**Status:** Informational — feeds the "is grants the unifying primitive?" decision

## 0. Framing

Unprice operates two usage modes that share one event pipeline but disagree on *when* money moves:

- **Wallet mode** — real money parked in a pgledger account (`customer.{id}.available` → `reserved` → `consumed`). Agents/API-key consumers draw it down in real time via a Durable Object that pulls chunks from `available` into `reserved`, consumes locally, and periodically flushes `reserved → consumed`. Running out = stop calling.
- **Subscription mode** — plan fee is invoiced and settled upfront; the plan includes allowances (e.g. 1M tokens/month). Usage is "free" until the allowance is exhausted. Overage is invoiced at period end or cut off.

The architectural question: is **"grants" — time-bounded credit buckets with `amount`, `expires_at`, `priority`, `source`** — the unifying primitive? If so, a subscription period becomes a grant `(source=subscription, expires_at=period_end)` and a wallet top-up becomes a grant `(source=wallet, expires_at=never)`. The same reservation machinery serves both.

This report surveys how Stripe, Orb, Metronome, Lago, OpenMeter, Flexprice, and Polar each model these objects, then synthesizes the industry pattern.

---

## 1. Per-Company Summaries

### 1.1 Stripe Billing

1. **Balance model.** Stripe keeps an **immutable append-only ledger**: "Every transaction with credits is recorded in an immutable ledger, accessible through the credit balance transactions API." A `CreditGrant` object represents a prepaid or promotional allocation; aggregate spendable credit is exposed through the `CreditBalanceSummary` resource, which returns an `available_balance` and a separate `ledger_balance` (ledger balance may include future-dated reinstatement; available is the usable number at invoice finalization).

2. **Wallet vs subscription.** Stripe's two concepts are orthogonal primitives that *both* converge at invoice time. There is no explicit "wallet" object in Stripe Billing — a prepaid balance is a *credit grant* that sits above the subscription. Subscriptions remain their own first-class object with `subscription_items` and metered `prices`. At invoice finalization, credit grants are applied to the adjusted subtotal of invoice lines backed by metered prices: *"Credit grants apply to invoices after discounts, but before taxes and the invoice_credit_balance."* Subscription fees themselves are not redeemed from the credit grant — they are billed as their own invoice line.

3. **Grant primitive.** Yes. `CreditGrant` has: `amount` (monetary, `currency` + `value` in smallest unit), `category` (`paid` vs `promotional`), `expires_at`, `priority` (0 = highest, 100 = lowest, default 50), and `applicability_config.scope` (since 2025-02-24, grants can target specific prices or a `price_type: metered`). FIFO by expiry is the *secondary* key: "Credit grants with earlier `expires_at` timestamps apply first."

4. **Real-time authorization.** **No.** Meter events are aggregated asynchronously; the meter event summaries "provide an eventually consistent view of the reported usage." The Meter Usage Analytics API "truncates event timestamps to the nearest 15 minutes." Stripe provides no `can I consume X?` endpoint — credits are reconciled at invoice time, not at call time. There is no reservation/hold pattern for usage.

5. **Entitlement activation.** Credit grants become active on their `effective_at` (immediate by default). Subscription phases and their implicit "allowance" (the metered price, which has no grant unless one is explicitly created) are eager — the subscription model is the source of truth at invoice generation.

6. **Overage handling.** Implicitly soft: once credits are depleted, the metered price itself bills through normally. Spend caps exist as `billing_threshold` on subscriptions but are coarse. Cut-off is something you implement outside Stripe.

7. **Subscription + usage combination.** Separate line items on one invoice. A flat subscription line item prices the plan fee; metered line items price usage. Credit grants are applied to metered lines, not the plan fee.

8. **Code / schema.** N/A (closed source).

### 1.2 Orb (withorb.com)

1. **Balance model.** A **ledger of credit blocks**. "Structurally, the credit balance consists of blocks, which are initialized with an amount and expiry_date. At any given time, the total credit balance for a customer is the sum of the remaining amount in their unexpired credit blocks." The ledger is append-only: `IncrementLedgerEntry`, `DecrementLedgerEntry`, `ExpirationChangeLedgerEntry`, `CreditBlockExpiryLedgerEntry`, `VoidLedgerEntry`, `VoidInitiatedLedgerEntry`, `AmendmentLedgerEntry`.

2. **Wallet vs subscription.** Orb is unusual in that **a plan can contain a `credit_allocation`** — an auto-recurring grant of credits at each billing period. From Orb docs: *"Customers can receive an allocation of credits automatically as part of their subscription, which can be configured in the create plan flow and overridden on a per-subscription basis, with an amount, optional rollover behavior, and cadence."* So subscription-derived allowances materialize as *credit blocks into the same ledger* as customer-purchased prepaid credits. Wallet ≈ subscription allowance at the storage layer.

3. **Grant primitive.** Yes — `credit_block` is the grant. Fields: amount, effective_date, expiry_date, cost_basis (0 for promotional, non-zero for paid), per_unit_cost, custom_pricing_unit (multi-ledger support — separate ledgers for compute vs. storage). No explicit numeric priority; consumption order is deterministic: **"first those with item filters, then soonest-expiring blocks, then blocks with zero or no cost basis before higher cost basis blocks, and finally based on earliest creation time."** Rolling vs non-rolling is a per-allocation setting.

4. **Real-time authorization.** **Yes — in a soft way.** "Orb supports real-time ingestion of usage data" and "the customer commitment is automatically burned down in real-time." There is a 12-hour grace period for late-arriving/backdated events. The ledger is replayable: Orb re-applies events at the logical timestamp so late events can still be correctly attributed to the right block. There is no formal "reservation" primitive — it's a real-time debit ledger, not a hold-and-commit ledger.

5. **Entitlement activation.** Eager. A subscription generates credit blocks at the start of each period (rolling forward if configured). Orb does *not* wait for first usage — the grant is materialized on the billing cycle boundary via the subscription engine.

6. **Overage handling.** **Prepaid credits only apply to in-arrears charges; not to in-advance fixed fees.** Once credits hit zero, remaining usage rates on the normal per-unit price. Auto-top-up is a native workflow. Cut-off is not Orb's default — it's a customer concern.

7. **Subscription + usage combination.** One invoice, mixed lines. A "cost basis" on an allocation produces an in-advance fixed line; usage burns blocks first, then falls through to per-unit pricing for additional lines.

8. **Code / schema.** Closed source. Ledger entry types and block semantics documented in their API reference.

### 1.3 Metronome

1. **Balance model.** **Ledgered commits and credits** attached to contracts. Each credit/commit has "an access_schedule that defines spend allotments associated with one or many date ranges." Ledger entries have a type, amount (signed), and effective timestamp. Balance = non-negative sum of ledger entries for active segments.

2. **Wallet vs subscription.** **Same primitive, different lifecycles.** Prepaid commits (money in, draws down in real time) and recurring grants (free credits issued per period) are both *ledgered balances attached to a contract*. Subscription fees are modeled as `subscription` products — a recurring fee on a schedule — which is distinct from commits/credits but shares the contract envelope.

3. **Grant primitive.** Yes. From `Metronome-Industries/metronome-node/src/resources/shared.ts`:
   ```ts
   // Commit
   priority?: number    // "If multiple credits or commits are applicable,
                        //  the one with the lower priority will apply first."
   applicable_product_ids?: Array<string>
   applicable_product_tags?: Array<string>
   applicable_contract_ids?: Array<string>
   // access_schedule defines spend allotments per date range
   ```
   Ledger entry types include `PREPAID_COMMIT_EXPIRATION`, `POSTPAID_COMMIT_EXPIRATION`, segment-start entries, etc. Rollover is contract-specific; most commits don't roll over.

4. **Real-time authorization.** **Yes, near real-time.** The pipeline is Kafka Streams on Confluent: "processing over 10,000 invoices per second and streaming billions of events per day with no lost data and extremely low end-to-end latency." The `remaining balance` endpoint is continuously updated. Still no discrete reservation primitive — you read the current balance; if you want a hold, you implement it outside Metronome.

5. **Entitlement activation.** Eager. Commits/credits are scheduled at contract provisioning; segments materialize on their access_schedule timestamps. Recurring credits issue a "unique ledger attached to it at the start of each period."

6. **Overage handling.** Postpaid commits true-up at period end (final true-up invoice for the difference). Prepaid commits expire at period end ("prepaid commit true-ups"). Rollover is allowed only by explicit contract term. Spend caps / alerts are separate features.

7. **Subscription + usage combination.** Contracts bundle: subscription products (recurring fixed), billable metrics (usage), commits/credits (prepay). All reconcile to the contract's invoices.

8. **Code / schema.** Public TypeScript and Go SDKs expose the type surface; server code is closed.

### 1.4 Lago (open source)

1. **Balance model.** **Mutable aggregate columns + append-only transactions.** `Wallet.balance_cents`, `consumed_amount_cents`, `ongoing_balance_cents` are updated in place; the audit trail is `WalletTransaction` rows with `transaction_type` (inbound/outbound), `status` (pending/settled/failed), `source` (manual/interval/threshold), and `transaction_status` (purchased/granted/voided/invoiced).

2. **Wallet vs subscription.** **Separate primitives.** The `Wallet` is a customer-scoped prepaid balance; `Subscription` is its own object tied to a `Plan`. Subscriptions with BM charges produce `Fee` rows on invoices; wallets are consumed *to pay* those invoices (via `ApplyPaidCreditsService` flow). Allowances within a plan are modeled as *free units* on the `Charge`, not as credits on the wallet.

3. **Grant primitive.** **Partial.** Wallets have `priority` (1..50, where 1 is highest), `rate_amount` (credits-to-currency conversion), and `expiration_at`. WalletTransactions have `priority` too. There is a `Credit` model separate from wallets (used for credit notes / coupon application). But there is no single "grant" object that unifies subscription allowances with top-ups — these are two different mechanisms. Plan-level allowances are priced as "free units" inside Charges, not as a grant on a ledger.

4. **Real-time authorization.** **Soft real-time.** The architecture recently moved to real-time burndown (see Lago blog, "Introducing the future of Prepaid Credits: real-time burndown and top-up rules"). `refresh_ongoing_usage_service` and `update_ongoing_service` in `app/services/wallets/balance/` keep `ongoing_balance_cents` fresh. There is no reservation/hold primitive — the balance is polled, not pre-authorized.

5. **Entitlement activation.** Eager. `WalletTransaction` settlement uses `ApplyPaidCreditsService`:
   ```ruby
   ActiveRecord::Base.transaction do
     WalletTransactions::SettleService.new(wallet_transaction:).call
     Wallets::Balance::IncreaseService.new(
       wallet: wallet_transaction.wallet,
       wallet_transaction: wallet_transaction
     ).call
   end
   ```
   Subscription allowances become available at each cycle boundary automatically via plan logic, not first-usage lazy resolution.

6. **Overage handling.** Hard cut-off configurable at wallet level. Subscription charges with free units overage at the per-unit rate from the Charge model. Threshold-triggered auto top-ups (`threshold_top_up_service.rb`) keep wallets replenished.

7. **Subscription + usage combination.** Invoice `Fee` rows distinguish subscription fees, charge fees, one-time fees; wallet transactions *settle* invoices (or get applied during invoice creation). Wallet and subscription are orthogonal; the combination point is the invoice.

8. **Code / schema (quoted).**
   - `app/models/wallet.rb`: `validates :priority, inclusion: {in: 1..LOWEST_PRIORITY}` and `validates :balance_cents, numericality: {greater_than_or_equal_to: 0}, if: :traceable?`
   - `app/models/wallet_transaction.rb`: `TRANSACTION_TYPES = [:inbound, :outbound]`, `STATUSES = [:pending, :settled, :failed]`, `SOURCES = [:manual, :interval, :threshold]`, `TRANSACTION_STATUSES = [:purchased, :granted, :voided, :invoiced]`.
   - Services live in `app/services/wallets/` with sub-folders `balance/` (increase, decrease, refresh_ongoing_usage, update_ongoing) and `recurring_transaction_rules/`.

### 1.5 OpenMeter (open source)

1. **Balance model.** **Snapshot-accelerated event replay.** `BalanceConnector.GetBalanceAt` "tries to minimize execution cost by calculating from the latest valid snapshot, thus the length of the returned history WILL NOT be deterministic." The balance is the outcome of running the engine over grants + meter events + resets, starting from the nearest snapshot.

2. **Wallet vs subscription.** **Unified under entitlements + grants.** OpenMeter's entitlement layer has three types (metered, static, boolean). Metered entitlements own `usage_period` and `issue_after_reset`. Grants attach to metered entitlements. A subscription in OpenMeter creates metered entitlements with grants issued per period; a prepaid top-up is just another grant. There is no separate "wallet" object.

3. **Grant primitive.** Yes. From `openmeter/credit/grant/grant.go`:
   ```go
   type Grant struct {
       models.ManagedModel
       models.NamespacedModel
       ID               string               `json:"id,omitempty"`
       OwnerID          string               `json:"owner"`
       Amount           float64              `json:"amount"`
       Priority         uint8                `json:"priority"`
       EffectiveAt      time.Time            `json:"effectiveAt"`
       Expiration       *ExpirationPeriod    `json:"expiration,omitempty"`
       ExpiresAt        *time.Time           `json:"expiresAt,omitempty"`
       Annotations      models.Annotations   `json:"annotations,omitempty"`
       Metadata         map[string]string    `json:"metadata,omitempty"`
       VoidedAt         *time.Time           `json:"voidedAt,omitempty"`
       ResetMaxRollover float64              `json:"resetMaxRollover"`
       ResetMinRollover float64              `json:"resetMinRollover"`
       Recurrence       *timeutil.Recurrence `json:"recurrence,omitempty"`
   }
   ```
   Burndown order: "priority first, with grants with higher priority being burnt down before grants with lower priority. In case of grants with the same priority, the grant that is closest to its expiration date is burnt down first." Entitlement grants *embed* credit grants: `type CreateEntitlementGrantInputs struct { credit.CreateGrantInput }` — the same underlying primitive.

4. **Real-time authorization.** **Yes.** `hasAccess` is a first-class property on entitlement value; "Current values are always real time." Usage is burned down as events arrive. OpenMeter explicitly warns against hot-path calls to the entitlement value API and recommends notifications-backed local caches. No reservation primitive in OSS — you get a boolean and a balance.

5. **Entitlement activation.** Eager. Metered entitlements are created with a usage period and an optional `IssueAfterReset` that seeds the balance; grants can be created with `Recurrence` so they re-issue on schedule.

6. **Overage handling.** Per-entitlement `IsSoftLimit` bool: soft = allow overage and report, hard = deny. `preserveOverageAtReset` controls whether overage carries into the next period.

7. **Subscription + usage combination.** Subscriptions drive line generation in the billing package ("lifecycle events: creation, modification, and cancellation trigger the adapter to yield corresponding line items"). Usage billing "derives quantities from meter data captured at line creation" and supports line splitting mid-period. Grants integrate through `openmeter/billing/creditgrant/`.

8. **Code / schema.** Quoted above. Relevant files: `openmeter/credit/grant/grant.go`, `openmeter/credit/grant/expiration.go` (`ExpirationPeriod{Count uint32, Duration: HOUR|DAY|WEEK|MONTH|YEAR}`), `openmeter/credit/balance.go`, `openmeter/entitlement/entitlement.go`, `openmeter/entitlement/entitlement_grant.go`, `openmeter/billing/creditgrant/`.

### 1.6 Flexprice (open source, Go + PostgreSQL + ClickHouse)

1. **Balance model.** **Dual storage.** `Wallet.balance` (numeric(20,9)) is the mutable running balance; `WalletTransaction` rows with `credit_balance_before`, `credit_balance_after`, `credits_available`, `expiry_date` form the audit ledger. A separate `CreditGrant` schema defines *templates* for grants; `CreditGrantApplication` rows are the materialized instances per period.

2. **Wallet vs subscription.** **Separate but both modeled.** Wallets are customer-scoped prepaid balances with `wallet_type` (pre-paid default), `currency`, `conversion_rate`. `CreditGrant` carries a `scope` enum (plan-level or subscription-level) plus `plan_id` / `subscription_id` — so subscription allowances ARE represented as grants, but wallets are a distinct object. Top-up purchases create WalletTransactions of type `credit` (inbound) with `transaction_reason` like `purchased_credit` or `free_credit`. Subscription allowances create `CreditGrantApplication` rows that (per service code) feed credits into a wallet.

3. **Grant primitive.** Yes. From `ent/schema/creditgrant.go`:
   ```
   credits              numeric(20,8)      (immutable)
   scope                CreditGrantScope   (PLAN | SUBSCRIPTION)
   plan_id / subscription_id                (nullable, mutually exclusive via index)
   cadence              CreditGrantCadence (one-time | recurring)
   period / period_count                    (e.g. MONTHLY, count=1)
   expiration_type      CreditGrantExpiryType
   expiration_duration / expiration_duration_unit
   priority             int (nullable)
   credit_grant_anchor  time
   conversion_rate, topup_conversion_rate
   ```
   `CreditGrantApplication` adds: `scheduled_for`, `applied_at`, `period_start`, `period_end`, `application_status` (pending/applied/failed), `application_reason`, `retry_count`, `idempotency_key`.

4. **Real-time authorization.** Wallet balance is queryable real-time. There is no reservation primitive in OSS. Temporal is used for orchestration (scheduled grant applications, top-up workflows).

5. **Entitlement activation.** Eager. `CreditGrantApplication.scheduled_for` is populated ahead of time; Temporal workflows apply them at `scheduled_for`. Recurring grants produce one application per period.

6. **Overage handling.** Configurable via entitlement `is_soft_limit` bool and `usage_limit` int64. Wallet `alert_settings` fires thresholds. No native hard cut-off at the billing layer — your application enforces.

7. **Subscription + usage combination.** Invoices unify cycle, proration, metered, subscription fees. CreditGrant applications mutate wallet credits, which are applied during invoice generation.

8. **Code / schema.** Quoted above from `ent/schema/`. Services: `internal/service/wallet.go`, `creditgrant.go`, `creditgrantapplication`, `entitlement.go`, `subscription.go`, `billing.go`.

### 1.7 Polar (open source, FastAPI + SQLAlchemy)

1. **Balance model.** **Event-driven running sum** on `CustomerMeter`. The table has aggregate columns: `consumed_units`, `credited_units`, `balance` (default 0). Balance is computed as `credited_units - consumed_units`, where credited_units is a `non_negative_running_sum(event.user_metadata["units"] for event in credit_events)` filtered by `Event.is_meter_credit.is_(True)`.

2. **Wallet vs subscription.** **Mixed — they use *both* customer meters and account credits.** Polar has `/wallet`, `/account_credit`, and `/held_balance` modules *for platform payouts* (seller side), but for product usage billing the primary object is the `CustomerMeter` (one row per `(customer_id, meter_id)`). Subscription allowances are delivered via a `meter_credit` benefit that fires a credit event into the same meter each billing cycle. So on the consumer/usage side, wallet and subscription-allowance both flow through the same `CustomerMeter`.

3. **Grant primitive.** Yes — `BenefitGrant` plus `is_meter_credit` events. From `models/benefit_grant.py`: `granted_at`, `revoked_at`, `customer_id`, `benefit_id`, `subscription_id` (nullable), `order_id` (nullable), `properties` (jsonb). The `meter_credit` benefit type adds units + meter_id to properties. `BillingEntry` is the line-item primitive with `type` enum (cycle, proration, metered, seats_increase/decrease) and `direction` (debit | credit).

4. **Real-time authorization.** **Polling.** Customer meter balance is queryable. Credit events and usage events share the same `Event` table; credit events are marked with `is_meter_credit=True`. `last_balanced_event_id` tracks watermark for incremental updates. No reservation primitive.

5. **Entitlement activation.** Eager on subscription cycle boundary for the `meter_credit` benefit; the granting logic fires at "the beginning of every subscription cycle period — monthly or yearly" or one-time at purchase.

6. **Overage handling.** Balance goes negative past allowance (`balance = credited_units - consumed_units`, so overage = positive consumed past credited produces negative balance). Metered prices bill the overage at period end. Their docs show: "When you grant 10 credits (balance = -10), and the customer uses 3 units, the balance becomes -7 (7 credits remaining)." (They use negative-as-credit semantics internally.) Rollover is opt-in at the benefit level.

7. **Subscription + usage combination.** `BillingEntry` rows of type `cycle` (subscription fee) and `metered` (usage) share the same order/invoice. The `benefit_grant` lives beside the subscription and issues credit events each cycle.

8. **Code / schema.** `server/polar/models/customer_meter.py`, `benefit_grant.py`, `billing_entry.py`, `meter.py`, `meter_event.py`. Service: `server/polar/customer_meter/service.py` with `update_customer_meter`, `_get_credit_events`, `_get_usage_quantity`, `get_rollover_units`.

---

## 2. Comparison Matrix

| Dimension                     | Stripe    | Orb         | Metronome    | Lago         | OpenMeter       | Flexprice    | Polar             |
|-------------------------------|-----------|-------------|--------------|--------------|-----------------|--------------|-------------------|
| Grant primitive               | Yes (`CreditGrant`) | Yes (`credit_block`) | Yes (credit + commit, ledgered segments) | Partial (Wallet + WalletTransaction) | Yes (`Grant`, unified with entitlement) | Yes (`CreditGrant` + `CreditGrantApplication`) | Yes (`BenefitGrant` + credit events) |
| Real-time authorization       | No (async, eventually consistent) | Soft (real-time burndown, 12h grace) | Yes (Kafka Streams, low latency) | Soft (ongoing_balance refresh) | Yes (`hasAccess` + balance real-time) | Balance polling real-time | Balance polling real-time |
| Wallet ≡ subscription allowance? | No (grants vs subscription items) | Yes (same ledger, block source differs) | Yes (ledgered commits of either origin) | No (Wallet vs free-units-in-Charge) | Yes (grants on entitlement) | Partial (grant→wallet pipeline) | Yes on customer side (meter_credit benefit) |
| Overage model                 | Soft (metered price continues) | Soft (per-unit after depletion) + auto-top-up | Postpaid true-up or prepaid expiration | Hard cut-off option + Charge overage | Soft/hard toggle (`IsSoftLimit`) | Soft/hard via `is_soft_limit` | Soft (negative balance; billed at period end) |
| Ledger style                  | Immutable append-only | Append-only ledger + blocks | Append-only ledger per commit/credit segment | Mutable aggregates + append-only transactions | Snapshot-accelerated event replay | Wallet aggregate + ledger | Aggregate columns + event scan with watermark |
| Lazy activation               | No (eager grant, async accounting) | No (eager per period) | No (eager per access_schedule) | No (eager per cycle) | No (eager with `issueAfterReset`) | No (scheduled applications) | No (eager on cycle/purchase) |
| Priority field                | Yes (0-100) | Deterministic order, no numeric priority | Yes (`priority?: number`) | Yes (1-50) | Yes (uint8) | Yes (nullable int) | N/A (meter-scoped, single source) |
| Rollover supported            | N/A (grant lifetime) | Yes per allocation | Rare (contract term) | Configurable | Yes (`ResetMaxRollover`) | Yes (grant period config) | Yes (benefit flag) |
| Reservation/hold primitive    | No | No | No | No | No | No | No |
| Open source?                  | No | No | No | **Yes** | **Yes** | **Yes** | **Yes** |

---

## 3. Synthesis

### 3.1 Is "grants as unifying primitive" the dominant industry pattern?

**Yes, with caveats.** Five of the seven platforms (Stripe, Orb, Metronome, OpenMeter, Polar) represent prepaid balances and subscription allowances as the *same* underlying object — a time-bounded, priority-ordered, source-tagged credit bucket. Flexprice is transitional (grants exist but route through wallets). Lago is the outlier — it keeps wallets and plan allowances as fundamentally different primitives joined only at invoice reconciliation.

The best articulation of the pattern is OpenMeter's code: `CreateEntitlementGrantInputs` literally embeds `credit.CreateGrantInput`. Subscription allowances and top-ups produce the same `Grant` struct; only the `Recurrence` and `Metadata` fields (and in Stripe, the `applicability_config` + `category`) differ. Metronome and Orb push the same idea further: one ledger, multiple sources, all reconciled by priority + expiry.

The shared grant shape across these systems looks like:
```
{ amount, effective_at, expires_at, priority, source_metadata, recurrence?, rollover? }
```

### 3.2 Reservation / hold pattern

**Almost entirely absent from public billing platforms.** None of Stripe, Orb, Metronome, Lago, OpenMeter, Flexprice, or Polar exposes a reservation/earmark/hold primitive as a first-class API. All operate at the granularity of "event arrives → ledger debits." The closest analogues are:

- **Stripe's authorization holds on payment cards** (for payment methods, not usage).
- **Orb's 12-hour grace period** — events can arrive late and get applied to the correct logical timestamp, which is structurally similar to holding a slot in the ledger until reconciled.
- **OpenMeter's cached-notification pattern** — clients are told to cache `hasAccess` locally and receive notifications on threshold crossings, effectively reservation-by-watermark.

Reservations only surface in *AI-agent-specific* prior-art (DEV articles, token billing posts) and are always built *outside* the billing platform — typically a Redis or DurableObject front-layer that debits a local counter and asynchronously reconciles with the authoritative ledger. This is exactly Unprice's pgledger `available → reserved → consumed` pattern. It is not in the commercial billing stack because:

1. Most UBB customers aren't running agentic loops with millisecond budgets.
2. Reservations complicate the ledger (pending entries, TTLs, escheatment).
3. The industry's latency SLA is "minute-scale real-time" (Metronome, OpenMeter) — good enough for dashboards and soft throttles, not good enough for per-call authorization at 10k QPS.

**Unprice's reservation layer is therefore a differentiator, not a table-stakes feature.** It sits naturally *in front of* grants, not replacing them.

### 3.3 Real-time authorization vs end-of-period invoicing

The industry reconciles these through a two-layer model:

- **Hot layer:** a running balance, updated in near-real-time (Orb, Metronome, OpenMeter, Polar, Flexprice). Queries return `hasAccess` / `balance` / `usage`. Source-of-truth is still the event log; the running balance is a derived view. Late events replay deterministically (Orb's grace period, OpenMeter's snapshot-based replay).
- **Cold layer:** invoice generation at period end consumes the finalized ledger, applies grants by priority/expiry, and produces invoice line items. Credits and commits true-up or expire.

Nobody in this list does pre-authorization. Everyone does post-hoc debit against a balance that updates fast enough for UI dashboards. Unprice's reservation/Durable Object pattern is stricter than the industry default and is the right primitive specifically for the agent-API wallet case.

### 3.4 Wallet ≡ subscription — trade-offs

**Unified (Orb, Metronome, OpenMeter, Polar, Stripe, Flexprice-ish):**
- Pro: one ledger, one authorization surface, one priority system.
- Pro: simpler pricing composition — agent top-ups stack under subscription allowances via priority.
- Pro: rollovers, expirations, and overage rules all compose out of the grant shape.
- Con: grant records proliferate (per period per subscription per customer).
- Con: the subscription-allowance grant and the wallet top-up grant look identical in the wire schema but have very different cash semantics — you need a discriminator (`category`, `source`, `cost_basis`) to report revenue correctly.

**Separate (Lago):**
- Pro: simpler semantics for each model in isolation.
- Pro: wallet code doesn't risk being polluted with allowance edge cases.
- Con: combining them for a hybrid plan (agent pays subscription fee, plus top-ups for burst) requires coordination at invoice time. Lago's `ApplyPaidCreditsService` flow is straightforward but doesn't naturally give you "subscription covers first 1M, wallet pays after" — you'd implement that on top.

### 3.5 Lazy vs eager entitlement activation

**The industry is uniformly eager.** Every platform creates the grant at the cycle boundary (or at subscription provisioning for non-recurring grants). Metronome explicitly schedules ledger segments at `access_schedule` timestamps. Flexprice uses Temporal to fire `CreditGrantApplication` at `scheduled_for`. OpenMeter uses `Recurrence` + `IssueAfterReset`. Polar's benefit_grant fires at the cycle boundary.

**Unprice's "lazy activation on first event" is unusual.** The pro is clear — you don't materialize state for dormant customers. The con is less-obvious reconciliation: a customer who *has* a subscription but never uses it still needs period-boundary bookkeeping for the invoice (plan fee settled) even if no grant has been materialized. This is solvable (the invoice is produced from the subscription regardless of usage), but it means the billing layer must treat "grant exists in plan" and "grant materialized in ledger" as distinct states.

### 3.6 Primitives Unprice may be missing

Based on the survey:

- **Priority** on grants — Unprice has wallets + subscription periods as separate paths; there is no numeric priority to say "burn the subscription allowance before the wallet top-up." Every platform with unified grants uses priority.
- **Applicability scope** — Stripe's `applicability_config.scope.price_type` and Metronome's `applicable_product_ids/tags/contract_ids` let a grant be limited to specific features/products. Unprice's `customer.{id}.available` per-feature setup handles this *at the account level*, but a "grant applicable to feature X only" is useful for pricing composition (e.g. "1M free tokens but only on the cheap model").
- **Rollover min/max** — OpenMeter's `ResetMinRollover` / `ResetMaxRollover`, Orb's per-allocation rollover, Polar's opt-in rollover. Unprice will need this if plan allowances are recurring.
- **Recurrence object** — OpenMeter's `Recurrence` and Flexprice's `cadence + period + period_count` are a clean way to express monthly/quarterly/annual regrant without spawning explicit objects ahead of time.
- **Cost basis** on a grant — Orb's concept that a grant can be free (promotional) or paid. This lets a single object serve both wallet (paid) and plan allowance (free). With a cost basis, revenue recognition works uniformly.

Unprice's pgledger pattern covers immutability/auditability, but the *grant as a structured object with expiry/priority/scope/cost_basis* would sit naturally *above* pgledger accounts and inform which account to move between.

---

## 4. Recommendation for Unprice

**Yes, adopt grants as the unifying primitive.** The weight of evidence from 5 of 7 platforms (OpenMeter's code is the cleanest demonstration) supports exactly the architecture hypothesized in the framing: a `Grant` object with `amount`, `expires_at`, `priority`, `source`, `recurrence?`, `cost_basis`, and `applicability_scope`, where:

- `source=wallet, expires_at=null, cost_basis=paid` → top-up
- `source=subscription, expires_at=period_end, cost_basis=free, recurrence=<plan>` → plan allowance
- `source=promo, expires_at=<promo_end>, cost_basis=free` → marketing credits

All three burn down through the same priority-ordered ledger; invoice generation treats paid grants (cost_basis > 0) as already-earned revenue and free grants as pricing discounts.

**Where should the reservation pattern live?** *Below grants, above pgledger.* Specifically:

1. The `Grant` is a logical object: amount, expiry, priority, source, scope.
2. Grants resolve to one or more pgledger accounts (the `available` side).
3. The Durable Object reservation primitive operates on a *view* of "grants active for this customer × feature at time T, ordered by (priority ASC, expires_at ASC)." It pulls a chunk into `reserved` from whichever grant is the current head of the burndown queue. Settlement moves `reserved → consumed` and the DO periodically flushes back.
4. When the head grant is exhausted, the DO transparently switches to the next grant (e.g. from plan allowance to wallet top-up). The *consumer* (the agent) never sees the switch.

This collapses the wallet-mode reservation machinery into a general "next available grant" abstraction. It also solves a real composition problem: a customer on the Pro plan (1M tokens included) who also tops up $50 as an overflow buffer gets the plan allowance burned first (priority 10, expires at period end), then the wallet top-up (priority 50, never expires). One Durable Object. One reservation flow.

**On lazy activation:** keep it. It is unusual industry-wise, but it is the correct performance optimization for a system that must handle agentic workloads across many dormant customers. The critical invariant is: the grant definition (on the plan) must be independent of the grant materialization (in the ledger). Invoice generation reads from the plan; the DO bootstraps from the plan on first event. Industry systems eagerly materialize because their customers are humans with slow, predictable use; Unprice's customers are agents with bursty, unpredictable use. Different constraint, different answer.

**Three concrete recommendations:**

1. Define a `Grant` table with the fields listed above. Make `source` a typed enum: `{wallet_topup, subscription_period, promotional, manual_override}`. Make `applicability_scope` a JSONB with feature_ids + product_tags — you'll want it even if you don't use it day one.
2. Keep pgledger as the lower-level immutable ledger but treat grants as the consumer-facing primitive. The DO reserves against the *active grant for this customer × feature*, not directly against `customer.{id}.available`. Write an idempotent "materialize grant" function that creates the pgledger accounts on demand at first-event resolution.
3. Borrow OpenMeter's burndown ordering verbatim: priority first, then expiry. It is the cleanest rule and matches how every tier-1 system thinks about it.

---

## Sources

- [Stripe Billing credits docs](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits)
- [Stripe blog: Introducing credits for usage-based billing](https://stripe.com/blog/introducing-credits-for-usage-based-billing)
- [Stripe Credit Grant API](https://docs.stripe.com/api/billing/credit-grant)
- [Stripe Credit Grant object](https://docs.stripe.com/api/billing/credit-grant/object)
- [Stripe Credit Balance Summary object](https://docs.stripe.com/api/billing/credit-balance-summary/object)
- [Stripe changelog: credit grants price-level applicability (2025-02-24)](https://docs.stripe.com/changelog/acacia/2025-02-24/billing-credits-price-level-applicability)
- [Stripe Meter Events v2 API](https://docs.stripe.com/api/v2/billing/meter-event/create)
- [Orb: Configure prepaid credits](https://docs.withorb.com/product-catalog/prepurchase)
- [Orb: Invoice calculations](https://docs.withorb.com/invoicing/invoice-calculations)
- [Orb blog: Building it yourself — How to implement prepaid credits](https://www.withorb.com/blog/building-it-yourself-how-to-implement-prepaid-credits)
- [Orb blog: OpenAI's credits model in <100 lines](https://www.withorb.com/blog/openai-credits-model-in-100-lines-of-code)
- [Orb: Backfill and amend events](https://docs.withorb.com/events-and-metrics/reporting-errors)
- [Metronome: Apply credits and commits to contracts](https://docs.metronome.com/pricing-packaging/apply-credits-commits/)
- [Metronome: Track the remaining balance](https://docs.metronome.com/pricing-packaging/apply-credits-commits/remaining-balance/)
- [Metronome: Launch enterprise commit model](https://docs.metronome.com/launch-guides/enterprise-commit/)
- [Metronome: Launch prepaid credits business model](https://docs.metronome.com/launch-guides/prepaid-credits/)
- [Metronome Node SDK shared types](https://github.com/Metronome-Industries/metronome-node/blob/main/src/resources/shared.ts)
- [Metronome + Confluent case study](https://www.confluent.io/customers/metronome/)
- [Lago GitHub](https://github.com/getlago/lago)
- [Lago API GitHub](https://github.com/getlago/lago-api)
- [Lago wiki: What I Wish Someone Told Me About Prepaid Credits](https://github.com/getlago/lago/wiki/What-I-Wish-Someone-Told-Me-About-Prepaid-Credits)
- [Lago: Prepaid Credits blog](https://www.getlago.com/blog/prepaid-credits)
- [OpenMeter GitHub](https://github.com/openmeterio/openmeter)
- [OpenMeter Grant source (grant.go)](https://github.com/openmeterio/openmeter/blob/main/openmeter/credit/grant/grant.go)
- [OpenMeter ExpirationPeriod source](https://github.com/openmeterio/openmeter/blob/main/openmeter/credit/grant/expiration.go)
- [OpenMeter Entitlement source](https://github.com/openmeterio/openmeter/blob/main/openmeter/entitlement/entitlement.go)
- [OpenMeter Entitlement Grant source](https://github.com/openmeterio/openmeter/blob/main/openmeter/entitlement/entitlement_grant.go)
- [OpenMeter docs: Entitlement](https://openmeter.io/docs/billing/entitlements/entitlement)
- [OpenMeter docs: Grant](https://openmeter.io/docs/billing/entitlements/grant)
- [OpenMeter blog: Balances, Grants and Rollovers](https://openmeter.io/blog/launchweek-2-02-balances-grants-and-rollovers)
- [Flexprice GitHub](https://github.com/flexprice/flexprice)
- [Flexprice CreditGrant schema](https://github.com/flexprice/flexprice/blob/main/ent/schema/creditgrant.go)
- [Flexprice Wallet schema](https://github.com/flexprice/flexprice/blob/main/ent/schema/wallet.go)
- [Flexprice WalletTransaction schema](https://github.com/flexprice/flexprice/blob/main/ent/schema/wallettransaction.go)
- [Flexprice CreditGrantApplication schema](https://github.com/flexprice/flexprice/blob/main/ent/schema/creditgrantapplication.go)
- [Flexprice Entitlement schema](https://github.com/flexprice/flexprice/blob/main/ent/schema/entitlement.go)
- [Polar GitHub](https://github.com/polarsource/polar)
- [Polar docs: Credits](https://docs.polar.sh/features/usage-based-billing/credits)
- [Polar docs: Grant Meter Credits After Purchase](https://polar.sh/docs/guides/grant-meter-credits-after-purchase)
- [Polar CustomerMeter model](https://github.com/polarsource/polar/blob/main/server/polar/models/customer_meter.py)
- [Polar BenefitGrant model](https://github.com/polarsource/polar/blob/main/server/polar/models/benefit_grant.py)
- [Polar BillingEntry model](https://github.com/polarsource/polar/blob/main/server/polar/models/billing_entry.py)
- [Polar customer_meter service](https://github.com/polarsource/polar/blob/main/server/polar/customer_meter/service.py)
- [Medium: Metronome's Real-Time Billing Pipeline](https://medium.com/@mojtaba.banaie/metronomes-real-time-billing-pipeline-scaling-big-data-for-instant-invoicing-26875015a6f3)
- [DEV article: Token billing system for AI agent](https://dev.to/tejakummarikuntla/i-built-a-token-billing-system-for-my-ai-agent-heres-how-it-works-dl2)
- [Financial Engineer: Trade-Off Engineering of Credit Systems](https://thefinancialengineer.substack.com/p/trade-off-engineering-of-credit-systems)
