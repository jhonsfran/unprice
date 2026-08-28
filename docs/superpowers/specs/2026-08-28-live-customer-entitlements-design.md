# Live customer entitlements and empty analytics cache design

## Goal

Give customers an immediate view of active entitlement state while usage analytics continue to use
Tinybird. Prevent an empty analytics result from remaining in the server cache.

## Scope

- Add a public customer-wide endpoint for current active entitlements.
- Return every active entitlement. Include live Durable Object state for metered entitlements.
- Keep plan, billing-period, wallet, and historical analytics data on their current paths.
- Evict empty usage-dashboard results from the server cache.
- Keep the existing browser polling interval. Do not increase Tinybird query frequency.

## Public API

Add `POST /v1/access/entitlements/current` with SDK operation
`access.entitlements.current`.

The request accepts:

```ts
{
  customerId: string
  projectId?: string
}
```

Authentication and project access follow `access.entitlements.list`. The endpoint resolves the
request start time once and returns current state for that timestamp. It does not support historical
timestamps.

The response contains the customer ID, generation time, and one row for each active entitlement.
Each row contains stable display and configuration fields such as entitlement ID, feature slug,
feature title, feature type, unit of measure, and grant count.

An available row contains the current access decision and limit. Metered rows also contain live
usage, usage percentage, quota window, and priced spending when present. Static flat, tier, and
package rows contain their current allowance without a Durable Object call.

Each row uses an explicit status:

```ts
type CurrentEntitlementState =
  | {
      status: "available"
      allowed: boolean
      limit: number | null
      usage?: number
      usagePercent?: number
      quotaWindow?: QuotaWindow
      spending?: Spending
    }
  | {
      status: "unavailable"
    }
```

The endpoint does not cache its response.

## Service ownership and data flow

A service-layer operation owns the customer-wide current-entitlement flow. The Hono route handles
authentication, input validation, timing, and error mapping only.

The service operation:

1. Loads the customer's active entitlement and grant context once.
2. Builds one output row per active entitlement.
3. Computes static entitlement access and allowance from active grants.
4. Reads each metered entitlement's `EntitlementWindowDO` state in parallel.
5. Converts each failed Durable Object read into an unavailable row and logs the failure.
6. Returns successful rows together with unavailable rows.

The operation uses the existing backend-neutral entitlement-window client interface. Cloudflare
Durable Object routing remains in the API adapter.

## Dashboard integration

The customer overview continues to load plan, billing-period, wallet, and entitlement configuration
through its existing paths. A tRPC adapter calls the new public SDK operation and supplies its result
to the `Active entitlements` panel.

The panel renders:

- Static entitlement allowance from the new endpoint.
- Metered usage, limit, spend, and quota period from the Durable Object result.
- `Usage unavailable` for an entitlement whose Durable Object read failed.

The historical customer usage chart remains backed by Tinybird. The UI does not merge current quota
state into a selected historical interval.

The current 30-second refresh behavior remains unchanged.

## Empty analytics cache behavior

`getUsageDashboard` keeps the existing cache namespace and freshness policy. After a cached or loaded
result returns, the tRPC procedure checks whether it contains analytics evidence. Evidence means at
least one feature row, time-series row, or top-consumer row.

If the result has no evidence, the procedure removes that exact cache key before returning the empty
response. The next existing browser poll performs a cold Tinybird read. Non-empty results keep the
current stale-while-revalidate behavior.

This change does not alter browser polling, Tinybird ingestion, materialized views, or the analytics
cache duration for non-empty data.

## Error behavior

- Failure to load the customer entitlement context fails the endpoint.
- Failure to read one metered entitlement Durable Object does not fail the endpoint.
- A failed row never reports zero usage or denied access. It reports `status: "unavailable"`.
- The service logs each failed Durable Object read with project, customer, entitlement, and feature
  identifiers.
- Static entitlement rows remain available when a metered row fails.

## Verification

Tests will prove:

- Empty usage-dashboard results are removed from the exact server cache key.
- Non-empty usage-dashboard results remain cached.
- The service returns mixed static and metered entitlements.
- Metered Durable Object reads run through the entitlement-window client.
- One failed Durable Object read produces one unavailable row without removing successful rows.
- Authentication and project selection match existing public access endpoints.
- The OpenAPI contract exposes the new SDK operation.
- The tRPC adapter and customer panel render live and unavailable states.

## Out of scope

- Faster dashboard polling.
- Changes to Tinybird ingestion or materialization timing.
- Project-wide aggregation from Durable Objects.
- Replacing historical analytics with Durable Object state.
- Cache invalidation across every analytics interval after ingestion.
