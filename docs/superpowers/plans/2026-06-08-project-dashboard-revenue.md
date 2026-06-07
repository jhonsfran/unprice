# Project Dashboard Revenue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard revenue estimate with ledger-backed recognized revenue for the selected interval.

**Architecture:** Add one aggregate method to `LedgerGateway`, because that class owns pgledger SQL, account names, metadata filters, and money conversion. Inject the ledger gateway into `AnalyticsService` and have `getOverviewStats` use the aggregate while keeping the existing signup/customer/subscription counts.

**Tech Stack:** TypeScript, Drizzle SQL templates, pgledger views, Dinero/money helpers, Vitest.

---

### Task 1: Add Ledger Revenue Aggregate

**Files:**
- Modify: `internal/services/src/ledger/gateway.ts`
- Test: `internal/services/src/ledger/gateway.test.ts`

- [ ] Add `getRecognizedRevenue({ projectId, currency, start, end })` to `LedgerGateway`.
- [ ] Query `unprice_ledger_idempotency`, `pgledger_entries_view`, and `pgledger_accounts_view`.
- [ ] Filter to invoice-visible positive credit entries into `customer.*.consumed`.
- [ ] Convert the summed pgledger decimal string with `fromLedgerAmount`.
- [ ] Add a unit test that returns `7.50000000` and asserts the resulting Dinero snapshot amount is `750000000`.

### Task 2: Wire Analytics Stats

**Files:**
- Modify: `internal/services/src/analytics/service.ts`
- Modify: `internal/services/src/context.ts`

- [ ] Inject `ledgerGateway` into `AnalyticsService`.
- [ ] In `getOverviewStats`, call `ledgerGateway.getRecognizedRevenue` with the selected interval and project default currency.
- [ ] Set `stats.totalRevenue.total` from the ledger aggregate decimal.
- [ ] Keep existing count stats and error handling behavior.

### Task 3: Verify

**Commands:**
- `pnpm --filter @unprice/services exec vitest run src/ledger/gateway.test.ts`
- If type coverage is needed after implementation: `pnpm --filter @unprice/services typecheck`
