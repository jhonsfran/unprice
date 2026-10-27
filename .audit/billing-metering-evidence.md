# Billing and metering correctness evidence

Baseline commit: `f97570af4`.

Each regression asserts the intended behavior. Apply its test changes to the parent of its fix commit to reproduce the failure. Run the same command at the fix commit to observe the passing result. Dependency fakes isolate external I/O. SQL checks use an isolated ClickHouse container.

## Issue 5: Preserve settlement retries

Verdict: VERIFIED.

Test: `internal/services/src/billing/service.collect.test.ts`, `retries settlement after failure`.

Command: `pnpm --filter @unprice/services test src/billing/service.collect.test.ts`.

Before: `Tests 3 failed | 14 passed (17)`. All three collection branches save `paid` after settlement fails. The test expects the original `waiting` or `unpaid` state and receives `paid`.

After: the three retry regressions pass. The invoice keeps its prior state after the first failure. Retry settles the receivable and saves `paid`. The provider receives at most one charge.

Adjacent verification: `pnpm --filter @unprice/services test src/billing/service.collect.test.ts src/billing/invoice-settlement.test.ts src/use-cases/billing/settle-invoice.test.ts`. Result: `Test Files 3 passed (3)`, `Tests 28 passed (28)`.

Independent review: issue 5 diff and before/after logs passed review. No new comments or correctness findings.

## Issue 8: Preserve refund retries

Verdict: VERIFIED.

Test: `internal/services/src/billing/service.generate-periods.test.ts`, `keeps a shortened paid period retryable when its ledger lookup fails`.

Before: `Tests 1 failed | 12 passed (13)`. The stored period end changed from `1775001600000` to `1773662400000` after the failed lookup. No refund was issued, and retry omitted the shortened period.

After: the failed lookup leaves the original period end and zero refund. Retry issues exactly `50_000_000` ledger minor units and shortens the period. The fake requires wallet adjustment to use the same transaction executor.

Command: `pnpm --filter @unprice/services test src/billing/service.generate-periods.test.ts src/billing/service.proration.test.ts`. Result: `Tests 21 passed (21)`.

Independent review: PASS. This regression proves transaction control flow with dependency fakes, not PostgreSQL rollback.

## Issue 9: Send invoices without a saved payment method

Verdict: VERIFIED.

Tests: `sends a manual invoice without a saved payment method` and `reconciles a paid provider invoice without a saved payment method` in `internal/services/src/billing/service.collect.test.ts`.

Command: `pnpm --filter @unprice/services test src/billing/service.collect.test.ts`.

Before: `Tests 4 failed | 17 passed (21)`. Manual sending and paid-provider reconciliation return the payment-method error instead of the expected `waiting` or `paid` result.

After: `Tests 21 passed (21)`. Payment-method validation applies only before a new automatic collection. Independent diff review passed.

## Issue 1: Rate each reset bucket

Verdict: VERIFIED.

Test: `billing across meter resets` in `internal/services/src/rating/service.extended.test.ts`.

Two daily buckets contain 15 and 25 units. Each day includes ten free units and charges one dollar per later unit. The expected statement contains 40 units and charges of `5.00` and `15.00`.

Before: `Tests 2 failed | 9 passed (11)`. Production rating returned 15 units and only `5.00`. The second regression also shows mixed daily and weekly grant attribution.

The first revision passed sixteen rating tests. Independent review then proved another valid configuration. Billing on the 15th with resets on the 1st can start after the free tier is already consumed. Ten earlier free units plus five accepted paid units must yield five units and `5.00` in the partial billing window. Repricing those five units from zero returned `0.00`.

The final recorded-usage path sums accepted signed amounts and units from the same deduplicated fact tuple for every window, including a window wholly inside one reset bucket. Explicit usage overrides retain synthetic pricing. Currency and ledger scale must match the grant. Seven new rating/schema cases fail before this correction and all twenty-three rating cases pass after it. The actual ClickHouse row for the partial window contains five units and `500000000` at scale eight.

Deploy the new `v1_get_billing_usage_allocations` endpoint before the application reader. The final independent review is recorded below.

## Issue 2: Preserve out-of-order usage in billing SQL

Verdict: VERIFIED.

`apps/api/src/ingestion/entitlements/billing-snapshot-proof.test.ts` runs the real processor. Two accepted events arrive in reverse timestamp order. Their snapshots contain one and two units. Replay returns the same fact.

`.audit/sql/prove-sql.py` renders the actual repository endpoint SQL and executes it in ClickHouse with the datasource's column types. It requires Python with Jinja2 and PyYAML, RTK, and a running Tinybird container. Set `BILLING_PROOF_CONTAINER` to its Docker name.

Before: `Failed checks 7`. The original SQL returns one unit for the actual processor output and for late sum/count and same-millisecond ordering cases.

After: `python3 .audit/sql/prove-sql.py` reports eighteen passing checks and `Failed checks 0`. The checks cover both billing endpoints, exact transport duplicates, max, latest, signed corrections, and accepted money for partial reset windows. A synthetic large-money check proves that Int128 aggregation preserves an unsafe total for rejection instead of wrapping it to zero. The processor regression also passes.

Independent review reran the same SQL proof and passed it. The archived synthetic processor output is `.audit/sql/processor-facts.ndjson`.

## Issue 7: Apply grace to period-end advance usage

Verdict: VERIFIED.

The two new regressions in `complex-pricing-cadence.integration.test.ts` execute the actual Drizzle repository against isolated PostgreSQL. They assert that advance-plan usage waits through the exact grace boundary and that shortening a phase also shortens its usage invoice time. Period-start fixed charges retain their invoice time.

Before: `Tests 2 failed | 7 skipped (9)`. Advance usage was eligible too early, and its capped invoice time stayed at the old cycle end.

After: `pnpm --filter @unprice/services test:integration:complex-pricing` passes all nine tests. The generation unit suite also passes all thirteen tests. Neon transport was restricted to the approved test proxy by `/private/tmp/unprice-billing-review/isolated-postgres.mjs`; no application database was used.

An additional reproducible PostgreSQL proof is available with `pnpm --filter @unprice/services exec vitest run --config vitest.readiness-proof.config.ts`. It requires the isolated `codex-billing-proof-postgres` container. It runs the generated repository queries against temporary tables inside a rollback transaction.

Independent review: PASS. The reviewer reran the PostgreSQL proof and checked the scheduler, exports, all migrated callers, and comments. No material findings.

## Issue 3: Isolate raw aggregates by reset period

Verdict: VERIFIED.

`reset-scoped aggregation correctness` in `apps/api/src/ingestion/entitlements/processor.test.ts` sends 10 before midnight, 6 after midnight, a late 12 before midnight, and 8 after midnight. The literal expected deltas are 10, 6, 2, 2, with day totals 12 and 8. The cases exercise both max and latest through single and batch APIs, then replay a late event.

Before: `Tests 12 failed | 3 passed | 66 skipped (81)`. The first next-day max event adds zero, and the first next-day latest event produces a negative charge. The additional legacy-state regressions also fail.

After: `pnpm --filter api test src/ingestion/entitlements` passes all 129 tests. These tests run the real processor, aggregation engine, grant allocator, pricing, and replay logic with the transactional in-memory storage port.

The fix keys raw state and batch drafts by reset period. Existing unscoped history cannot prove the raw value for an overlapping period. Such a period rejects new events without state changes and requires reconciliation. Periods after the legacy watermark start at zero. Cached and staged replay receipts continue to work without reconstructing raw state.

Independent review: PASS after one additional batch defect was reproduced and fixed. Raw state now loads only after replay, active-grant, and closed-period checks. A valid new-period event succeeds beside a closed legacy event, which receives its normal denial. The reviewer ran twenty focused and independent cases. API type checking also passes.

## Issue 4: Apply negative corrections to grant and wallet accounting

Verdict: VERIFIED.

The correction cases in `apps/api/src/ingestion/entitlements/processor.test.ts` call the real single and batch processors. They assert returned signed facts, persisted raw and grant state, restored capacity, wallet amounts and quantities, and replay results. They include sum and latest, enforced and unenforced limits, overcorrection debt, multiple grants, and overage reversal.

Before: `pnpm --filter api test src/ingestion/entitlements/processor.test.ts -t 'correction|zero-price'` reports `Tests 32 failed | 81 skipped (113)`.

After: all 160 entitlement tests pass. The adjacent aggregation and grant-allocation suites also pass all 65 tests.

Unflushed `+10, -4, +4` finishes at ten units and ten dollars. A four-unit correction against ten units with seven already captured rejects the whole correction. Raw state, grants, and wallet remain unchanged. A three-unit correction remains valid. The same rule protects pending capture intents and retained closed-reservation totals. Zero-price cases verify that quantity watermarks receive the same protection. Rejected requests keep a stable `INVALID_AGGREGATION_PROPERTIES` receipt and a clear credit-workflow message. Reversing captured money requires a separate funded credit operation.

Independent review: PASS. The reviewer independently reran all thirty-two correction cases under the explicit Node 24.17.0 binary. API and services type checks also pass. No added comments or suppressions.
