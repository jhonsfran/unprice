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

## License

MIT. This package is licensed separately from the AGPL-3.0 Unprice core so it can be embedded in
applications without applying the core repository license to the host app.
