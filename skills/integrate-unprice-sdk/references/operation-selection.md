# Choose the Unprice operation

Select the operation from the commercial behavior the application needs, not from method-name
similarity.

## Decision table

| Application need | Operation | Blocks over-budget work? | Mutates state? |
| --- | --- | --- | --- |
| Ask whether a customer may use a feature | `access.check` | No | No |
| Read all current capabilities for account UI or application state | `access.entitlements.current` | No | No |
| Compare Unprice with existing logic in shadow | `access.check` | No | No |
| Enforce a known usage amount before work runs | `usage.consume` | Yes | Yes |
| Report usage for metering and invoice evidence | `usage.record` | No | Yes, asynchronously |
| Hold a maximum before variable-cost or multi-step work | `budget(key).authorize` / `spend` | Yes | Yes |
| Provision a customer from a published plan | `customers.signUp` | Not a runtime gate | Yes |

Use this shorthand:

> `check` asks. `consume` decides and applies known usage now. `record` reports what happened.
> A budget hold reserves a maximum before variable-cost work starts.

## `access.entitlements.current`

Use `access.entitlements.current` when the application needs one customer-wide snapshot for account
UI, capability discovery, or several independent feature flags. Match rows by stable `featureSlug`.
Use `status` and `allowed` as returned, including unavailable rows. Do not reconstruct capability
state from the subscription plan name, plan slug, price, or a host-owned plan table.

Use `access.check` instead when one action needs one authoritative decision immediately before the
action. A snapshot is useful application state; it is not a replacement for an action-specific
gate when freshness or enforcement matters.

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

## Budgets

Use a budget when a paid action has an uncertain final cost or several billable steps: agents and
tool chains, workflows, long-running tasks, and nested work that needs an up-front cap.

Follow the lifecycle:

1. Create the cap once with `budgets.upsert` (a workload's own key takes `closesAt`).
2. Before each paid step, hold its maximum with `budget(key).authorize`, or wrap the step in
   `budget(key).spend`.
3. Continue only when the hold is allowed.
4. Settle the hold with the step's actual cost; release it only when the step produced no usage.

### Hard caps for AI and other variable-cost provider calls

A hold reserves the amount the application supplies. It cannot discover or limit the cost of a
provider request that the application has not bounded. For a hard "do not create more cost"
guarantee, make each provider call a finite proposed operation before it starts:

1. Price the known input with the provider/model's actual pricing contract, including any fixed
   request overhead.
2. Choose a maximum output that fits the remaining budget and configure the provider with that
   exact limit (for example, `maxTokens`).
3. Hold that worst-case amount. Continue only when the hold is allowed.
4. Call the provider only with the matching cap, then settle the actual cost.
5. Treat a settle above the hold as a fail-closed mismatch: log it and do not start another paid
   step.

If the host cannot calculate a safe upper bound for the model, tool, or provider request, deny it
before execution or accept that the action is metering-only rather than hard-capped.

The customer remains the economic actor; a workload's budget key bounds the workload.

## Customer provisioning

Use `customers.signUp` when Unprice should create or map the customer and provision the money path
from a published plan version. Persist the returned Unprice `customerId` against the application's
stable account or tenant ID.

Omit `planSlug` and `planVersionId` when Unprice owns the project's default signup plan. Use
`planSlug` for the latest published version selected by an explicit host policy, or `planVersionId`
when the integration must pin an exact published version.

For self-service plan changes, send the selected `planVersionId` from the current Unprice plan
catalog and validate it again on the server. Never search for a plan called `pro`, encode a plan
order, or keep an application-owned list of upgrade targets.

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
