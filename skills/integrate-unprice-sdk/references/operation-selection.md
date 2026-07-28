# Choose the Unprice operation

Select the operation from the commercial behavior the application needs, not from method-name
similarity.

## Decision table

| Application need | Operation | Blocks over-budget work? | Mutates state? |
| --- | --- | --- | --- |
| Ask whether a customer may use a feature | `access.check` | No | No |
| Compare Unprice with existing logic in shadow | `access.check` | No | No |
| Enforce a known usage amount before work runs | `usage.consume` | Yes | Yes |
| Report usage for metering and invoice evidence | `usage.record` | No | Yes, asynchronously |
| Reserve a budget for multi-step work | `runs.start` / `runs.consume` / `runs.end` | Yes | Yes |
| Provision a customer from a published plan | `customers.signUp` | Not a runtime gate | Yes |

Use this shorthand:

> `check` asks. `consume` decides and applies known usage now. `record` reports what happened.
> `runs` reserve before a variable-cost workload starts.

## `access.check`

Use `access.check` for a read-only preflight. It resolves current entitlement, limit, budget, or
credit context without consuming usage or reserving funds.

Choose it for:

- shadow adoption beside existing authorization logic;
- preflight UI or API decisions;
- feature access where no usage amount must be applied;
- comparing Unprice decisions before enabling enforcement.

Do not treat a successful HTTP response as an allow. Branch on `result.allowed`.

Do not treat an API error as a commercial denial. Apply the host application's explicit outage
policy and preserve the error's request ID in server logs.

## `usage.consume`

Use `usage.consume` when the usage amount is known before the paid action and the request path must
deny work once the customer reaches a limit, budget, or credit boundary.

Choose it for:

- one API call with known metered properties;
- one export, generation, or job with a bounded known charge;
- synchronous enforcement before provider or infrastructure cost is created.

Send a stable `idempotencyKey` for the logical action. Reuse it after timeouts and retries. Never
generate a replacement key merely because the transport attempt changed.

Only perform the paid action after `result.allowed` is true.

## `usage.record`

Use `usage.record` to enqueue usage for metering, analytics, and invoice evidence without making it
a synchronous commercial gate.

Choose it for:

- background or eventual metering;
- usage that may exceed funds by product policy;
- evidence collection after work already happened;
- one event that feeds multiple meters through its properties.

`usage.record` never denies over-budget work. Do not call it before an expensive action and assume
that awaiting the SDK response authorizes the work.

The SDK invocation still performs network I/O and can return an error. Use the host application's
existing background-task or after-response mechanism when the request must not wait; do not invent
an unreliable fire-and-forget promise.

## Budgeted runs

Use `runs.start`, `runs.consume`, and `runs.end` when a workload has multiple billable steps or an
uncertain final cost.

Choose runs for:

- agents and tool chains;
- workflows and multi-step jobs;
- long-running tasks;
- nested or iterative work that needs an up-front budget envelope.

Follow the lifecycle:

1. Call `runs.start` before paid work.
2. Continue only when the returned run is `running`.
3. Call `runs.consume` as billable steps spend the reservation.
4. Stop the workload when consumption is rejected.
5. Call `runs.end` in `finally` to release unused funds.
6. End as `failed` after exceptions or rejected consumption.

Do not use a run as a customer identity. The customer remains the economic actor; the run labels
and bounds the workload.

## Customer provisioning

Use `customers.signUp` when Unprice should create or map the customer and provision the money path
from a published plan version. Persist the returned Unprice `customerId` against the application's
stable account or tenant ID.

Use `planSlug` for the latest published version selected by product policy, or `planVersionId` when
the integration must pin an exact published version. Confirm the choice with the user or existing
application behavior.

Do not recreate the customer on each request. Reuse the stored mapping.

## Names and identifiers

- Use `customerId` for the Unprice customer, not an arbitrary application user ID unless the
  installed contract explicitly accepts the external ID.
- Use `featureSlug` for the sellable capability being checked or consumed.
- Use `eventSlug` for the broad activity the application emits.
- Use `properties` for meter inputs such as token counts, requests, seats, or bytes.
- Use a stable idempotency key for each logical mutation.

Never invent slugs. Obtain them from the application's configuration, Unprice dashboard output,
tests, fixtures, or the user.

## Deeper documentation

- Runtime choice: `https://docs.unprice.dev/quickstart/choose-operation`
- First customer: `https://docs.unprice.dev/quickstart/onboarding-customer`
- SDK overview: `https://docs.unprice.dev/libraries/ts/sdk/overview`
- Documentation index: `https://docs.unprice.dev/llms.txt`
