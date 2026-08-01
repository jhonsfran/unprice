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

Use `access.check` for read-only shadow checks, `usage.record` for async usage evidence, and
`runs.start` / `runs.consume` / `runs.end` when a multi-step workload needs a budget before it
starts.

## Monetization configuration

`monetization.get` and `monetization.apply` let you describe a project's plans, features, and
events as one configuration document instead of clicking through the dashboard. Both require a
**config** API key — a runtime key is rejected. Keep the two key types separate: the config key can
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
takes no arguments — the project comes from the key. Alongside the document it returns
`unrepresentablePlans` (plans the document cannot describe) and `warnings` (stored configuration
the document is silent about), so what the document omits is always visible rather than lost.

## License

MIT. This package is licensed separately from the AGPL-3.0 Unprice core so it can be embedded in
applications without applying the core repository license to the host app.
