# @unprice/api

TypeScript SDK for the Unprice public API.

Use it from server-side code to check access, consume usage, cap spend with budgets, inspect wallet
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

const { error } = await unprice.usage.consume({
  customerId: "cus_1234567890",
  eventSlug: "completions",
  idempotencyKey: "req_123",
  properties: {
    inputTokens: 1840,
    outputTokens: 620,
    model: "gpt-4.1-mini",
  },
})

// A limit with no room, or a prepaid wallet that cannot fund the event, is a 402.
if (error?.code === "BUDGET_EXCEEDED") {
  return new Response("Usage limit reached", { status: 429 })
}
if (error) {
  throw new Error(error.message)
}
```

Use `access.check` for read-only shadow checks and `usage.record` (up to 100 events with their
`occurredAt`) for usage that already happened. To hold a maximum cost before expensive work, use a
budget (below).

## Budgets

Budgets ship in [`@unprice/budgets`](https://github.com/jhonsfran/unprice/tree/main/packages/budgets)
and come with this client. `unprice.budgets.*`, `unprice.budget(key)` (remote, or
`{ mode: "local" }` from a lease in memory), and `unprice.close()` work the same here, and the
budget errors are the same classes. Install `@unprice/budgets` on its own to cap spend without the
rest of the API. The [Budgets docs](https://docs.unprice.dev/budgets/overview) cover holds, `spend`,
recovery, and local mode.

```ts
await unprice.budgets.upsert({
  key: "customer:acme",
  unit: "USD",
  limits: [{ amount: "50", window: "month" }],
})

const text = await unprice.budget("customer:acme").spend({ estimate: maximumCost }, async () => {
  const r = await generateText({ model, prompt, maxOutputTokens })
  return { value: r.text, actual: costOf(r.usage) }
})
```

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
