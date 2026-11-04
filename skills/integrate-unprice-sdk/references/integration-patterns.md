# Unprice integration patterns

Adapt these patterns to the host project. Match its environment validation, dependency injection,
service boundaries, logging, errors, response conventions, and tests.

Inspect the installed `@unprice/api` types before copying a request shape.

## Create one server-only client

Keep client construction in a server-only module or dependency composition root.

```ts
import { Unprice } from "@unprice/api"

const token = process.env.UNPRICE_TOKEN

if (!token) {
  throw new Error("UNPRICE_TOKEN is required")
}

export const unprice = new Unprice({ token })
```

Prefer the project's validated environment object when one exists. In Next.js, preserve existing
`server-only` boundaries. Never export this client from a browser-safe package barrel.

Set `baseUrl` only for an intentional self-hosted or test environment. Do not silently redirect
production traffic.

## Handle errors and denials separately

Every SDK call returns an explicit result or error. Check `error` before reading `result`.

```ts
const { result, error } = await unprice.access.check({
  customerId,
  featureSlug,
})

if (error) {
  logger.error(new Error(error.message), {
    operation: "unprice.access.check",
    requestId: error.requestId,
    code: error.code,
  })

  return applyConfiguredOutagePolicy()
}

if (!result.allowed) {
  return denyPaidAction(result)
}

return performPaidAction()
```

An error means Unprice could not provide a valid commercial decision. A result with
`allowed: false` is a valid denial. Do not collapse both into the same generic catch or silently
allow work.

Use the host project's logger and error primitives. Do not introduce `console.log`.

## Read the current capability snapshot

Use one current-entitlements call when account UI or application state needs several feature
decisions. Keep stable feature slugs in code and let Unprice decide which plans grant them.

```ts
const { result, error } = await unprice.access.entitlements.current({ customerId })

if (error) {
  logger.error(new Error(error.message, { cause: error }), {
    operation: "unprice.access.entitlements.current",
    requestId: error.requestId,
    code: error.code,
  })

  return applyConfiguredOutagePolicy()
}

const sharing = result.entitlements.find(
  (entitlement) => entitlement.featureSlug === "public-sharing"
)

const canSharePublicly =
  sharing?.status === "available" && sharing.allowed
```

Treat unavailable or missing rows as unavailable according to the host's explicit outage and UI
policy. Do not infer access from `planSlug`, a plan title, or price metadata.

## Provision and map a customer

Call `customers.signUp` at the application workflow that owns customer or subscription onboarding.
Persist the returned Unprice ID.

```ts
const { result, error } = await unprice.customers.signUp({
  name: account.name,
  email: account.billingEmail,
  externalId: account.id,
  successUrl,
  cancelUrl,
})

if (error) {
  throw new Error(error.message)
}

await accounts.saveUnpriceCustomerId({
  accountId: account.id,
  unpriceCustomerId: result.customerId,
})
```

Make the surrounding onboarding workflow idempotent using the host application's established
pattern. Do not call signup from every request path.

Omit plan selectors when Unprice owns the default signup plan. Add `planSlug` or `planVersionId`
only for an explicit host-owned selection. Do not copy the default plan into application code.

Use a capped credit line only when the product needs a hard customer-specific
spend ceiling. It is independent of a plan's usage tiers: model included units
and overage with graduated tiers, then pass the cap in currency minor units at
signup.

## Change to a catalog-selected plan

Load the current plan catalog from Unprice for display. Submit the selected `planVersionId`, then
reload and validate that exact version on the server before changing the subscription. Reject
managed or unavailable versions by their API metadata, not by plan name.

```ts
const target = await loadCurrentPlanVersion(planVersionId)

if (!target || target.enterprise) {
  return rejectSelfServiceChange()
}

const { result, error } = await unprice.customers.changePlan({
  customerId,
  planVersionId: target.planVersionId,
})

if (error) {
  throw new Error(error.message)
}

return result
```

Do not encode a `free -> pro -> enterprise` ladder, plan-specific credit lines, or display-name
checks in the host. Pricing operators must be able to change packaging without an application
release.

## Add a read-only shadow check

Call `access.check` beside the current decision without changing production behavior. Record the
comparison with the existing observability system.

```ts
const currentDecision = await currentAuthorization.canRun(input)
const { result, error } = await unprice.access.check({
  customerId: input.unpriceCustomerId,
  featureSlug: input.featureSlug,
})

if (error) {
  logger.error(new Error(error.message), {
    operation: "unprice.access.check.shadow",
    requestId: error.requestId,
    code: error.code,
  })
} else {
  logger.info("unprice shadow decision", {
    currentAllowed: currentDecision.allowed,
    unpriceAllowed: result.allowed,
    featureSlug: input.featureSlug,
  })
}

return currentDecision
```

Do not send secrets or sensitive customer data into logs. Use the repository's structured logging
shape rather than copying these field names blindly.

## Enforce known usage synchronously

Derive the idempotency key from a stable logical request or command ID.

```ts
const { error } = await unprice.usage.consume({
  customerId,
  eventSlug: "completions",
  idempotencyKey: requestId,
  properties: {
    inputTokens,
    outputTokens,
  },
})

// 402: a hard limit has no room, or a prepaid wallet cannot fund the event.
if (error?.code === "BUDGET_EXCEEDED") {
  return denyPaidAction(error)
}
if (error) {
  throw new Error(error.message)
}

return performPaidAction()
```

Place this call before the cost is created. Reuse `requestId` when retrying the same logical paid
action. Do not use `crypto.randomUUID()` inside the retry loop.

If the actual charge is unknown until after work runs, decide whether the action needs a budget
hold rather than pretending a guessed consume amount is exact.

## Record usage asynchronously

Use the host's durable background or after-response mechanism when available.

```ts
const { result, error } = await unprice.usage.record({
  events: [
    {
      customerId,
      eventSlug: "completions",
      idempotencyKey: requestId,
      // When the work ran, not when the call is sent: a retry then replays.
      occurredAt: completedAt,
      properties: {
        inputTokens,
        outputTokens,
      },
    },
  ],
})
// Each event answers on its own; a refused one carries error.reason (NOT_PRICED, TOO_LATE, ...).

if (error) {
  logger.error(new Error(error.message), {
    operation: "unprice.usage.record",
    requestId: error.requestId,
    code: error.code,
  })
}
```

Adapt the call to `waitUntil`, a job queue, or another established mechanism only when the host
already guarantees its lifecycle. Never drop the promise without error handling.

Do not branch paid-work authorization on the outcome of `usage.record`.

## Hard-cap a variable-cost provider call

Use this pattern when a provider call must not start unless its maximum possible cost fits the
customer's budget. The hold is the financial authorization; the provider cap is what keeps the
external call inside it.

The host must derive `worstCaseAmount` from a model/provider pricing table it owns. Include known
input, request overhead, and the configured output maximum. Do not substitute an estimate when the
product promises a hard cap.

```ts
const budget = unprice.budget(`customer:${customerId}`)

const { result: authorization, error } = await budget.authorize({
  amount: worstCaseAmount, // a decimal string in the budget's unit, e.g. "0.10"
  idempotencyKey: `message:${messageId}`,
})

if (error) {
  throw error
}

if (!authorization.allowed) {
  return denyPaidAction({ reason: "BUDGET_EXCEEDED" })
}

const generation = await generateText({ model, prompt, maxOutputTokens: affordableOutputTokens })

const settlement = await authorization.hold.settle({ amount: costOf(generation.usage) })
if (settlement.error) {
  // Retry the settle with the same hold; never release a hold whose work produced usage.
  logger.error(settlement.error, { operation: "unprice.budget.settle" })
}
```

## Budget a multi-step workload

Give the workload its own budget key, closed when its window ends, and wrap each paid step in
`spend`: it holds the estimate, runs the step, and settles the actual cost.

```ts
const key = `run:${jobId}`
await unprice.budgets.upsert({
  key,
  unit: "USD",
  limits: [{ amount: "50", window: "never" }],
  closesAt: Date.now() + 60 * 60 * 1000,
})

for (const step of steps) {
  // Throws BudgetExceededError before the step runs when the cap cannot cover the estimate.
  await unprice.budget(key).spend({ estimate: step.maxCost }, async () => {
    const result = await step.run()
    return { value: result, actual: result.cost }
  })
}
```

Use a unique, stable idempotency key for each billable step. Keep the key stable when retrying that
step.

## Preserve architectural ownership

Put Unprice orchestration at the layer that already owns the paid action:

- Use a service or use case when several routes, jobs, or procedures share the workflow.
- Keep HTTP and RPC adapters responsible for validation, authentication, and error mapping.
- Inject the Unprice client when the project uses dependency composition.
- Keep provider calls and paid work after the Unprice allow/reservation boundary.

Avoid creating a second billing abstraction unless the host project already requires one.
