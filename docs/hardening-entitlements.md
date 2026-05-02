# Hardening Entitlements

> **Audience:** AI engineering agents picking up the entitlement refactor.
> **Workflow:** Implement one phase at a time. Keep each phase reviewable, run the required validation gate, then ask for human review before starting the next phase.
> **Core direction:** Move from “entitlements are computed groups of grants” to “one active customer entitlement per customer feature, with many append-only grants underneath it.”
> **Style rule:** Optimize for simplicity and readability. Do not repeat schemas or types manually when a Drizzle table, validator, or inferred type already exists.

---

## Load-Bearing Decisions

1. **Customer entitlement is the customer-specific source of access.** It binds `customerId` to one immutable plan version feature for a time window.
2. **Plan version feature remains the source of truth for feature config, meter config, price, unit, and cadence definition.** Do not add grant-level or customer-entitlement-level price overrides in this pass.
3. **The entitlement effective start is the cadence anchor.** Do not store a separate customer entitlement anchor unless a later product requirement proves it is needed.
4. **Grants are allowance chunks.** A grant belongs to one customer entitlement, has an allowance, priority, and active range. It does not own meter identity, price, cadence, subject, or deletion state.
5. **Delete `meter_hash` as a dependency.** Durable Object routing should use `env:project:customer:customerEntitlementId`.
6. **No compatibility shims unless a human explicitly asks for one.** This is a refactor; prefer deleting stale code over preserving parallel paths.

---

## Cross-Phase Instructions

- Use existing Drizzle schemas, Zod validators, and `z.infer`/table inferred types. Avoid redefining DTOs by hand except for external/runtime boundary payloads.
- Keep migrations minimal and readable. If a migration introduces a field only to drop it later in the same branch, fold the migration.
- Keep `EntitlementService` as the entitlement owner. Do not introduce a second long-lived manager class unless a human approves the boundary.
- Keep `GrantsManager` narrow. It should not resolve customer entitlement state, route ingestion, or compute pricing.
- Keep every phase small enough to review. Do not combine phase 1 + phase 2 + phase 3 in one pass.
- Every phase ends with `pnpm validate`. It must pass before requesting human review.

---

## Phase 1 — Customer Entitlement Data Model

**Goal:** Add the minimal customer entitlement model and wire subscription activation to create entitlements, while keeping usage/billing behavior intentionally stubbed for later cleanup.

### Scope

- Database schema and validators.
- Entitlement CRUD methods inside the existing entitlement service boundary.
- Subscription activation/provisioning creates one entitlement per subscription item.
- Usage/current-usage/billing downward logic is not deeply refactored yet; mock or simplify `_getUsage` and delete stale downward helper chains that assume entitlements are computed from grants.

### Data Model

Add `customer_entitlements` with only the fields needed for this version:

- `id`
- `projectId`
- `customerId`
- `featurePlanVersionId`
- `subscriptionId` -> nullable
- `subscriptionPhaseId` -> nullable
- `subscriptionItemId` -> nullable
- `effectiveAt`
- `expiresAt`
- `allowanceUnits`
- `overageStrategy`
- `metadata`
- timestamps

Do not include:

- `anchor`
- `meterHash`
- price override fields
- duplicated feature config
- duplicated meter config
- duplicated cadence config

`allowanceUnits` semantics:

- `null` means unlimited/no hard cap.
- `0` means no included allowance; overage behavior depends on `overageStrategy`.
- Positive number means included allowance for the entitlement cadence.

### Agent Tasks

1. Read the current entitlement/grant/subscription schema files and validators before editing.
2. Add the `customer_entitlements` table and relations in the DB schema.
3. Add insert/select validators using the existing schema-generation pattern.
4. Add a migration and snapshot for the new table. Include a pre-migration assertion that existing grants are customer-owned if backfilling from grants.
5. Add CRUD-style methods to `EntitlementService`:
   - create customer entitlement
   - get customer entitlements for customer/time window
   - expire customer entitlement
   - get phase-owned entitlements
6. Wire subscription activation/provisioning so it creates customer entitlements for subscription items. Keep this idempotent by source window.
7. Mock or simplify `_getUsage` and remove downward helper chains that compute customer access by grouping grants. Leave a clear TODO for the later billing/current-usage redesign. Be ruthless and delete all unnecessary code on that path.
8. Add focused tests for schema/validator behavior and subscription entitlement creation idempotency.
9. Run `pnpm validate`. It must pass.
10. Ask for human review with a concise summary of schema, migration, subscription wiring, and deleted helper chains.

### Acceptance

- Subscription activation creates one entitlement per subscription item exactly once.
- Entitlement start/end controls access window.
- No entitlement `anchor` field exists.
- No entitlement or grant price override exists.
- `pnpm validate` passes.

---

## Phase 2 — Lean Grant Manager

**Goal:** Refactor grants into append-only allowance chunks attached to customer entitlements, and keep grant logic out of entitlement resolution.

### Scope

- Grant schema and validators.
- `GrantsManager` CRUD/append behavior.
- Subscription provisioning creates the default grant for each entitlement.
- Grant consumption utilities, if needed, are pure and small.

### Data Model

Simplify `grants` to:

- `id`
- `projectId`
- `customerEntitlementId`
- `type`
- `priority`
- `allowanceUnits`
- `effectiveAt`
- `expiresAt`
- `metadata`
- timestamps

Remove:

- `subjectId`
- `subjectType`
- `featurePlanVersionId`
- `meterHash`
- `deleted`
- `deletedAt`
- `limit`
- `units`
- `anchor`
- `overageStrategy`
- grant-level feature config, meter config, cadence, unit, or price fields

### Agent Tasks

1. Read existing grant manager tests and identify which expectations encode the old model.
2. Update grant schema, validators, migrations, and relations so grants reference `customerEntitlements`.
3. Collapse `limit` and `units` into `allowanceUnits`.
4. Refactor `GrantsManager` to minimal actions:
   - create/append grant
   - list grants for entitlement if needed
   - expire grant only if the product still needs explicit grant expiration
5. Delete grant manager methods that resolve ingestion states, merge grants, compute meter hashes, normalize units, or compute entitlement reset signatures.
6. Refactor subscription provisioning so creating an entitlement also appends the default subscription grant.
7. Ensure grants are consumed by priority and active range only. Cadence comes from the owning entitlement, not the grant.
8. Add tests:
   - lean grant validator rejects stale fields
   - default grant is created exactly once during activation
   - top-up/trial/promo grants append under the same entitlement
   - priority ordering is deterministic
   - `null`, `0`, and positive `allowanceUnits` semantics are covered
9. Run `pnpm validate`. It must pass.
10. Ask for human review with a concise summary of grant schema, manager surface, subscription provisioning changes, and deleted old grant logic.

### Acceptance

- Grants cannot exist without a customer entitlement.
- Grant manager does not know about meter identity, price, feature config, cadence, or ingestion routing.
- Subscription flow creates entitlement + default grant idempotently.
- `pnpm validate` passes.

---

## Phase 3 — Ingestion And Durable Object Runtime

**Goal:** Make ingestion resolve active customer entitlements by event slug and let the Durable Object own local entitlement/grant provisioning and grant availability filtering.

### Scope

- Ingestion entitlement resolution.
- DO route helper and apply payload.
- DO local schema for entitlement config and lean grants.
- Analytics/outbox payloads using `customer_entitlement_id`.

### Runtime Model

Ingestion should:

- receive an event
- find active customer entitlements for that customer and event slug
- pass one entitlement config plus its grants to the DO
- not merge grants
- not filter grant availability beyond obvious entitlement/event matching. If you think is better to add featureSlug and EventSlug to the entitlement schema to reduce complex queries please do.
- not compute price or meter hash

Durable Object should:

- route by `env:project:customer:customerEntitlementId`
- store entitlement config once locally
- store grants as append-only allowance rows
- filter active grants by grant range and priority
- use entitlement effective start as cadence anchor
- derive price/currency from the plan version feature config in the entitlement payload
- emit facts with stable `customer_entitlement_id`

### Agent Tasks

1. Replace DO route helper with `buildIngestionWindowName({ appEnv, projectId, customerId, customerEntitlementId })`.
2. Refactor ingestion resolution to query active customer entitlements by customer/time and filter by `featurePlanVersion.meterConfig.eventSlug`.
3. Build a small apply payload:
   - customer/project IDs
   - customer entitlement ID
   - entitlement effective/expires dates
   - feature plan version ID
   - feature config
   - meter config
   - reset/billing cadence config from plan version feature
   - overage strategy
   - grants with `grantId`, `allowanceUnits`, `priority`, `effectiveAt`, `expiresAt`
4. Delete `meterHash` usage from ingestion, DO schema, DO outbox, analytics validators, and fixtures.
5. Refactor DO local schema:
   - `entitlement_config` table keyed by `customer_entitlement_id`
   - lean `grants` table keyed by `grant_id`
   - grant windows remain per `grantId`
6. Move grant active-window filtering into the DO. Ingestion should only send the entitlement and known grants; the DO decides which grants are usable for the event timestamp.
7. Ensure pricing uses entitlement feature config and total entitlement usage before/after. Grant allocation is only allowance consumption, not price selection.
8. Add tests:
   - ingestion routes by `customerEntitlementId`
   - two customers on the same plan feature are isolated
   - ingestion no longer requires `meterHash`
   - DO handles unlimited allowance
   - DO denies zero allowance under hard/no-overage behavior
   - DO allows and prices usage under `overageStrategy="always"`
   - multi-grant allocation does not double-price tiered usage
9. Run `pnpm validate`. It must pass.
10. Ask for human review with a concise summary of ingestion simplification, DO storage shape, route changes, analytics changes, and test coverage.

### Acceptance

- No live code references `meterHash` or `meter_hash`.
- DO route is based on `customerEntitlementId`.
- Ingestion is a resolver/orchestrator, not a grant allocator.
- DO owns local entitlement/grant application and active-grant filtering.
- `pnpm validate` passes.

---

## Suggested Agent Prompt

Use this prompt for each phase, changing only the phase number:

```text
Read docs/hardening-entitlements.md and implement Phase <N> only.

Do not start the next phase.
Prefer existing Drizzle schemas, validators, and inferred types over handwritten duplicate types.
Keep the diff reviewable and delete stale old-model code instead of adding compatibility shims.
When implementation is complete, run pnpm validate. It must pass.
Then stop and ask for human review with a concise diff summary and any open questions.
```

