# Verify an Unprice integration

Review behavior at the owning service or use-case layer. Keep adapter tests focused on validation,
authentication, and error mapping.

## Static checks

- Confirm `@unprice/api` is installed with the host package manager.
- Confirm one server-only client owns the token.
- Search browser and client bundles for `UNPRICE_TOKEN`, `Unprice`, or public token exposure.
- Confirm environment values are validated using the project's existing mechanism.
- Confirm feature, event, and plan slugs come from real configuration.
- Confirm exact request shapes typecheck against the installed SDK.
- Confirm no new `any`, unhandled promise, or `console.log` was introduced.
- Confirm errors log `error.requestId` without logging the token or sensitive payloads.

## Behavioral checks

For `access.check`:

- Test allowed, denied, and API-error outcomes.
- Confirm the call does not mutate usage.
- In shadow mode, confirm existing authorization still controls behavior.

For `usage.consume`:

- Test allowed, denied, and API-error outcomes.
- Confirm paid work runs only after an allow.
- Retry the logical request and assert that the same idempotency key is reused.
- Confirm a denial is not treated as an exception or transport failure.

For `usage.record`:

- Confirm the integration never uses it to authorize paid work.
- Confirm the returned promise is awaited or attached to an established durable lifecycle.
- Test and observe reporting errors without changing the paid-action decision.
- Confirm event properties match the configured meter inputs.

For budgeted runs:

- Test start error and non-running start results.
- Test accepted and rejected consumption.
- Test workload exceptions.
- Assert `runs.end` executes for every started run.
- Assert rejected consumption and exceptions end with `status: "failed"`.
- Assert an end error does not hide the original workload error.
- Assert every step has its own stable idempotency key.

For a hard-capped variable-cost provider call:

- Test that an insufficient known-input or output envelope rejects before the provider is called.
- Test that the provider receives the same output cap used to calculate the run reservation.
- Test that one conversation cannot reserve more than its remaining conversation allowance.
- Test an unexpected rejected settlement as a failure that prevents the next paid call.

For customer signup:

- Confirm signup occurs in the onboarding/subscription owner, not every request.
- Confirm the returned Unprice customer ID is persisted against the stable account or tenant.
- Confirm a retry cannot create an accidental parallel mapping.
- Confirm the plan version is published and the plan choice matches product policy.

## Failure-policy checks

Require an explicit policy for Unprice API errors:

- Fail closed when creating unbounded customer cost would be unsafe.
- Fail open only when the product owner intentionally accepts the margin and abuse risk.
- Preserve the request ID and operation in server-side observability.
- Do not turn an outage into a fake commercial denial unless the product explicitly wants that UX.

## Commands

Use the host project's documented commands. Run the smallest relevant checks first:

1. Format or lint only changed files.
2. Typecheck the changed package.
3. Run focused unit tests.
4. Broaden validation when the integration owns money-path or request-path behavior.

Do not start development servers, create live customers, consume production usage, or reserve real
funds merely to validate generated code.

## Completion report

State:

- which Unprice operation was selected and why;
- where the server-only client and customer mapping live;
- how errors, denials, and outages behave;
- how idempotency keys are derived and reused;
- which tests and validation commands passed;
- which dashboard configuration or live verification remains for the user.
