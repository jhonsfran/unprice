# Shared-Run Overspend Proof Design

## Goal

Prove that one budgeted run cannot overspend when many requests consume its budget concurrently.
This is a correctness proof for the `RunBudgetDO`, not a second copy of every endpoint test.

## Why two tests

- The Workerd integration/regression test proves the storage and serialization invariant at the
  owning layer with deterministic assertions.
- The k6 scenario proves the same customer-visible behavior through the deployed HTTP API under
  real concurrent traffic.

"Regression" describes the promise we keep from breaking. The Workerd test is also an integration
test; the k6 scenario is a load/system test.

## Workerd test

Create one run with a small fixed budget, then issue more concurrent one-unit `consume` operations
than the run can afford. Use unique idempotency keys for the first wave and replay some accepted
keys afterward.

Assert:

- accepted consumption never exceeds the configured budget;
- the exact number of affordable operations succeeds;
- excess operations are denied;
- remaining budget never becomes negative;
- the durable final state matches the accepted total;
- replaying an accepted idempotency key does not consume again.

The test belongs beside the existing real-Workerd `RunBudgetDO` tests. No production change is
planned unless the new test exposes a bug.

## k6 scenario

Add a separate `overspend` scenario to the existing k6 package:

1. `setup` creates one shared budgeted run.
2. Concurrent VUs send unique one-unit consume requests to that same run.
3. `teardown` ends the run.
4. Checks require valid API responses and classify accepted versus denied attempts.
5. A final summary/invariant check requires accepted units to be at most the configured budget and
   reports any unexpected failures separately.

Keep this scenario explicit and manually/nightly runnable. It should not replace the faster
deterministic Workerd test or run once per endpoint.

## Non-goals

- Duplicating the same concurrency test across all ingestion endpoints.
- Testing analytics freshness or UI polling.
- Changing budget semantics, batching, or Durable Object architecture.

## Verification

- Run the focused Workerd test.
- Run the relevant package typecheck/validation.
- Validate the k6 script locally without requiring a production run; document the deployed command
  and required environment variables.

