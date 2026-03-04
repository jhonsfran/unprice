# @unprice/react

DX-first React bindings for Unprice realtime entitlements.

This package is tokenless in the browser path: you do not pass Unprice API keys to `UnpriceProvider`.

## Installation

```bash
npm install @unprice/react
# or
yarn add @unprice/react
# or
pnpm add @unprice/react
```

## Quickstart

Set up everything in a single `UnpriceProvider` using a server-issued realtime ticket.

```tsx
import { UnpriceProvider } from "@unprice/react"

function App() {
  return (
    <UnpriceProvider
      realtime={{
        customerId: "cus_123",
        projectId: "proj_123",
        initialTicket: {
          ticket: "initial-realtime-ticket",
          expiresAt: 1735689600,
        },
        getRealtimeTicket: async ({ customerId, projectId, reason }) => {
          const response = await fetch("/api/unprice/realtime-ticket", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ customerId, projectId, reason }),
          })

          if (!response.ok) {
            throw new Error("Failed to refresh realtime ticket")
          }

          return await response.json()
        },
      }}
    >
      {/* Your app components */}
    </UnpriceProvider>
  )
}
```


## Auto Mode (recommended)

Use `mode: "auto"` to apply opinionated defaults for refresh timing, snapshot retries, and event buffer sizing.

```tsx
<UnpriceProvider
  realtime={{
    mode: "auto",
    customerId: "cus_123",
    projectId: "proj_123",
    getRealtimeTicket,
  }}
>
  <App />
</UnpriceProvider>
```

## Realtime Stream Mode

Choose what each provider instance subscribes to:

- `all` (default): usage/verification events + alerts
- `events`: usage/verification events only
- `alerts`: alerts only

```tsx
<UnpriceProvider
  realtime={{
    customerId: "cus_123",
    projectId: "proj_123",
    getRealtimeTicket,
    stream: "alerts",
  }}
>
  <App />
</UnpriceProvider>
```

Typical split:

- App root provider: `stream: "alerts"` to listen for limit-reached notifications globally.
- Realtime/debug page provider: `stream: "events"` or `stream: "all"` where live activity is needed.

## Realtime Snapshot Model

The realtime snapshot sent to the SDK includes:

- `subscription`: active subscription/phase details for the customer
- `entitlements`: active entitlements for the customer
- `usageByFeature` and `features`: current usage/limits from durable object state

This means your panel can render subscription status, entitlement list, and current cycle usage from one realtime source.

## Build a Customer Realtime Panel

```tsx
import { useUnpriceEntitlementsRealtime, useUnpriceUsage } from "@unprice/react"

export function CustomerRealtimePanel() {
  const { subscription, socketStatus, refreshSnapshot, alerts } = useUnpriceEntitlementsRealtime()
  const { rows } = useUnpriceUsage({ scope: "entitlements" })

  return (
    <section>
      <h2>Realtime</h2>
      <p>Status: {socketStatus}</p>
      <p>Plan: {subscription?.planSlug ?? "No active plan"}</p>

      <button onClick={refreshSnapshot}>Refresh snapshot</button>

      <h3>Entitlements</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.featureSlug}>
            {row.featureSlug}: {row.isFlatFeature ? "Flat feature" : `${row.usage ?? 0} / ${row.limit ?? "∞"}`}
          </li>
        ))}
      </ul>

      <h3>Recent alerts</h3>
      <ul>
        {alerts.slice(0, 5).map((alert) => (
          <li key={`${alert.at}-${alert.featureSlug}-${alert.alertType}`}>
            {alert.featureSlug} - {alert.alertType}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

## Listen for Limit Alerts

```tsx
import { UnpriceProvider } from "@unprice/react"

function App() {
  return (
    <UnpriceProvider
      realtime={{
        customerId: "cus_123",
        projectId: "proj_123",
        getRealtimeTicket,
        onAlertEvent: (event) => {
          if (event.alertType === "limit_reached") {
            // Open paywall, toast, or trigger in-app CTA
          }
        },
      }}
    >
      <YourApp />
    </UnpriceProvider>
  )
}
```

## Feature Checks

### `useFeature`

```tsx
import { useFeature } from "@unprice/react"

function EditorFeature() {
  const feature = useFeature({ slug: "advanced-editor" })

  const onOpenEditor = async () => {
    const result = await feature.check({ action: "open-editor" })
    if (!result.allowed) return
    // open editor
  }

  return (
    <div>
      <p>Entitled: {String(feature.entitled)}</p>
      <p>Usage: {feature.usage ?? 0}</p>
      <button disabled={feature.isChecking} onClick={onOpenEditor}>
        Open editor
      </button>
    </div>
  )
}
```

### `FeatureGate`

```tsx
import { FeatureGate } from "@unprice/react"

function EditorRoute() {
  return (
    <FeatureGate slug="advanced-editor" fallback={<UpgradeModal />}>
      <AdvancedEditor />
    </FeatureGate>
  )
}
```

### `useCheckFeature`

Use this when you want to validate many feature slugs from one place.

```tsx
import { useCheckFeature } from "@unprice/react"

function FeatureAction() {
  const { check, isChecking } = useCheckFeature()

  const onClick = async () => {
    const result = await check({
      slug: "export-pdf",
      action: "export",
    })

    if (!result.allowed) {
      return
    }
  }

  return <button disabled={isChecking} onClick={onClick}>Export PDF</button>
}
```

### `useUnpriceUsage`

Use this to render usage rows for the current billing cycle from realtime snapshots.

```tsx
import { useUnpriceUsage } from "@unprice/react"

function EntitlementsUsageList() {
  const { rows } = useUnpriceUsage()

  return (
    <ul>
      {rows.map((row) => (
        <li key={row.featureSlug}>
          <strong>{row.featureSlug}</strong>{" "}
          {row.isFlatFeature
            ? "Flat feature"
            : row.hasLimit
              ? `${row.usage ?? 0} used of ${row.limit}`
              : `${row.usage ?? 0} used`}
        </li>
      ))}
    </ul>
  )
}
```

## Advanced APIs

- `UnpriceEntitlementsRealtimeProvider`
- `useUnpriceEntitlementsRealtime`
- `useUnpriceUsage`
- `useEntitlement`
- `useValidateEntitlement`
- `EntitlementRealtimeFeature`
- `EntitlementValidationListener`

## Security

- Do not expose root API keys in client code.
- Issue short-lived realtime tickets from your backend.
- Implement `getRealtimeTicket` in your app server and let the provider handle refresh/reconnect lifecycle.


## Buffered Usage Utility (high-throughput / flaky network)

`UsageBuffer` is a lightweight client-side queue with batching and coalescing. It can be used to buffer usage events when the websocket is disconnected or when throughput spikes.

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
  // deliver batch via websocket or HTTP fallback
  return { accepted: batch.length, rejected: 0 }
})
```

