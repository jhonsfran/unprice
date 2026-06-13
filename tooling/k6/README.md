# @unprice/k6

Simple load test for one project and one customer.

The script reads active entitlements from `/v1/entitlements/get`, builds async usage calls from
the entitlement meter configs, and verifies every entitlement. If multiple meters share the same
`eventSlug`, the script sends one event with all required aggregation properties.

## Setup

```bash
cp tooling/k6/.env.example tooling/k6/.env
```

Required variables:

```env
UNPRICE_TOKEN=unprice_test_xxx
BASE_URL=http://localhost:8787
PROJECT_ID=proj_xxx
CUSTOMER_ID=cus_xxx
EVENTS=1000
REPLAY_AUTO_REPLAY=false
REPLAY_EVENT_SLUG=
REPLAY_POLL_INTERVAL_MS=1000
REPLAY_POLL_TIMEOUT_MS=60000
REPLAY_WINDOW_MS=300000
```

## Run

```bash
pnpm --filter @unprice/k6 baseline
```

This command builds `baseline.js` and runs k6 through Docker with `tooling/k6/.env`.
Run it only from a trusted local shell that has Docker access and a non-production
test token/customer using the required variables from the setup section.

`EVENTS=1000` means at least 1000 `/v1/events/ingest` calls. If the customer has multiple distinct
usage event slugs, the run sends `EVENTS * eventSlugCount` async usage events.

The script also verifies every active entitlement on every iteration. Usage and verification
requests are sent in parallel with `http.batch()`.

## Replay Failure Test

The replay failure script creates a real failed ingestion row that the Events UI can list and
replay. It sends a valid usage event with the non-production failure-test header, then polls
`/v1/analytics/ingestion/status` until a `state=failed`, `replayable=true` row appears.

Run it against a local or preview API where `APP_ENV !== "production"`:

```bash
pnpm --filter @unprice/k6 replay-failure
```

By default the script stops after printing the `canonicalAuditId`, so you can replay that failed
row from the Events UI. To verify the API replay path too:

```bash
REPLAY_AUTO_REPLAY=true pnpm --filter @unprice/k6 replay-failure
```

Set `REPLAY_EVENT_SLUG` when the customer has multiple usage event slugs and you want a specific
metered event.
