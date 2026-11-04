---
"@unprice/api": minor
---

Usage and access now run on each customer's subscription budget.

- `usage.record` takes `{ events }`: 1 to 100 events, each with a required `occurredAt`, and answers one result per event (`accepted`, `rejected`, `results`). A refused event carries the error a single call would return.
- `usage.consume` no longer takes `featureSlug`, `id`, or `timestamp`. It answers what the event cost and the budget's balance; a denial is a 402 (`BUDGET_EXCEEDED`) instead of `allowed: false`.
- `access.check` no longer takes `timestamp`, answers `metered`, and drops `spending`; `rejectionReason` is `NO_ENTITLEMENT`, `LIMIT_EXCEEDED`, or `BUDGET_CLOSED`.
- `access.entitlements.current` reports `spending` as `{ unit, amount }` in the budget's unit.
