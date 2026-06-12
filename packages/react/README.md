# @unprice/react

React utilities for Unprice browser clients and buffered usage delivery.

## Installation

```bash
pnpm add @unprice/react
```

## Client Provider

Use `UnpriceClientProvider` when browser code needs a configured API client.

```tsx
import { UnpriceClientProvider, useUnpriceClient } from "@unprice/react"

function App() {
  return (
    <UnpriceClientProvider options={{ token: "unprice_public_token" }}>
      <UsageButton />
    </UnpriceClientProvider>
  )
}

function UsageButton() {
  const { client } = useUnpriceClient()

  return (
    <button
      onClick={() => {
        void client.events.ingest({
          customerId: "cus_123",
          eventSlug: "api_call",
        })
      }}
    >
      Track usage
    </button>
  )
}
```

## Buffered Usage Utility

`UsageBuffer` is a lightweight queue with batching and coalescing. It can buffer usage events during network instability or throughput spikes.

```ts
import { UsageBuffer } from "@unprice/react"

const buffer = new UsageBuffer({
  maxQueueSize: 5000,
  maxBatchSize: 200,
  flushIntervalMs: 1000,
  dropPolicy: "drop_oldest",
})

buffer.enqueue({
  featureSlug: "api-calls",
  usage: 1,
  action: "request",
  timestamp: Date.now(),
})

buffer.startAutoFlush(async (batch) => {
  return { accepted: batch.length, rejected: 0 }
})
```
