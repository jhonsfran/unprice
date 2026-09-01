# @unprice/api

TypeScript SDK for the Unprice public API.

Use it from server-side code to check access, consume usage, reserve budgeted runs, inspect wallet
credits, and follow usage evidence through the customer money path.

## Installation

```bash
pnpm add @unprice/api
```

## Example

```ts
import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN!,
})

const { result, error } = await unprice.usage.consume({
  customerId: "cus_1234567890",
  featureSlug: "ai-messages",
  eventSlug: "completions",
  idempotencyKey: "req_123",
  properties: {
    aiMessages: 1,
    inputTokens: 1840,
    outputTokens: 620,
  },
})

if (error) {
  throw new Error(error.message)
}

if (!result.allowed) {
  return new Response("Usage limit reached", { status: 429 })
}
```

Use `access.check` for read-only shadow checks and `usage.record` for async usage evidence. For a
multi-step workload, call `runs.start` once, `runs.settle` after each completed provider step, and
`runs.end` once. `runs.consume` remains the pre-work enforcing operation.

## Reserve cost before expensive work

Use `reservations.reserve` when one provider call or other expensive operation must not start
until the customer can cover a developer-defined maximum cost.

```ts
import { generateText } from "ai"
import { Unprice } from "@unprice/api"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })
const messageId = "message_123"

const { result: reservation, error } = await unprice.reservations.reserve({
  customerId: "cus_1234567890",
  maximumAmountMinor: 10,
  idempotencyKey: messageId,
})

if (error) {
  // Do not call the provider when Unprice cannot reserve the maximum cost.
  return new Response("Budget unavailable", { status: 402 })
}

const generation = await generateText({
  model,
  maxOutputTokens: 2_000,
  prompt,
})

const settlement = await reservation.settle({
  featureSlug: "ai-tokens",
  eventSlug: "ai-completion",
  properties: {
    input_tokens: generation.usage.inputTokens,
    output_tokens: generation.usage.outputTokens,
  },
})

if (
  settlement.error ||
  (!settlement.result.accepted && settlement.result.reason !== "duplicate")
) {
  throw new Error("Usage could not be settled")
}
```

`maximumAmountMinor` uses the customer's plan currency in minor units. For a USD plan, `10` is
$0.10. Set the provider's output limit when it supports one so the reserved amount can fully fund
the provider usage. If actual usage costs more, settlement still records all usage and returns a
`partially_funded` or `unfunded` funding status. Unprice never increases the reservation or captures
more than `maximumAmountMinor`. For settlement, `accepted` means that Unprice recorded the usage;
the funding fields state how much the reservation covered.

Call `reservation.release()` only when the operation produced no billable usage. If the provider
failed after it did billable work and reports usage, settle that usage instead. Do not release
after a settlement error because the provider cost can already exist; retry settlement with the
same reservation handle. Settlement records the incurred usage without enforcing the feature
limit, captures the safely funded cost from the reserved money envelope, and then closes the run.
An unclosed reservation expires one hour after it starts. The Durable Object then releases its
unused reserved funds. Pass `expiresAt` as an epoch-millisecond timestamp when the operation needs
a different window. The timestamp cannot be more than 24 hours after the reservation starts.

For streaming APIs, reserve before `streamText`, settle from `onFinish`, and apply the same
provider-specific decision on errors. The lower-level `runs` API remains available for workflows
that need several usage events or a serializable run identifier.

## Monetization configuration

`monetization.get` and `monetization.apply` let you describe a project's plans, features, and
events as one configuration document instead of clicking through the dashboard. Both require a
**config** API key. The API rejects a runtime key. Keep the key types separate because a config key can
rewrite your pricing, the runtime key cannot.

```ts
const unprice = new Unprice({ token: process.env.UNPRICE_CONFIG_TOKEN! })

const { result, error } = await unprice.monetization.apply({
  config: {
    plans: [
      {
        slug: "pro",
        title: "Pro",
        version: {
          currency: "USD",
          paymentProvider: "stripe",
          billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
          features: [{ featureSlug: "tokens", featureType: "flat", config: { price: "10.00" } }],
        },
      },
    ],
  },
})
```

`apply` writes **draft** plan versions and never publishes. A human reviews the drafts and
publishes them from the dashboard; `result.reviewUrl` links to the first draft the call created.
Until someone publishes, nothing you sent affects a live customer. There is no publish method in
this SDK, by design.

`result.plans` reports one outcome per plan in the order you sent them, and `result.staleDrafts`
reports drafts left behind by earlier documents.

Call `monetization.get` to read the current configuration back in the shape `apply` accepts. It
takes no arguments because the project comes from the key. Alongside the document, it returns
`unrepresentablePlans` for plans the document cannot describe and `warnings` for stored
configuration the document omits. The call reports these omissions instead of discarding them.

## License

MIT. All project-owned packages under `packages/**` are licensed separately from the
AGPL-3.0-only Unprice core. You can embed this package in an application without applying the core
license to the application.
