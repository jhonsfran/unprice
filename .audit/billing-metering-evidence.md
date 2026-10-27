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
