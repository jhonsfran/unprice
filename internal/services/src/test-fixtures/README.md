# Service Integration Test Fixtures

These helpers support the metering and billing invariant test plan.

## Local Setup

Run the local database services first:

```bash
docker compose up -d db pg_proxy
```

The integration setup creates `unprice_test` if it does not exist, runs the
Drizzle migrations, installs pgledger, and optionally restores SQL fixtures:

```bash
TEST_DB_FIXTURES=base-project.sql,plan-monthly-arrear.sql \
pnpm --filter @unprice/services test:integration
```

Use `withRollbackTransaction` for tests that can do all assertions inside one
transaction. Use `truncateTestDatabase` for tests that need committed state,
ledger views, or concurrent connections.

## Focused Commands

Run one inspectable billing workflow with:

```bash
pnpm --filter @unprice/services test:integration:p0-arrear
pnpm --filter @unprice/services test:integration:p0-arrear-capped
pnpm --filter @unprice/services test:integration:p0-advance
pnpm --filter @unprice/services test:integration:p0-advance-capped
```

Those focused commands truncate and seed `unprice_test`, run one billing
workflow, and leave its invoice and pgledger rows in the database for manual
inspection.

Run generated/reference coverage with:

```bash
pnpm --filter @unprice/services test:billing-model
pnpm --filter @unprice/services test:billing-properties
pnpm --filter @unprice/services test:billing-goldens
pnpm --filter @unprice/services test:billing-stateful
```

Replay generated failures with the printed seed:

```bash
UNPRICE_PROPERTY_SEED=<seed> pnpm --filter @unprice/services test:billing-properties
UNPRICE_MODEL_SEED=<seed> pnpm --filter @unprice/services test:billing-stateful
```

Increase generated coverage locally with:

```bash
UNPRICE_PROPERTY_RUNS=500 pnpm --filter @unprice/services test:billing-properties
UNPRICE_MODEL_RUNS=500 pnpm --filter @unprice/services test:billing-stateful
```

After a focused run, inspect the real ledger footprint with:

```bash
psql postgresql://postgres:postgres@localhost:5432/unprice_test \
  -c "select count(*) from unprice_invoices; select count(*) from unprice_ledger_idempotency; select count(*) from pgledger_entries_view;"
```

For statement-level inspection, filter by `project_id`, `subscription_id`, or
`statement_key` rather than looking at global counts from a previous test run.

## Add A SQL Seed

1. Create the scenario through dashboard flows or scripts so the rows are
   realistic.
2. Dump only the deterministic rows needed by the scenario into
   `src/test-fixtures/seeds/<name>.sql`.
3. Keep IDs stable and human-readable, for example `sub_test_monthly_arrear`.
4. Add the seed name to `src/test-fixtures/seeds/README.md`.
5. Use the seed from an integration test through `seedTestDb({ fixtures })`.

Prefer composing small seeds (`base-project.sql`, `customer-active.sql`, plan,
subscription) over one large scenario dump. If a seed changes schema-sensitive
columns, update the matching integration assertions in the same change.

## Add A Golden Case

Add reference-model examples to
`src/tests/billing-scenarios/golden-cases.test.ts` when the expected behavior is
a named billing policy: upgrade, downgrade, cancellation, trial, credit, annual
plan, late usage, or duplicate usage.

A good golden case:

- creates the smallest customer/plan/subscription setup that demonstrates the
  policy;
- uses explicit timestamps;
- asserts invoice lines, total, metering state, wallet state, or ledger count;
- calls `.assertAfterEachStep(...)` when the sequence is multi-step.

## Add A Property

Use `reference-model.properties.test.ts` for pure math/model invariants and
`src/tests/billing-scenarios/*.properties.integration.test.ts` when the property
must prove real persistence, pgledger rows, wallet credits, or idempotency rows.

Keep generated ranges small enough that failures shrink quickly. Always include
at least one explicit `examples` case for a boundary you care about.

## Add A Stateful Command

Use `reference-model.commands.test.ts` when command order matters. Add:

- a new command variant in `LifecycleCommand`;
- a generator in `lifecycleCommandArbitrary`;
- one applicator branch in `applyLifecycleCommand`;
- an invariant in `assertLifecycleInvariants` if the command creates a new kind
  of state.

Assert after every command. End-only assertions make failing sequences much
harder to shrink and replay.

## Failure Ownership

Use this ownership rule before adding a test:

| Symptom | Test owner |
| --- | --- |
| wrong accepted/rejected event, duplicate usage, late event policy | ingestion service or EntitlementWindowDO |
| wrong usage quantity or price math | reference model, rating service, billing property |
| wrong invoice row, period status, statement key | `billPeriod` integration |
| duplicate or missing ledger movement | ledger gateway or pgledger integration |
| wallet grant/reservation/flush mismatch | wallet service or capped-wallet integration |
| provider draft/finalize retry issue | `BillingService.finalizeInvoice` |
| subscription status or transition issue | subscription machine/service |
| concurrent billing/finalization race | real DB integration with separate connections |

If the bug requires a transaction, lock, unique index, pgledger view, or committed
state, use an integration test. If the bug is pure arithmetic or command-order
policy, use the reference model first.

## CI Guidance

CI should run the full service unit suite, API suite, and serialized integration
suite:

```bash
pnpm --filter @unprice/services test
pnpm --filter api test
pnpm --filter @unprice/services test:integration
```

For PR iteration, run the smallest focused command first, then broaden to the
package suite before handing off.
