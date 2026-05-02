# Camp B Entitlements Plan

> **Audience:** AI engineering agents implementing entitlement and metering work.
> **Read first:** `CLAUDE.md`, `docs/billing-hardening-plan.md`.
> **Status:** Revised after the customer-entitlement refactor. The old premise was
> "grants publish meter/config snapshots." The current premise is "customer
> entitlements own config; grants are grouped allowance chunks under them."

---

## Verdict

Directionally correct: yes, but only after deleting the old grant-local
routing/config premise.

Camp B should not build a second entitlement identity from grant fields,
`meter_hash`, or period keys. The product object is now the
`customer_entitlement`; it groups grants and is the source of truth for feature
config, meter config, reset cadence, pricing config, overage policy, and
effective window. A grant is not a meter, not a pricing snapshot, and not a DO
route. A grant is an allowance/provenance slice under one entitlement.

The finish line for Camp B is smaller now: enforce one active entitlement per
customer feature, handle cancellation by narrowing the entitlement end date in
Postgres, and cover the grouped-grant behavior with tests. Independent grant
cadence, immediate DO cancellation pings, late-event policy, and audit
hardening remain valid work, but they are not Camp B completion gates.

---

## Load-Bearing Premise

1. **Customer entitlement is the access/config boundary.** Ingestion resolves a
   feature event to one active `customer_entitlement` for
   `(projectId, customerId, featureSlug)` and routes to the DO by
   `env:projectId:customerId:customerEntitlementId`.
2. **Grants are grouped by `customerEntitlementId`.** All grants in the group
   inherit entitlement config. They only contribute allowance, validity,
   priority, type, and provenance.
3. **The entitlement, not the grant, is the source of truth for config.**
   `customer_entitlements.feature_plan_version_id` pins the published PVF
   template. The DO snapshots the entitlement's `featureConfig`, `meterConfig`,
   `resetConfig`, `overageStrategy`, `featureSlug`, `featurePlanVersionId`,
   effective window, project, and customer.
4. **Do not add grant-owned routing/config columns.** No `meter_hash`,
   `meter_config`, `unit_of_measure`, `feature_config`, `currency_code`, or
   `reset_config` on `grants` for Camp B v1.
5. **`period_key` is a fact/reservation bucket, not identity.** The DO may emit
   `period_key` in Tinybird facts and use period boundaries for wallet
   reservation lifecycle, but no caller should route DOs by period.
6. **Published plan versions remain append-only.** The entitlement pins a PVF.
   Config changes mean a new PVF and usually a new customer entitlement window.
7. **One active entitlement per feature is the invariant.** Do not create two
   active usage streams for the same `(projectId, customerId, featureSlug)`.

---

## Directional Check

What is right:

- Long-lived entitlement-window DOs are the right hot-path primitive.
- Loading a customer entitlement with its grants in one query is the right
  ingestion shape.
- Draining grants by priority inside the DO is right.
- Tinybird facts with `customer_entitlement_id` and optional `grant_id`
  attribution are right.
- Subscriptions should keep owning invoice cadence and settlement orchestration.
- The DO should own runtime allowance math, period buckets, pricing, wallet
  reservation checks, idempotency, and fact outbox writes.

What was wrong in the old plan:

- DO key `(customer, feature_slug, meter_hash)` is stale. Use
  `customerEntitlementId`.
- Grant snapshots of `feature_config`, `meter_config`, `reset_config`, and
  currency are stale. These belong to the entitlement/PVF.
- "PVFs publish grants" is imprecise. Subscription activation publishes
  customer entitlements and then default grants under those entitlements.
- `closeGrants` / `closeMeter` is not the primary cancellation primitive. Close
  the entitlement window / wallet reservation by `customerEntitlementId`, and
  expire the entitlement-owned grants.
- "Same meter, different pricing in one DO" is out of scope for this model. A
  single entitlement window has one pricing config.
- "Different grant cadences in one entitlement" is not supported unless we add a
  narrow allowance-only override.

---

## Three Concerns

| Concern | Source of truth | Hot-path copy | Notes |
|---|---|---|---|
| Access and feature identity | `customer_entitlements` + PVF feature | DO `entitlement_config` | One active entitlement per customer feature. |
| Event aggregation | Entitlement's PVF `meter_config` | DO `entitlement_config.meterConfig` | Used to derive the meter key and facts. |
| Pricing / rating | Entitlement's PVF `config` | DO `entitlement_config.featureConfig` | Price each consumed allocation with entitlement config. |
| Reset cadence | Entitlement's PVF `reset_config` | DO `entitlement_config.resetConfig` | Applies to the group unless product approves grant-level allowance cadence. |
| Allowance | `grants` grouped by `customer_entitlement_id` | DO `grants` + `grant_windows` | Grants are allowance chunks and attribution only. |
| Invoice / settlement | Subscription/billing state | Billing jobs / wallet reservation | Do not move invoicing into grant schema. |

Conflating these is the bug factory. The entitlement owns config. Grants own
allowance. The DO owns runtime state.

---

## Big Picture

```
                 Postgres
  customer_entitlements + grants
       entitlement = config owner
       grants      = allowance group
                 |
                 | loadCustomerEntitlementContext()
                 v
        IngestionService
        - resolve event feature slug
        - choose active customer entitlement
        - pass entitlement + grants to DO
                 |
                 | DO key:
                 | env:projectId:customerId:customerEntitlementId
                 v
        EntitlementWindowDO
        - snapshot entitlement_config
        - sync grouped grants
        - aggregate event
        - consume grants by priority
        - price with entitlement.featureConfig
        - check/refill wallet reservation
        - write facts/idempotency/outbox
                 |
                 v
        Tinybird facts + wallet ledger flushes
```

---

## Postgres Model

The current schema shape is directionally right.

```sql
customer_entitlements
  id                         -- customerEntitlementId; DO route
  project_id
  customer_id
  feature_plan_version_id     -- pins PVF config/meter/reset/pricing
  subscription_id
  subscription_phase_id
  subscription_item_id
  effective_at
  expires_at
  allowance_units             -- keep only if this has a defined role
  overage_strategy
  metadata

grants
  id
  project_id
  customer_entitlement_id     -- grouping key
  type                        -- subscription/addon/trial/promotion/manual
  priority
  allowance_units             -- null means unlimited, if allowed
  effective_at
  expires_at
  metadata
```

Do not add `meter_hash` or config snapshot columns to `grants`. If we need a
faster lookup by feature slug later, add `feature_slug` to
`customer_entitlements` as a denormalized/read-model column, not to grants.

### Missing Schema/Service Hardening

**Active entitlement uniqueness is the only Camp B schema/service hardening
gate.** The DB currently prevents duplicate source windows, not duplicate active
feature entitlements. Add a service-level guard at subscription activation,
plan change, and manual entitlement creation that prevents overlapping active
entitlements for the same `(projectId, customerId, featureSlug)`.

If this becomes a frequent query, add a denormalized `feature_slug` column on
`customer_entitlements` and enforce it with an exclusion/index strategy. Do not
add `feature_slug` to grants for this.

For Camp B, the only expected mutation to an existing entitlement is narrowing
`expiresAt` for cancellation or phase end. Everything else remains append-only.
Other cleanup choices, such as removing `customer_entitlements.allowance_units`
or adding grant-level cadence, are explicitly deferred.

---

## DO State

The current DO table split is the right shape:

```sql
entitlement_config
  customer_entitlement_id PRIMARY KEY
  project_id
  customer_id
  effective_at
  expires_at
  feature_config
  feature_plan_version_id
  feature_slug
  meter_config
  overage_strategy
  reset_config
  added_at
  updated_at

grants
  grant_id PRIMARY KEY
  customer_entitlement_id
  allowance_units
  effective_at
  expires_at
  priority
  added_at

grant_windows
  bucket_key PRIMARY KEY
  grant_id
  period_key
  period_start_at
  period_end_at
  consumed_in_current_window
  exhausted_at

meter_state
  meter_key PRIMARY KEY
  usage
  created_at
  updated_at

wallet_reservation
  singleton reservation state for this customer entitlement

idempotency_keys
meter_facts_outbox
```

`entitlement_config` is the DO's local snapshot of config truth. `grants` is
the synced allowance group. `grant_windows` is runtime consumption by grant and
period bucket. `meter_state` is raw aggregation state, not entitlement
availability. `wallet_reservation` is money backing, not access policy.

The existing reservation table still has the legacy column name
`entitlement_id`; the value is `customerEntitlementId`. Do not add a parallel
computed entitlement id.

---

## Apply Path

```typescript
ingestFeature(event):
  context = loadCustomerEntitlementContext(customerId, startAt, endAt)
  entitlement = active entitlement matching event.slug
  stub = getEntitlementWindowStub(projectId, customerId, entitlement.id)
  return stub.apply({ entitlement, grants: entitlement.grants, event })

EntitlementWindowDO.apply(input):
  1. validate route and idempotency
  2. insert entitlement_config on first sight; on later inputs, only narrow
     expiresAt and assert immutable config fields still match
  3. sync grants by grant_id: insert new grant rows and only narrow expires_at
  4. aggregate event with entitlement.meterConfig
  5. resolve active grants from the grouped grant set
  6. compute grant buckets from entitlement resetConfig + grant validity
  7. consume grants by priority
  8. price consumed units with entitlement.featureConfig
  9. check or bootstrap wallet reservation
 10. write grant_windows, meter_state, idempotency, and outbox facts in one tx
```

Ingestion should not compute period keys, total allowance, active grant
availability, pricing, or reservation buckets. That is DO responsibility.

---

## Grant Grouping Semantics

All grants under one customer entitlement are fungible for the entitlement's
feature, meter, pricing, reset cadence, and currency. Priority controls which
grant gets consumed first for attribution and allowance exhaustion.

Current default priority direction remains highest-first:

```text
manual=100, promotion=90, trial=80, addon=50, subscription=10
```

Grant validity windows still matter:

- `effectiveAt` gates when a grant can start contributing allowance.
- `expiresAt` gates when it stops contributing allowance.
- An expiry update may only narrow the window.
- Already-consumed usage is not refunded by expiring a grant. Refunds are a
  separate explicit operation.

### Independent Cadence Decision

The current model gives every grant in the entitlement the entitlement's
`resetConfig`. That is simple and matches "entitlement as config truth."

Camp B defers independent grant cadence. Promotions/manual grants under a
recurring entitlement follow the entitlement cadence until product explicitly
asks for allowance-only per-grant rollover. Do not add `grants.reset_config`,
grant-owned meter config, grant-owned feature config, currency, or routing
identity as part of Camp B.

---

## Plan Change And Cancellation

Plan change is entitlement lifecycle first, grant lifecycle second.

1. Create or activate the new customer entitlement for the new phase/PVF.
2. Create default grants under that entitlement.
3. Expire the old customer entitlement at the phase boundary.
4. Expire grants under the old entitlement at the same boundary.
5. Let ingestion route new events to the active entitlement by feature slug.

This means a same-feature plan change usually creates a new DO because the
customer entitlement id changes. That is acceptable if the product semantics are
"new entitlement window, new pricing/config window." If we need to carry
meter-state/tier counters across a same-meter plan change, that is a separate
migration/carryover feature and must be called out explicitly.

Cancellation is Postgres-driven for Camp B:

1. Mark the subscription cancelled/cancelling according to the subscription
   state machine.
2. Narrow the affected `customer_entitlements.expires_at` to `cancelledAt`.
3. Narrow grants under those entitlements to the same end date if the service
   keeps grant expiry in sync.
4. On the next usage report, ingestion reloads the entitlement with its grouped
   grants and passes the narrowed end date to the DO.
5. The DO syncs only the narrower `entitlement_config.expiresAt` and narrower
   grant `expiresAt` values. It must not mutate any other entitlement config for
   an existing customer entitlement.
6. Usage after the shortened entitlement end date is rejected before any new
   consumption is committed.

This intentionally does not ping the DO immediately. If no usage arrives after
cancellation, an existing wallet reservation may remain held until the DO's
alarm/inactivity/final-flush path reconciles it. That is accepted for Camp B;
immediate reservation release can be reintroduced later as a billing-hardening
ticket, not as an entitlement model requirement.

---

## Tinybird And Invoicing

Tinybird facts should identify the entitlement and optionally the grant:

```text
customer_entitlement_id
grant_id
feature_plan_version_id
feature_slug
period_key
event_slug
aggregation_method
delta
value_after
amount
amount_scale
priced_at
```

Pricing is already done in the DO from the entitlement's feature config. Legacy
invoice jobs should not re-rate usage from the current plan. They should either
sum already-priced facts or, where the existing billing path still queries
usage, read through the pinned `featurePlanVersionId`/period contract.

Subscriptions own invoice cadence. Grants do not.

---

## Edge Cases And Expected Behavior

| Case | Behavior |
|---|---|
| Multiple subscription/addon/manual grants under one entitlement | Same DO. Drain highest priority first. Same entitlement config. |
| Grant added mid-cycle | Next ingestion load/DO sync inserts it. Eligible if effective. |
| Grant expires early | DO narrows local expiry; no refund of already consumed units. |
| Entitlement expires | Ingestion stops routing new events to it. The DO learns a shortened end date on next input; without later input, reservation release waits for alarm/inactivity/final flush. |
| Late event for closed billing period | Follow HARD-015. Do not reopen a closed wallet reservation silently. |
| Same feature plan change | New entitlement window unless product explicitly requires state carryover. |
| Mixed currency | Should be impossible inside one entitlement config. Assert currency from entitlement feature config. |
| No grants | Reject usage entitlement as not provisioned, unless product defines entitlement-level allowance as fallback. |
| DO restart | SQLite state survives; input entitlement + grants can add missing grants and narrow end dates, but must not rewrite entitlement config. |
| Concurrent events | DO single-threading plus SQLite tx protects grant consumption/idempotency. |

---

## Camp B Done Criteria

1. **[x] Uniqueness enforcement:** one active entitlement per customer feature.
2. **[x] Postgres-driven cancellation:** narrowing `customer_entitlements.expiresAt`
   is enough for Camp B; the DO syncs that narrower end date on the next input.
3. **[x] Tests:** grouped grants, entitlement config authority, priority drain,
   no-grants rejection, same-feature entitlement uniqueness, and cancellation
   end-date sync/rejection after cancellation.

---

## Revised Implementation Phases

### Phase 1 - Current Foundation [done]

- `customer_entitlements` introduced as the config/access object.
- `grants` are children of `customer_entitlements`.
- Ingestion loads entitlements with grants.
- DO route uses `customerEntitlementId`.

### Phase 2 - Premise Cleanup [now]

- Remove remaining plan/doc language that treats grants as config snapshots.
- Keep `period_key` out of routing.
- Keep `meter_hash` out of grant schema and reservation routing.
- Treat `entitlement_reservations.entitlement_id` as legacy
  `customerEntitlementId`.

### Phase 3 - Hardening Gaps [done]

- Enforce active entitlement uniqueness.
- Implement Postgres-driven entitlement cancellation end-date narrowing.
- Add tests for grouped grants and entitlement config authority.

### Phase 4 - Lifecycle Correctness [done for Camp B]

- Verify cancellation sync tests: DO accepts the narrower entitlement end date
  on next input and rejects usage after it.
- Keep immediate DO close, late-event policy, and audit hardening out of Camp B.

### Phase 5 - Optional Product Expansion [explicit decision required]

- Independent grant cadence inside one entitlement.
- Same-meter plan-change state carryover.
- Hot entitlement-window sharding.
- Operator UI for manual grants.

---

## Files To Touch Next

```text
internal/services/src/entitlements/service.ts
  enforce active customer entitlement uniqueness by feature slug

internal/services/src/entitlements/grants.ts
  keep grant sync grouped under customerEntitlementId; only narrow expiresAt when cancellation updates grants

internal/db/src/schema/entitlements.ts
  optional denormalized feature_slug on customer_entitlements if uniqueness needs DB support

apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts
  assert route/customerEntitlementId, config refresh behavior, no-grants rejection, grouped drain tests

apps/api/src/ingestion/entitlements/db/schema.ts
  add entitlement allowance only if product decides it is a real fallback authority

internal/services/src/use-cases/subscription/*
  narrow customer entitlement end dates on cancellation; optionally narrow grouped grants

internal/jobs/src/trigger/schedules/*
  no Camp B job required for Postgres-driven cancellation
```

---

## Working Agreement For Agents

- Do not add `meter_hash` routing back.
- Do not add config snapshot columns to `grants`.
- Do not compute period keys or total allowance in ingestion.
- Do not introduce a second pricing model.
- If independent grant cadence is needed, stop and get the product decision
  first.
- Prefer deleting stale grant-as-config code paths over making compatibility
  shims. The codebase is pre-GA.
