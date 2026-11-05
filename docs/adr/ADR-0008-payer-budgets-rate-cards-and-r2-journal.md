# ADR-0008. Payer budgets, rate cards, and the R2 journal

## Status

Accepted. Implemented on 2026-11-04 (units U1-U16 of the payer budget runtime plan).

## Date

2026-11-03.

## Context

On 2026-11-03, usage on `main` (`3a8e3cab7`) runs through three Durable Objects. `EntitlementWindowDO`
is keyed per customer entitlement, `RunBudgetDO` per run, and `BudgetDO` per budget key. Only the
`/v1/budgets/*` routes call `BudgetDO`. An async event is counted in five stores: entitlement DO
SQLite, the Postgres wallet, two Tinybird datasources, and R2. A plan change creates a new
entitlement id, so a new Durable Object starts its counters at zero.

A price lives in `plan_versions_features.config` with the allowance (as a $0 tier), the limit, the
meter, and the reset. Changing the price of one model takes a new plan version, a publish, and one
change-plan per subscription. No record holds cost beside price, so margin cannot be computed.

ADR-0005 (rate cards) and ADR-0006 (the budget primitive) describe most of the target. This ADR makes
the decisions those two left open and the ones that changed on 2026-11-03.

## Decision

### D1. One budget per payer is the runtime

Every Unprice customer has one budget at key `unprice:customer:<customerId>` in `BudgetDO`. It
holds:

- one amount measure in the subscription's unit (money or credits);
- one quantity measure per metered feature;
- the limits on those measures, with their windows;
- the pricing positions, the billing statements, and the funding state.

A plan change rewrites the budget's configuration. It never moves usage to another object.
`EntitlementWindowDO`, `RunBudgetDO`, `budget_runs`, and the `/v1/runs/*` routes are deleted. A run
cap is a standalone budget key with `closesAt`, as ADR-0006 already allows.

Keys that start with `unprice:` are written by Unprice. A public upsert, or an `ifMissing` that
would create one, returns 403, so no caller can define a payer budget before billing compiles it.
A budget with pricing takes events only: an amount, a usage vector, or a lease is refused with
`EVENT_REQUIRED`, because nothing would bill it. The public API reaches a payer budget through the
usage routes (D6) and the access routes, which read it; none of them creates one. An upsert keeps a budget's pricing unless the caller sets it, and
only billing's compile sets it. Pricing changes only while no hold or lease is open: an open hold
settles under the pricing that estimated it. A request path (sign-up, change-plan, cancel, wallet
activation) syncs once and leaves a change refused with `RESERVATIONS_OPEN` to the next sync; a
billing job (renewal, period generation) retries it for up to the max hold TTL, since a hold lives
at most its TTL.

The unit is immutable except to billing's compile: an upsert that sets pricing may move the budget
to another unit (another currency, or credits instead of money) while no hold or lease is open, and
is refused with `RESERVATIONS_OPEN` otherwise. Every other caller gets `UNIT_IMMUTABLE`. On a unit
change, each window's amount counter restarts at zero, because it counted the old unit, and each
quantity counter carries over. Statements keep their own amounts: each belongs to one period, and a
period's usage was priced in the unit in force when it landed.

### D2. A rate card owns every price; a plan version owns the package

| Layer | Owns | Unit of change |
| --- | --- | --- |
| Meter | event slug, feature, quantity properties, dimensions | the feature definition |
| Cost catalog (`model_costs`) | provider cost per model and component | an imported or manual row |
| Rate card | price rows, cost components, margin policy | an effective-dated row |
| Plan version | features, included quantities, limits, windows, cadence, one card per currency | a plan version |
| Subscription | an optional overlay card, limit overrides, funding | the subscription |

- A price row is immutable. A price change closes the row (`effectiveTo`) and inserts a successor.
- A card is live once a plan version that has been published (`published_at` set, whatever its
  status later) prices with it, or once a subscription overlay binds it. On a live card every row
  published, and every row end, takes effect at least 10 minutes after publish. A budget refreshes
  its card at least every 5 minutes, so no budget prices with a stale card. A card no published
  version prices with has no budget reading it, so its rows may start at once: that is how a draft
  version is priced from its editor. A publish may end other rows where its rows start, so a
  regrouped meter's rows follow the old ones without a gap. Publishing a version locks its cards,
  so a row write and a publish serialize. (Amended 2026-11-05.)
- A plan version owns its card: pricing a feature in the version's editor creates the version's
  own card in its currency when it has none, named `<plan slug> <version id> <currency>`, and
  duplicating a version forks the card (its policy and the rows in effect now; scheduled
  successors are not copied). A version may instead be assigned a shared card; its prices are then
  edited on the card, never from the editor. (Amended 2026-11-05.)
- The dimensions a row may match on are the plan feature's meter `groupBy`, read from the plan
  version's snapshot; a card is validated against the plan features of every version assigned to
  it, and against the project's feature definitions only while unassigned. Publishing a version
  validates its card's rows the same way the budget does. (Amended 2026-11-05.)
- An overlay card's rows win over the base card's rows of the same specificity.
- A plan version stores no price and no currency inside a feature.

### D3. Margin is a card policy; every row carries its cost

- A row carries `price` and an optional `cost` (USD components). Rating computes both in one pass, so
  each consumption line records amount, cost, and `rateRowId`.
- A card's margin policy is `manual` or `costPlus` with one `{ featureSlug, markup, roundTo,
  dimension, componentMap }` per feature it prices from the catalog, so one version's card can
  price several model-dimensioned features. Setting a feature's catalog pricing from the version's
  editor imports the bundled models.dev catalog (effective at the catalog's version date), writes
  the policy, and answers a draft revision with the price diff. Publishing it is explicit. Catalog
  pricing is USD only. Models with context tiers are priced at their base tier and flagged in the
  draft; tier pricing is a follow-up. (Amended 2026-11-05.)
- Rating never reads `model_costs`.

### D4. Usage is priced once, at ingestion

- The budget prices usage when it accepts it, in the same SQLite transaction as the consumption.
- A line's amount is `round(price(after)) - round(price(before))` on the cumulative quantity of its
  position `(statement period, feature, match key, property)`. A large event costs exactly what the
  same usage split into small events costs.
- Statements sum accepted amounts. Billing invoices the sealed statement and never re-prices usage.
- Recurring fees (flat, seats, packages bought up front) have no ingestion. Billing prices them from
  the card at period close with the purchased quantity.
- Usage of a priced feature that matches no row is rejected with `NOT_PRICED`. It is never priced at
  zero.
- A hold reserves the most its event can cost from any position, and moves no position. A settle or
  an expiry prices the actual where the positions stand then. So concurrent holds never share an
  allowance or a cheap tier, a settle within the estimate's quantities never exceeds the hold, and
  statements still telescope to the price of their total. Near a hard limit, holds on tiered or
  `included` features reserve more than they usually cost.

### D5. Allowances live on the package

- A plan feature may declare `included` units per statement period. Rating charges
  `price(max(0, total - included))`. Included units from several grants are summed, so their order
  never changes the price.
- `included` and graduated or package prices require a feature without dimensions and with one
  quantity. Features with dimensions (models) use unit prices. An allowance across models is a money
  or credit grant.
- Volume (all-units) tiers are removed from the product.

### D6. One ingestion lane

- `/v1/usage/record` and `/v1/usage/consume` call the payer budget directly. The raw ingestion
  queue, the reporting queue, their consumers, and their dead-letter queues are deleted.
- `record` accepts usage up to 24 hours old.
- Usage counts in the statement period that contains `occurredAt`. If that period is sealed, it
  counts in the earliest open period and the journal marks it `late`. If no period is open, it is
  rejected with `PERIOD_CLOSED`.
- `record` takes 1 to 100 events and answers one result per event in request order; a refused
  event carries the HTTP error a single call would return, and the others still count. `consume`
  is a `charge`: it admits one event only if it fits, and a denial (`LIMIT_EXCEEDED`,
  `WALLET_EMPTY`) is a 402. Each event names its customer and goes to
  `unprice:customer:<customerId>`; a customer without a payer budget gets `BUDGET_NOT_FOUND` (404).
- `/v1/access/check` and `/v1/access/entitlements/current` read the payer budget for metered
  features. The budget holds metered features only, so a flat, seat, or package feature answers
  from the customer's entitlement rows.
- A late record is priced with the card and pricing the budget holds when it arrives: after a plan
  change, that is the new phase's card, even for usage that falls in the old phase's statement. The
  budget keeps one pricing, not one per phase, so pricing a late record with its own phase's card
  would need per-statement pricing and a card cache per phase. Until then this is a known
  limitation; it reaches only usage recorded late across a plan change, within the 24-hour window.

### D7. The journal is the budget's operation rows, exported to R2

- Each accepted operation row gets a per-budget `seq`. The alarm sends rows after the export cursor
  to a Pipelines stream that writes an R2 Iceberg table. A row is purged only after it is exported.
- The API worker sends rejected events to the same stream, best effort after the response: `seq`
  0 (the budget never wrote them), operation id `r:<idempotency key>`, status `rejected`, and the
  event with its rejection in `data`. Readers keep them apart from operation rows by status.
- Dashboards read history from R2 with Basin SQL. Live balances and current-period usage read the
  budget.
- Readers deduplicate on `(budget key, seq)`, because export is at least once. Every write of a
  row takes a new `seq`, and the alarm sends only the latest write of each row since the last
  export, so a reader keeps an operation's highest `seq`. A budget's first `seq` is its first
  write's clock times 1,000, so a key deleted and created again never reuses one.
- Without a `PIPELINE_BUDGET_JOURNAL` binding, outside local development, rows wait unpurged until
  one is bound.

### D8. Tinybird is deleted

Every Tinybird datasource, pipe, endpoint, client, CI job, and secret is removed. Web analytics
(page hits, plan clicks, sign-ups) moves to its own Pipelines stream and is read with Basin SQL.

### D9. Payer budgets use automatic placement

`BudgetDO` keeps automatic placement. `apps/api/src/ingestion/do-placement.ts` is the only place a
budget is addressed, so a jurisdiction or a location hint can be added there later.

### D10. Funding

- Postpaid (uncapped or credit line): no wallet call at runtime. The sealed statement becomes the
  receivable at billing.
- Prepaid or capped: one wallet reservation per payer and statement cycle, with the intent, `seq`,
  capture, and extend protocol ported from `EntitlementWindowDO`.
- The mode is `pricing.funding` in the budget's internal config: `postpaid` (or absent) or
  `prepaid` with the payer's customer id. Only billing's compile sets it.
- `BudgetDO` has no database access. A prepaid charge or hold that its statement key's allocation
  cannot cover is refused with `FUNDING_REQUIRED` and writes nothing. `executeBudgetCommand` sends
  `fund`, which persists a reserve intent (`seq`, amount, time, period) before any wallet call,
  runs it through the `BudgetWallet` port, sends the result back with `applyFunding`, and retries
  once. Still short, the call fails with `WALLET_EMPTY` (HTTP 402). A crash replays the persisted
  intent with the same `seq`.
- Recorded usage, settles, and expiries never wait for funding. What they consume past the
  allocation stays on the statement as a receivable.
- When a seal leaves a statement key with nothing open, the key's reservation gets a close intent:
  capture each statement's amount up to the allocation, then release the rest. A retried seal
  replays a close that failed. A closed budget keeps its storage while a reservation is open.
- Trial usage is free. Billing registers a trial period's statement as `free`: its usage counts,
  the close never captures it, and the invoice bills it at zero.

## What this changes in earlier decisions

| Decision | Change |
| --- | --- |
| ADR-0005 D1, free units as a $0 tier | `included` on the plan feature (D5) |
| ADR-0005 D2, `rate()` reads usage vectors from one event | cumulative positions with one rounding per position (D4) |
| ADR-0006 B6, parents as cross-object funding | entitlements are measures inside the payer budget (D1) |
| ADR-0006 B7.7, no journal | operation rows are the journal (D7) |
| ADR-0007, one snapshot per entitlement Durable Object | one statement per billing period inside the payer budget |
| 2026-10-20 D7, pricing in the SDK | kept for cost caps; billed usage is priced by the budget (D4) |

## Consequences

- A price change is a row. A plan version changes only when the package changes.
- One store owns current usage, one owns history, and one owns money.
- A hot payer is bounded by one Durable Object until a split moves a feature to a leased child.
- Dashboards see history 3 to 7 minutes late. Live numbers come from the budget.
- No existing usage or billing state is migrated. Unprice has no customers.

## Related decisions

- [ADR-0001](ADR-0001-canonical-backend-architecture-boundaries.md)
- [ADR-0003](ADR-0003-wallet-reservation-grant-lifecycle.md)
- [ADR-0005](../specs/2026-10-14-adr-0005-rate-cards-and-budget-runtime.md)
- [ADR-0006](../specs/2026-10-16-adr-0006-budget-primitive.md)
- [ADR-0007](ADR-0007-authoritative-billing-usage-snapshots.md)
