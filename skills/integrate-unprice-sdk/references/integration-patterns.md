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
const { result, error } = await unprice.usage.consume({
  customerId,
  featureSlug: "ai-messages",
  eventSlug: "completions",
  idempotencyKey: requestId,
  properties: {
    aiMessages: 1,
    inputTokens,
    outputTokens,
  },
})

if (error) {
  throw new Error(error.message)
}

if (!result.allowed) {
  return denyPaidAction(result)
}

return performPaidAction()
```

Place this call before the cost is created. Reuse `requestId` when retrying the same logical paid
action. Do not use `crypto.randomUUID()` inside the retry loop.

If the actual charge is unknown until after work runs, decide whether the action needs a budgeted
run rather than pretending a guessed consume amount is exact.

## Record usage asynchronously

Use the host's durable background or after-response mechanism when available.

```ts
const { error } = await unprice.usage.record({
  customerId,
  eventSlug: "completions",
  idempotencyKey: requestId,
  properties: {
    aiMessages: 1,
    inputTokens,
    outputTokens,
  },
})

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
customer and workload budgets. A run is the financial authorization; the provider cap is what
keeps the external call inside that authorization.

The host must derive `worstCaseAmountMinor` from a model/provider pricing table it owns. Include
known input, request overhead, and the configured output maximum. Do not substitute an estimate
when the product promises a hard cap.

```ts
const proposed = priceModelRequest({
  model,
  inputTokens: exactInputTokens,
  // Determine this from the remaining customer and conversation allowance.
  maxOutputTokens: affordableOutputTokens,
})

if (proposed.maxOutputTokens < minimumUsefulOutputTokens) {
  return denyPaidAction({ reason: "INSUFFICIENT_BUDGET" })
}

const { result: run, error: startError } = await unprice.runs.start({
  customerId,
  budgetAmountMinor: proposed.worstCaseAmountMinor,
  idempotencyKey: `chat:${chatId}:message:${messageId}`,
  workloadType: "custom",
  workloadId: messageId,
  metadata: { workload_kind: "chat_message" },
})

if (startError) throw new Error(startError.message)
if (run.status !== "running" || run.remainingAmountMinor < proposed.worstCaseAmountMinor) {
  return denyPaidAction(run)
}

let finalStatus: "completed" | "failed" = "completed"

try {
  const response = await modelProvider.stream({
    messages,
    maxTokens: proposed.maxOutputTokens,
  })
  const actual = await response.usage

  const { result: consumption, error: consumeError } = await unprice.runs.consume({
    runId: run.runId,
    featureSlug,
    eventSlug,
    idempotencyKey: `chat:${chatId}:message:${messageId}:usage`,
    properties: actualMeterProperties(actual),
  })

  if (consumeError) throw new Error(consumeError.message)
  if (!consumption.accepted) {
    finalStatus = "failed"
    throw new Error("Unprice rejected a usage amount that the reservation should have covered")
  }

  return response
} catch (error) {
  finalStatus = "failed"
  throw error
} finally {
  const { error: endError } = await unprice.runs.end({
    runId: run.runId,
    status: finalStatus,
  })

  if (endError) {
    logger.error(new Error(endError.message), {
      operation: "unprice.runs.end",
      requestId: endError.requestId,
      code: endError.code,
      runId: run.runId,
    })
  }
}
```

If a provider exposes no enforceable cap or the host cannot price the request's maximum possible
cost, this is not a hard-cap integration. Reject the request before the provider call or use
asynchronous metering with an explicit product decision to accept the risk.

## Budget a multi-step workload

Track final status explicitly so failures are not reported as completed.

```ts
const { result: run, error: startError } = await unprice.runs.start({
  customerId,
  budgetAmountMinor,
  idempotencyKey: `run:${workloadId}`,
  workloadType: "workflow",
  workloadId,
})

if (startError) {
  throw new Error(startError.message)
}

if (run.status !== "running") {
  return rejectWorkload(run)
}

let finalStatus: "completed" | "failed" = "completed"

try {
  const { result, error } = await unprice.runs.consume({
    runId: run.runId,
    featureSlug,
    eventSlug,
    idempotencyKey: `run:${workloadId}:step:${stepId}`,
    properties,
  })

  if (error) {
    throw new Error(error.message)
  }

  if (!result.accepted) {
    finalStatus = "failed"
    return rejectWorkload(result)
  }

  return await performStep()
} catch (error) {
  finalStatus = "failed"
  throw error
} finally {
  const { error: endError } = await unprice.runs.end({
    runId: run.runId,
    status: finalStatus,
  })

  if (endError) {
    logger.error(new Error(endError.message), {
      operation: "unprice.runs.end",
      requestId: endError.requestId,
      code: endError.code,
      runId: run.runId,
    })
  }
}
```

Use a unique, stable idempotency key for each billable step. Keep the key stable when retrying that
step.

Do not let a `runs.end` error mask the original workload exception. Report it separately through
the host's logger or error aggregation.

## Preserve architectural ownership

Put Unprice orchestration at the layer that already owns the paid action:

- Use a service or use case when several routes, jobs, or procedures share the workflow.
- Keep HTTP and RPC adapters responsible for validation, authentication, and error mapping.
- Inject the Unprice client when the project uses dependency composition.
- Keep provider calls and paid work after the Unprice allow/reservation boundary.

Avoid creating a second billing abstraction unless the host project already requires one.
