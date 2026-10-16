# ADR-0005: Rate Cards, Pricing at Write Time, and the Model Cost Catalog

## Status

Accepted (revised 2026-10-16)

## Date

2026-10-14. Revised 2026-10-16 after an independent review
([feedback](./2026-10-15-rate-cards-budget-review-feedback.md)) and a code check by five agents.
The runtime decision (the original D4) moved to
[ADR-0006: The Budget Primitive](./2026-10-16-adr-0006-budget-primitive.md).

## Context

Unprice has no customers, so these decisions carry no migration or backward-compatibility
constraint. They change where a price is stored, when usage becomes money, and where AI model costs
come from.

### What is wrong today (code read on 2026-10-14 to 2026-10-16, not executed)

1. **A price is part of the plan version.** The price lives in `plan_versions_features.config`
   (`internal/db/src/schema/planVersionFeatures.ts`), and a published version is immutable
   (`internal/services/src/plans/service.ts`). A price change means a new version and a change-plan
   per subscription. `computeConfigHash` includes prices, so every price edit is a new draft.
2. **Usage is priced twice, and the two prices can differ.**
   - At event time, `EntitlementWindowDO` prices each event as
     `price(after) - price(before)` on the counter of the grant that received it
     (`internal/services/src/entitlements/grant-consumption.ts`). Overage goes to the first grant in
     drain order.
   - At period end, `bill-period.ts` skips re-rating only for items with wallet capture lines.
     Every other usage item is re-priced by `rating/service.ts` from Tinybird quantities
     (`v1_get_feature_usage_no_duplicates`) with the waterfall in
     `internal/db/src/validators/subscriptions/prices.ts`, which gives overage to the last grant.
   - The entitlement read (`getEnforcementState`) prices the summed usage on one curve.
   - For 20 units, grants of 5 and 10, and "first 10 free, then $1": $0, $5, and $10. No product
     flow creates overlapping grants yet, so this is latent until add-ons or promotions ship.
3. **Postpaid usage reaches Postgres only as a Tinybird quantity.** For a customer without a wallet,
   the Durable Object prices the event, but the amount only travels in meter facts to Tinybird. If
   Tinybird lags, billing receives no usage and under-bills silently. Nothing seals a period or
   checks that all usage arrived.
4. **The calculator is already shared.** Both paths call `calculatePricePerFeature`. The disagreement
   is in which quantities they feed it (per-grant curves) and when. The original ADR called this
   "four pricing engines"; that was a misdiagnosis.
5. **Event dedup is key-only.** A changed payload under a used key returns 202 and is ignored, and
   dedup is scoped to one entitlement Durable Object.
6. **Currency lives on the plan version and inside every price JSON.** The customer stores
   `defaultCurrency`; ledger accounts are per customer in one currency; there is no FX code.
7. **A meter reads one number.** `meterConfig.aggregationField` is a single property; `filters`,
   `groupBy`, and `windowSize` feed only the meter key.
8. **No model prices.** There is no catalog.
9. **Money math has float steps.** The price parser uses floats, and a comment claims 10^16 is below
   `MAX_SAFE_INTEGER` (it is about 9 × 10^15).

### What the market does

| Approach | Who | Verdict |
| --- | --- | --- |
| Shared rate card of effective-dated, immutable rows | Metronome; Stripe token billing | **Adopted** |
| New plan version or archived price per price edit | Orb, OpenMeter, Stigg, Polar | Rejected: the problem we have |
| Rate card edited in place, no history | Autumn | Rejected: no audit, no scheduled change |
| Price when reading: one engine over stored events at invoice time | Metronome, Orb, Lago, OpenMeter, Stripe meters | Coherent, but enforcement then needs a second, live price |
| Price when writing: price each event once, invoice the ledger | Prepaid credit systems, Autumn balances | **Adopted**: real-time enforcement is the product |
| An unknown model is priced after the tokens are spent | Autumn | Rejected: deny before spend |

## Decision

### D1. A rate card owns the prices; a plan version owns the package

```text
rate_cards
  id, projectId, name
  unit           money:<currency> | credits:<creditId>

rate_card_rows                                        // immutable once written
  id, rateCardId, featureId
  match          { [dimension]: value }               // {} is the default row
  price          unit | graduated | package | flat
  components     [{ property | null, rate, per }]     // see D2; null = per event
  effectiveFrom, effectiveTo?
  source         manual | catalog
  sourceRef      costRowId | user id
```

- A price change closes the current row (sets `effectiveTo` once) and inserts a successor. A future
  `effectiveFrom` is the notice period.
- An exact match beats the default row. Two rows with the same specificity for the same feature and
  time are rejected at write time.
- Usage that matches no row is never priced at zero. It is denied (`NOT_PRICED`).
- A plan version is the package: features, limits, cadence, and **one rate card per offered
  currency**. Signup picks the card for the customer's currency and stores it on the subscription.
  No price, currency, or aggregation is stored on a plan version. `computeConfigHash` excludes the
  card.
- Rows are always resolved at the usage timestamp (for a hold, the authorization timestamp).
  There are no per-item bindings and no follow or pinned modes. Grandfathering, when needed, is an
  additive `asOf` on the subscription's card reference.
- Free quantities stay a $0 first tier on the card. Plan allowances in credits are budget funding
  (ADR-0006 B5, `grant`).
- Upfront quantities (seats, packages bought up front) are priced by the billing cycle from the
  purchased quantity with the same function.

### D2. Price once, at write time; the invoice is a projection of the ledger

- Usage is priced once, when the budget records it (ADR-0006). The price is
  `price(totalAfter) - price(totalBefore)` on **one curve per budget, feature, match, and period**.
  Grants only add capacity and never select a curve, so the number of grants never changes the price
  (the $10 answer above).
- Supported for usage: unit, graduated, and package. **Volume tiers are removed from the product**
  (validators, plan editor, `prices.ts`, the `tierMode` enum, explain-charge), with no backward
  compatibility: a volume delta can be negative, which breaks monotonic consumption and holds
  (ADR-0006 B4). Volume discounts are expressed as graduated tiers. Meters that price usage are `sum` or `count`; `max` and
  `latest` are not priced.
- **No new event format.** The event keeps `eventSlug` and `properties`. A row prices one or more
  components, each reading one property, so a model call is one event, one feature, and one row per
  model:

  ```text
  { feature: "model_call", match: { model: "gpt-4.1" },
    components: [ { property: "input_tokens",  rate: "0.002", per: 1000 },
                  { property: "output_tokens", rate: "0.008", per: 1000 },
                  { property: null,            rate: "1" } ] }
  ```

  Dimensions are exact-match keys declared on the meter (`groupBy`, already in the schema). Overlap
  between properties (input tokens that include cached tokens) is the adapter's job; the server
  never subtracts. This replaces the usage vectors and quantity keys of the original D2.
- Every priced amount carries `rateRowId` (and `costRowId` when the row came from the catalog).
- **Money moves through the budget's funding source**, so every priced amount reaches the ledger:
  a wallet capture for prepaid, an accrual into the customer receivable for postpaid (`creditLine`).
  The invoice is the ledger's usage lines for the period plus recurring fees. Tinybird and R2 are
  projections for dashboards and audits and are never billed from.
- `rate()` uses decimal strings, rounds each line once at scale 8, and rounds to cents only at the
  provider handoff, as today.

Changes to reach pricing at write time, in dependency order:

1. A ledger operation that accrues usage into the customer receivable, idempotent on
   `accrue:{budget}:{period}:{seq}`, with the invoice metadata and no reservation row.
2. The Durable Object adds every priced event to its consumed total, whatever the funding source
   (today `processor.ts` returns early for uncapped customers).
3. The flush and the period-close alarm work without a wallet reservation.
4. A final flush seals the period. Late events are rejected by the billing period's end, not a grant
   bucket's end.
5. Billing builds usage lines from the ledger only.
6. Upfront items are priced from their purchased quantity with `calculatePricePerFeature`.
7. Delete `calculateWaterfallPrice`, the usage branch of `rateBillingPeriod`,
   `getUsageBillingFeatures`, and the `v1_get_feature_usage_no_duplicates` pipe.

### D3. The model catalog is an imported cost table

```text
model_costs      // global, append-only, effective-dated
  id, provider, model, rates { input, output, cache_read, cache_write, reasoning, ... } per 1M,
  currency "USD", effectiveFrom, source "modelsdev" | "manual", sourceRef (snapshot hash)
```

- One source: [models.dev](https://models.dev/api.json) (MIT; costs in USD per million tokens). An
  import job stores a snapshot hash and timestamp. Manual rows override and are never overwritten.
- "Price these models at cost × markup" is an explicit action that writes rate card rows with
  `sourceRef = costRowId`. Prices never change automatically: models.dev auto-merges provider updates
  hourly and contains errors.
- Rating never reads `model_costs`. Cost and price stay separate; margin uses `costRowId`. Margin is
  computed only when the card's currency is USD (no FX).
- Not in the catalog: per-request fees (models.dev has no field), context-size tiers (later, as a
  dimension), batch and priority tiers. These are manual rows.
- Not built: LiteLLM merging, an alias table, per-project cost overrides, automatic apply or review
  policies, OpenRouter data (its terms forbid copying).

### D4. The runtime is the Budget (ADR-0006)

`EntitlementWindowDO` and `RunBudgetDO` are replaced by budgets. See ADR-0006.

## What changed on 2026-10-16, and why

| Original decision | Now | Reason |
| --- | --- | --- |
| Bindings per item, `follow` and `pinned asOf` | One card per subscription, rows at the usage timestamp | No customer needs grandfathering yet; `asOf` is additive later |
| Usage vectors, quantity keys, a new event shape | Multi-component rows over today's event properties | Same pricing power, no second public format |
| "Four pricing engines" | One shared calculator fed per-grant quantities | The calculator was already shared |
| Invoices "sum priced lines" shipped through the reporting queue | Priced amounts move through funding into the ledger | The queue ends in Tinybird, which lags and drops after retries |
| Catalog: models.dev + LiteLLM, aliases, auto/review policy, 6-hour sync | Import + explicit apply | Smaller; automatic price changes are unsafe |
| Volume tiers |  Removed | Negative deltas break holds and monotonic consumption; the entitlement DO clamped them |
| `authorize` locks rate rows with a 24-hour TTL | Price at the authorization timestamp | Rows are immutable and effective-dated; no lock storage |
| Double-read harness against `EntitlementWindowDO` | Invariant and property tests | The old paths disagree with each other; parity is impossible |
| One BudgetDO per subject, runs as child budgets with an unspecified lease | ADR-0006: one funding protocol, parents as funding sources | The lease draft could overspend at expiry and raced across `await` |

Rejected in review: the Cloudflare Agents SDK Queue for charge delivery (not installed,
experimental, drops items after the last retry with no dead-letter queue).

## Order of work

The budget comes first (ADR-0006 steps 0 to 3). Then:

| Step | Change | Done when |
| --- | --- | --- |
| 1 | `rate()` with components and decimal math | Property tests: one event equals the same usage split; grants never change the price; a missing row is an error |
| 2 | Rate cards and plan offers | A price change ships as a row, with no plan version and no change-plan |
| 3 | Pricing at write time (D2 list) | An invoice equals the ledger usage lines plus recurring fees; the Tinybird billing read is deleted |
| 4 | Catalog import | A Claude and a GPT call price from imported rows; an unknown model is denied |

## Consequences

### Positive

- A price change is a row, not a plan version and a migration.
- One price per event, computed once; the live balance and the invoice cannot disagree.
- A credits product prices every feature and model into one balance.
- Billing no longer depends on Tinybird being complete.

### Negative

- Large surface: the plan editor, plan and monetization validators, rating, invoicing, and the
  entitlement Durable Object change.
- Rows resolved at the usage timestamp mean a price change applies to every subscriber on that card
  from its `effectiveFrom`.
- Public catalogs contain errors; the explicit apply step is the mitigation.
- Without the Tinybird fallback, an unavailable Durable Object delays an invoice.

## Guardrails

- Do not put a price, a currency, or a meter aggregation on a plan version.
- Do not edit the price columns of a rate row. Close it and insert a successor.
- Do not compute money outside `rate()`.
- Do not read `model_costs` while rating.
- Do not price unmatched usage at zero.
- Do not add volume (all-units) pricing back. Use graduated tiers.
- Do not re-price usage at period end. Invoice the ledger.
- Do not bill from Tinybird or R2.
- Do not post provider cost to customer ledger accounts.

## Related Documents

- [ADR-0006: The Budget Primitive](./2026-10-16-adr-0006-budget-primitive.md)
- [Independent review, 2026-10-15](./2026-10-15-rate-cards-budget-review-feedback.md)
- [Budget problem space](./2026-10-13-budget-primitive-problem-space.md)
- [ADR-0001: Canonical Backend Architecture Boundaries](../adr/ADR-0001-canonical-backend-architecture-boundaries.md)
- [ADR-0003: Wallet Reservation And Grant Lifecycle](../adr/ADR-0003-wallet-reservation-grant-lifecycle.md)
- [Credit rate card implementation plan](../plans/penging/credit-rate-card-implementation-plan.md) (replaced)
- [Phase 10 compound metering](../plans/unprice-phase-10-compound-metering.md) (cost tables replaced)
