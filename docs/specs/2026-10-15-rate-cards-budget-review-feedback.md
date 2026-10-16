# Rate cards and budget runtime: independent review handoff

Date: 2026-10-15. Code snapshot: `5ea76c5756c8dee1a4da19d98dbc5c008eadcf12`, with staged design-document changes. This is feedback on the source and proposed design, not an ADR or implementation plan. The existing ADR and problem-space files remain unchanged by this review.

Review these two design documents against the implementation:

- `docs/specs/2026-10-14-adr-0005-rate-cards-and-budget-runtime.md`
- `docs/specs/2026-10-13-budget-primitive-problem-space.md`

The owner wants a simpler, extensible billing platform. Backward compatibility is not required. The AI SDK was intentionally deleted and will be implemented later. Tests are important. Documentation, marketing, and adoption plans are outside this review. This note supersedes the earlier review/video claims where it corrects them; the video is unchanged in this task. This was a source review; no application tests were executed.

The main recommendation is to keep separate rate cards and use one budget engine across many Durable Object instances. Separate run objects can reserve capacity from a common parent. Correctness requires conserved reservations, explicit allocation rules, durable charge records, and idempotent reconciliation. It does not require putting all runs inside one customer object. These recommendations are review proposals, not accepted architecture decisions.

## Corrections to the earlier review and video

The earlier explanation was too broad in several places:

- Current pricing paths already share a price calculator. The disagreement is in how quantities are assigned before calculation, and when that assignment occurs.
- Separate run counters are valid when their capacity comes from the same parent. The earlier recommendation to put all runs inside the customer object was too restrictive and did not account for throughput.
- A hold is not settled spend. Settlement replaces an estimate with actual usage and releases the unused amount. An individual implementation counter can increase monotonically without making the whole budget model monotonic.
- Alarms are useful recovery machinery. Their limitation is that they cannot determine whether an external operation incurred unreported cost.
- A catalog that writes the same rate rows does not create a second rate engine. Start with models.dev and manual overrides. Deferring all catalog work is unnecessary.
- Examples below establish possible disagreements or draft defects. They do not establish that every current invoice is wrong, or that a production loss occurred.

## 1. Plans, rate cards, currency, and events

A plan version describes the package: enabled features, usage limits, included quantities, and billing cadence. A rate card describes prices in one currency. Bindings connect them. Price changes can then create successor rate rows without creating a new package version.

I interpret the ownership question as covering both currency and the card reference. The independent rate card owns its currency and price rows. The plan version references applicable cards. Do not embed copies of price rows in the plan version. The ADR already places currency on `rate_cards.unit` and package properties on plan versions. See `docs/specs/2026-10-14-adr-0005-rate-cards-and-budget-runtime.md:99`.

Current code instead puts currency on plan versions and prices in feature configuration: `internal/db/src/schema/planVersions.ts:81`; `internal/db/src/schema/planVersionFeatures.ts:44`. Customer signup rejects a currency mismatch: `internal/services/src/use-cases/customer/sign-up.ts:343`. Moving price authority does not remove the need for a subscription's selected currency.

Example: `Pro v3` includes search, 100 included searches per month, and a hard limit of 1,000 searches per month. It can offer `pro-usd` and `pro-eur`. The USD card charges $0.10 for each additional search; the EUR card charges €0.09. A subscription selects EUR and resolves the EUR bindings. Its invoice remains in EUR. A USD budget uses USD rates. Missing EUR prices are a configuration error, not permission to use USD numbers as EUR.

Prefer one selected billing currency per subscription and invoice. A plan may offer several currencies. One card can cover all its features. Add per-item card references only for a real contract need; different pinned/follow modes do not require copied cards. Reject overlapping applicable bindings. Make currency selection and any allowed later change explicit. Do not infer FX conversion. These are recommended constraints, not claims about completed implementation.

A follow binding selects prices effective at the event time. A pinned binding selects prices effective at its fixed date. Both reference the same card and retain its price history.

The event can remain ordinary JSON. Its identifier supports deduplication; properties contain context and measurable values. A feature schema or adapter maps those properties to the internal input that the rate function expects:

```json
{
  "idempotencyKey": "request_123",
  "eventSlug": "model_request_completed",
  "customerId": "customer_42",
  "properties": {
    "model": "provider/model-version",
    "input_tokens": 1200,
    "cached_input_tokens": 800,
    "output_tokens": 300,
    "requests": 1
  }
}
```

This uses the current event envelope: `apps/api/src/routes/events/ingestEventsV1.ts:31`. Its optional timestamp is epoch milliseconds. Current meters select `properties[aggregationField]`: `apps/api/src/ingestion/entitlements/meter-helpers.ts:29`. A vector need not introduce a second public event format.

For this example, assume `input_tokens` excludes cached tokens. Map `model` to a price selector and map the four quantities to `input`, `cache_read`, `output`, and `request`. If a provider reports total input including cached input, its adapter must subtract cached input once. Otherwise the same 800 tokens can be charged twice. The JSON envelope is not the problem; stable meaning, validation, and deduplication are. A missing price must differ from an explicit zero price.

## 2. One calculator can still receive different quantities

“Live allocation” means assigning usage to grants when the event is processed. “Billing allocation” means assigning the period's accumulated usage to grants when the billing job runs. Allocation decides which grant receives each unit. Calculation then applies that grant's price rules.

The current event-time allocator drains eligible grants in priority order and assigns excess usage to the first eligible grant. The period-end waterfall drains grants and assigns excess to the last active grant. Both call `calculatePricePerFeature`. At event time, the charge is the difference between the cumulative price before and after usage. At period end, the waterfall prices the assigned period quantities. The same calculator receives different inputs.

Sources: `internal/services/src/entitlements/grant-consumption.ts:73`, `:125`, and `:276`; `internal/db/src/validators/subscriptions/prices.ts:825`, `:856`, and `:890`.

Use this deliberately small example. Assume both grants belong to the same entitlement and are active for the same period. A has higher priority; overage is allowed; there is no flat fee, proration, or prior consumption. Assign the first 5 units to A and the next 10 to B, then decide where excess goes. Both use the same graduated configuration: the first 10 assigned units are free, then each additional unit costs $1. The event-time code uses the entitlement's shared configuration for each grant: `apps/api/src/ingestion/entitlements/pricing.ts:160`. The price threshold and the initial assignment quantities are different inputs. Total usage is 20 units.

| Step | Event-time assignment | Period-end assignment |
|---|---|---|
| Assign the first 5 | A gets 5 | A gets 5 |
| Assign the next 10 | B gets 10 | B gets 10 |
| Assign the remaining 5 | First grant A gets 5 more | Last grant B gets 5 more |
| Final quantities | A = 10, B = 10 | A = 5, B = 15 |
| Apply the same price rules | $0 + $0 = **$0** | $0 + $5 = **$5** |

This static derivation was not executed as a test. The defect is conflicting assignment policy, not two different arithmetic engines. Decide the intended rule and test it. With a clean break, there is no reason to preserve both outputs or require a new engine to match both.

This is not a claim that all current invoices disagree. Wallet-funded items with existing captures skip period-end rerating and use captured amounts. See `internal/services/src/use-cases/billing/bill-period.ts:240`. The proposed “price once” direction extends a pattern that already exists for that path.

## 3. Included units, limits, holds, and settled money

Use four meanings without assuming four new services or public abstractions:

- **Included units:** quantity available without an additional usage charge. A plan includes 100 searches and a promotion adds 20. The customer can use 120 included searches.
- **Usage limit:** a constraint on execution. A customer limit of 1,000 searches and a run limit of 20 both apply. That run cannot use 1,020 searches; it can use at most 20 and also consumes the customer's limit.
- **Money hold:** funds reserved before uncertain work. A $10 hold makes $10 unavailable to competing work, but does not mean the customer has spent $10.
- **Settled money:** the priced amount after usage is known. If the operation costs $6, settle $6 and release the unused $4.

An included allowance and a limit answer different questions. After 120 searches, a $0.10 overage price makes search 121 cost $0.10 if limits permit it. A hard limit of 120 would deny search 121 instead. Apply included quantities once; do not also subtract them from an independently free tier unless the product intentionally grants both.

A common counter/reservation implementation can support these cases. Keep the arithmetic and meaning explicit. Adding allowances, intersecting limits, and reconciling money are different operations even when they share storage. Also, today's `allowanceUnits` does not itself mean free usage: it comes from `item.units ?? item.featureLimit`, while free quantities come from price tiers. Sources: `internal/services/src/subscriptions/service.ts:295`; `internal/db/src/validators/subscriptions/prices.ts:266`.

## 4. Separate runs can reserve from a shared parent

The user's correction is valid. Each run may have its own DO and local state. The parent must reserve capacity before the child can use it. For a $100 parent budget:

| Action | Parent available | Open child holds | Settled | Total |
|---|---:|---:|---:|---:|
| Initial | $100 | $0 | $0 | $100 |
| A reserves $60 | $40 | $60 | $0 | $100 |
| B requests $60: denied | $40 | $60 | $0 | $100 |
| B reserves $40 | $0 | $100 | $0 | $100 |
| A finishes at $35; releases $25 | $25 | $40 | $35 | $100 |
| B finishes at $40 | $25 | $0 | $75 | $100 |

Settled amounts must replace holds, not be added alongside unchanged holds. Until the parent receives A's durable settlement, it can safely retain A's full $60 reservation. Retry then completes the transfer without charging twice. Parent and child reservation units must match: do not add USD to EUR, or token quantities to money.

Current code already has separate run DOs and a shared customer wallet. Run creation reserves the full requested run budget from that wallet. The wallet serializes allocations with a Postgres advisory lock. `parentRunId` is metadata; it is not yet a recursively enforced parent-run hierarchy. The draft's parent DO reservation mechanism is a proposed replacement, not an existing implementation detail.

Sources: `apps/api/src/ingestion/do-placement.ts:118`; `apps/api/src/ingestion/run-budget/processor.ts:75`, `:626`; `internal/services/src/wallet/service.ts:384`, `:419`, `:2027`.

Shared money is not the only shared quantity. If a customer has 100 free units per month and runs A and B each use 70, combined usage is 140 and 40 units are billable. Giving both runs an independent fresh allowance of 100 incorrectly makes all 140 free. The parent can allocate included units or tier ranges, or a shared pricing owner can assign them. Entire runs need not move into that owner. Current run pricing calls the customer entitlement DO: `apps/api/src/ingestion/run-budget/pricing-adapter.ts:15`.

For leased included units, also define what happens when A returns unused units after B has already paid. Does B receive a correction, or does allocation order determine the charge? Reserving from a common parent prevents duplicated capacity, but this pricing rule still needs a decision.

This choice affects throughput. Cloudflare lists a soft limit of 1,000 requests per second for one DO; actual capacity depends on the workload. This is not a measured Unprice benchmark. Reserving larger chunks reduces parent calls but leaves unused funds temporarily unavailable to siblings. Measure contention and choose reservation size from that tradeoff. [Cloudflare DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

Durable child DO allocations are also different from future local SDK leases. A durable child can retain charges across restarts. A process-local lease may lose its unreported usage when the process dies. Do not use that latter failure case to reject durable child objects. Do not release uncertain local usage merely because a lease expired.

## 5. Reconciliation, partial settlement, and alarms

Spend is not simply a monotonically increasing estimate. Authorization creates a hold. Settlement records actual charges and reduces the hold. Corrections can create signed entries. The existing `consumedAmount` increment does not describe the whole wallet lifecycle: `apps/api/src/ingestion/run-budget/processor.ts:859`.

There is a concrete defect in the draft pseudocode. It adds $80 to `reservedOpen` at authorization. A partial $30 settlement increases consumed money but leaves `reservedOpen` at $80. Under a $100 cap, the literal formula then returns $100 − $30 − $80 = −$10 available. The correct state is $30 settled, $50 held, and $20 available. Its later release subtracts only $50, leaving a $30 ghost hold. This is a draft defect, not a demonstrated production defect. See `docs/specs/2026-10-13-budget-primitive-problem-space.md:419` through its release operation at line 439.

Choose one clear partial-settlement contract: amounts are either increments or cumulative totals. Then enforce conservation, idempotency, and final closure. A final $35 settlement against a $60 reservation must consume $35 and release $25 exactly once, regardless of retries.

Alarms can recover work after a crash. They do not tell us what happened at the provider:

- The request was never sent: release the whole hold.
- The provider confirms $0.60 usage against a $1 hold: settle $0.60, release $0.40.
- The provider may have completed work, but its response was lost: retain the disputed amount while reconciling, or apply an explicit loss policy. Time alone does not prove zero cost.

Cloudflare alarms deliver at least once and automatically retry a thrown handler up to six times. Continued recovery after that limit needs an explicit mechanism. Handlers and settlement operations must tolerate duplicates. [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

Current normal close flushes captures before release. However, after capture retries are exhausted, the implementation can mark captures abandoned, release the reservation, and flag reconciliation. Abandoned captures no longer block close. This is an existing availability tradeoff to decide deliberately; the review did not observe a loss incident. Sources: `apps/api/src/ingestion/run-budget/processor.ts:394`, `:524`; `apps/api/src/ingestion/run-budget/run-budget-store.ts:229`; `apps/api/src/ingestion/run-budget/processor.test.ts:443`.

A hard cap also requires a defensible estimate of all supported costs. A token estimate that omits a request or tool fee is not a complete upper bound. Suppose a $100 parent holds $80 for A and $20 for B. If A costs $90, its extra $10 cannot be funded without additional shared capacity. Record unfunded usage separately if needed. Settlement establishes actual cost; it cannot undo executed work. The current settle path already permits unfunded usage: `apps/api/src/ingestion/run-budget/processor.ts:130`, `:247`. A cap on funded charges is not automatically a guarantee about the provider's bill.

## 6. Durable delivery: reuse Cloudflare capabilities where they fit

“Price once” needs a durable charge and durable delivery intent in the same local commit. Otherwise a crash after charge persistence but before enqueue can omit revenue downstream. Retry with the same charge identifier and deduplicate the receiving side. Finalization must confirm delivery through the statement's boundary for every relevant writer. Separate run DOs can have separate sequences; this does not require one global sequence. Analytics should not silently become the authoritative money record.

Cloudflare's stable Lifecycle capability can compose with a plain DO. It owns the single physical alarm and dispatches scheduled work with a recovery wake armed in advance. Existing alarm handling must adapt through its hook; do not install competing handlers. Native RPC paths must start the lifecycle. Its telemetry events are best effort, so they are not a billing delivery channel. [Lifecycle documentation](https://github.com/cloudflare/agents/blob/main/docs/agents/lifecycle.md)

The Queue capability is experimental, although Agent queue methods are stable. A queue item is durable before `push` resolves. After lifecycle start, its synchronous row insertion can share the commit of application SQL writes in the same synchronous block. A stable item ID replaces a pending item; it does not make external effects execute once. Callbacks must be idempotent. Terminal application failures drop an item, and there is no built-in dead-letter queue. Retain undelivered charges so an operator or recovery job can drive delivery again. [Queue documentation](https://github.com/cloudflare/agents/blob/main/docs/agents/queue.md)

This is plausible reuse for charge export. Prove atomic insertion, recovery, retries, and exhaustion against a pinned SDK version before adoption. No Agents SDK installation was found in the inspected local package, lockfile, or source. Use existing charge delivery fields and the queue where sufficient; do not add a second outbox table by habit.

`runFiber` can retain work and checkpoints for recovery. It can help resume a workflow, but cannot infer an unknown provider charge. [Durable execution documentation](https://github.com/cloudflare/agents/blob/main/docs/agents/durable-execution.md)

## 7. Keep the catalog small and the rate engine shared

Use [models.dev](https://models.dev/) and its [JSON catalog](https://models.dev/api.json) as the initial source. Its documented input, output, and cache costs are USD per million tokens. [models.dev README](https://github.com/anomalyco/models.dev/blob/dev/README.md) Store a source timestamp or hash with the imported snapshot. Normalize supported values into the same immutable rate rows used for manual prices. Manual overrides win. Missing or unsupported values are not zero.

Do not initially build a LiteLLM merge, source-conflict engine, or universal alias framework. Add a narrow explicit mapping when an actual provider identifier requires it. The catalog imports data; the same rate function prices usage. That is one engine.

Keep selling price and provider cost distinct. A pinned customer price of $0.04 can stay fixed while estimated provider cost rises from $0.02 to $0.03. The resulting estimated margin is $0.01, not $0.02. Store the applicable cost snapshot on each charge independently of the selling-price binding. A catalog snapshot is not proof of the provider's actual invoice cost. EUR revenue and USD cost cannot be subtracted without an explicit FX policy. These are proposed rules, not implemented claims.

## 8. Tests and decisions that should gate implementation

Use the current tests as evidence of intended behavior, then add tests for the new contract. Do not make agreement with contradictory old paths the acceptance criterion.

| Priority | Behavior to prove | Required result |
|---|---|---|
| P0 | Parallel children reserve from one parent | Total granted capacity cannot exceed the parent; duplicate starts do not reserve twice. |
| P0 | Partial/final settle, release, retry, crash | Available + held + settled is conserved; no ghost holds or duplicate charges. |
| P0 | Actual cost exceeds a child's reservation | Extra funding requires available parent capacity; unfunded usage stays distinct. |
| P0 | Known zero, known cost, unknown cost at expiry | Each follows the selected recovery policy; unknown is not silently zero. |
| P0 | Charge commit/export crash and retry exhaustion | Charge remains recoverable; consumers deduplicate; incomplete invoices cannot finalize. |
| P0 | Shared included units and graduated tiers | Parallel children cannot each receive the full customer allowance or reset its tier. |
| P0 | Canonical grant assignment and event splitting | The two-grant example has one intended result. For supported additive usage, one batch and equivalent split events produce the same charge. Tie-breaking is deterministic. |
| P0 | Currency and rate selection | No implicit FX, cross-currency sums, ambiguous matches, or missing-as-zero prices. |
| P0 | Event identity and invalid properties | Replays do not duplicate charges. A changed payload on the same key fails. Invalid quantities are rejected. |
| P0 | Price changes, period boundaries, late events | Defined event time and binding rules; no unintended tier reset or double inclusion. |
| P0 | Fees, proration, decimals, corrections, catalog changes | Zero-usage recurring fees persist. Proration follows the chosen contract. Small charges retain precision. Overrides survive sync. |
| P1 | Parent contention and chunk size | Measured throughput and stranded funds support the chosen allocation policy. |

Existing tests cover useful parts: concurrency within one run with a mocked wallet (`RunBudgetDO.workers.test.ts:186`), settlement and unfunded usage (`processor.settlement.test.ts:36`), commit failure and alarm repair (`processor.test.ts:199`, `:219`), immutable capture retries (`:283`), unresolved expiry (`:390`), and abandonment (`:443`), all under `apps/api/src/ingestion/run-budget/`. Their existence does not prove cross-run parent conservation or the proposed runtime. No test suite was run for this review.

## Questions for the independent reviewer

1. Does the plan/card/currency boundary remove coupling without adding unnecessary binding complexity?
2. Which explicit allocation rule should replace the current event-time/period-end disagreement?
3. Can one budget engine serve durable parents and children with a small reservation protocol? Which shared tier operations must still serialize?
4. Should exhausted capture retries retain funds, recognize debt, or release them under an accepted loss policy? How is late settlement handled after expiry?
5. Can the selected Lifecycle/Queue version provide atomic charge scheduling and recoverable delivery without another delivery store?
6. Which pricing models are necessary now? Unit and graduated prices are straightforward starting points; volume repricing and non-additive measurements need explicit semantics.

Please give an independent judgment and challenge this review. Verify source references if code is available; do not treat this note as authority or its worked examples as executed tests. Identify incorrect source interpretations, unnecessary abstractions, missing billing invariants, and simpler alternatives. Separate defects in current code from defects in draft pseudocode and unresolved product choices. Recommend the smallest coherent design that supports concurrent runs, multiple offered currencies, reliable invoicing, and later SDK integration. Do not optimize for backward compatibility, and do not assume the earlier video's conclusions are correct.
