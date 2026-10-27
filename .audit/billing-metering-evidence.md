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
