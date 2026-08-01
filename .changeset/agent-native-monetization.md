---
"@unprice/api": minor
---

Add the `monetization` namespace: `monetization.apply` turns one configuration document into draft
plan versions for the project the key belongs to, and `monetization.get` reads the current
configuration back in the shape `apply` accepts. Both require a config API key. Nothing is
published — a human reviews and publishes the drafts from the dashboard.

Regenerating the SDK from the live OpenAPI document also picked up API changes that the checked-in
spec had missed:

- `customers.signUp` takes `creditLineAmountMinor` (integer minor units) instead of
  `creditLineAmount`, and its `metadata` accepts `usageLimitReached`.
- Error responses carry an optional `details` object (`{ kind, issues? }`), and every route can now
  return `413 PAYLOAD_TOO_LARGE`.
- `planVersions.get`, `planVersions.list`, and `subscriptions.get` return `configHash` and
  `metadata.includedCreditAmount` on a plan version.
- `ingestionEvents.status` returns `facets`, plus `ingestionMode`, `runId`, `traceId`,
  `parentRunId`, `workloadType`, and `workloadId` on each recent event.
