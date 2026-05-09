# Testing Strategy & Robustness Architecture

This document outlines the testing strategy for the Billing & Entitlements services at UnPrice. Our goal is to ensure 100% reliability in billing logic, as errors here directly impact revenue and customer trust.

## 1. Testing Strategy

We employ a multi-layered testing approach to verify correctness, determinism, and resilience.

### A. Unit Tests: Pure Logic & Determinism
Most billing logic (proration, usage limits, grant merging) is pure functions or deterministic state transitions.
- **Goal:** Verify calculation accuracy without database side effects.
- **Tools:** `Vitest`, `fast-check` (Property-Based Testing).
- **Key Suites:**
  - `grants.test.ts`: Verifies grant merging policies (Max, Sum, Replace). Uses property-based testing to check thousands of combinations.
  - `usage-meter.test.ts`: Verifies usage tracking, overage strategies ("always", "none", "last-call"), and limits.

### B. Integration Tests: Service Interactions
We test how services interact with the database, cache, and each other.
- **Goal:** Verify data flow and state persistence.
- **Tools:** In-memory mocks of Database, Cache, and Analytics layers.
- **Key Suites:**
  - `entitlements/service.ts`: Verifies report usage flow, idempotency, and revalidation logic.
  - `subscriptionLock.test.ts`: Verifies concurrency controls using simulated database locks.

### C. Workflow Tests: The "Golden Scenario"
This is our highest-level test suite (`workflow.test.ts`), simulating a complete customer journey over time.
- **Goal:** Catch regressions in long-running processes like billing cycles, plan upgrades, and resets.
- **Scenario:**
  1. **Day 0:** Customer signs up (Subscription created).
  2. **Day 5:** Usage is reported (Entitlement verified).
  3. **Day 32:** Cycle resets (Usage should be 0).
  4. **Day 40:** Plan Upgrade (Pro-rata applied, entitlements reset).
  5. **Day 40:** Invoice Preview (Dry-run billing generated).

---

## 2. Foundational Pieces for a Robust System

To scale safely, the following architectural foundations have been implemented:

### 1. Deterministic Time Travel (Virtual Clock)
Billing depends heavily on time (pro-rata, billing cycles, expirations). Relying on `Date.now()` makes tests flaky.
- **Solution:** We injected a `now` parameter into all time-sensitive methods (`SubscriptionService`, `EntitlementService`).
- **Implementation:** `createClock` in `test-utils.ts` allows us to "fast-forward" time in tests (e.g., jump 30 days) to verify cycle resets and expirations deterministically.

### 2. Concurrency Control (Advisory Locks)
State machines (Subscriptions) and Usage Reporting can suffer from race conditions under load.
- **Solution:** `SubscriptionLock` implements Postgres-backed advisory locks.
- **Verification:** Stress tests in `subscriptionLock.test.ts` prove that even with 50 concurrent requests, only one succeeds at a time, protecting critical state transitions.

### 3. Centralized Test Factories
Mock data drift is a common source of false positives/negatives.
- **Solution:** `createMockGrant` in `test-utils.ts` provides a single source of truth for grant mock data, ensuring tests use valid, up-to-date schemas.

### 4. Dry-Run Billing Capability
Generating invoices is a destructive operation (state changes).
- **Solution:** `BillingService.generateBillingPeriods` now supports a `dryRun` flag.
- **Benefit:** This allows us to implementing "Invoice Preview" features for UI and run safe production smoke tests without corrupting data.

---

## 3. Future Goals

As the system grows, we aim to expand verification in the following areas:

1.  **Expanded Golden Scenarios:**
    - Test edge cases: Failed payments, dunning processes, mid-cycle cancellations, and add-on purchases.
2.  **Performance Profiling:**
    - Benchmark `UsageMeter` and `EntitlementService` under high throughput (10k+ req/sec) to ensure low latency.
3.  **Chaos Testing:**
    - Simulate database timeouts and cache failures to ensure the system degrades gracefully (e.g., "fail open" vs "fail closed" policies).
4.  **Shadow Billing:**
    - In production, run the new billing engine in "shadow mode" alongside the legacy system (if any) or double-check calculations asynchronously to alert on discrepancies.
