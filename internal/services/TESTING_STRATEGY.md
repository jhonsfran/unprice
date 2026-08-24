# Service test strategy

Billing and entitlement defects can move money or grant the wrong access. Tests must prove the
business rule at its owning layer.

## Test layers

### Unit tests

Use unit tests for pure calculations and deterministic state changes. `Vitest` covers examples.
`fast-check` covers properties over many generated inputs.

- `src/entitlements/grants.test.ts` checks grant merge policies.
- Usage-meter tests check aggregation, overage behavior, and limits.

### Service and integration tests

Use service tests for interactions between domain services. Use integration tests when the rule
depends on Postgres, a transaction, or a storage invariant.

- `src/subscriptions/subscriptionLock.test.ts` checks lock behavior with controlled collaborators.
- `src/subscriptions/subscriptionLock.integration.test.ts` checks the Postgres-backed advisory lock.

### Workflow tests

`src/tests/workflow.test.ts` checks behavior across billing-cycle boundaries. It covers customer
signup, usage, cycle reset, plan changes, and invoice preview in one time-ordered scenario.

Keep detailed assertions near the service that owns each rule. The workflow test should prove that
the pieces still work together.

## Test controls

### Time

Inject the clock into time-sensitive code. Tests can then cross billing-cycle and expiration
boundaries without waiting or replacing global time.

### Concurrency

Test lock behavior under competing requests. Use the Postgres integration suite when the result
depends on advisory-lock semantics.

### Fixtures

Build grants and related records through the shared test fixtures. Do not copy object literals that
can drift from the database validators.

### Dry runs

Use dry-run invoice generation when a test needs the calculation but must not persist invoice
state.
