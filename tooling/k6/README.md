# @unprice/k6

Simple load test for one project and one customer.

The scripts use the TypeScript SDK with a k6 fetch adapter. They read active entitlements through
`access.entitlements.list`, build usage calls from entitlement meter configs, and verify
entitlements through `access.check`.

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
```

## Run

```bash
pnpm --filter @unprice/k6 baseline
```

This command builds `baseline.js` and runs k6 through Docker with `tooling/k6/.env`.
Run it only from a trusted local shell that has Docker access and a non-production
test token/customer using the required variables from the setup section.

`EVENTS=1000` means at least 1000 `usage.record` calls. If the customer has multiple distinct
usage event slugs, the run sends `EVENTS * eventSlugCount` async usage events.

The script also verifies every active entitlement on every iteration. Usage and verification
requests are sent through SDK methods so API contract drift is caught by TypeScript before k6 runs.

## Ingestion Failure Test

The ingestion failure script sends valid usage events with the non-production failure-test header.
The API accepts the requests, and the queue consumer reports them as failed ingestion rows that the
Events UI can list.

Run it against a local or preview API where `APP_ENV !== "production"`:

```bash
pnpm --filter @unprice/k6 ingestion-failures
```

`EVENTS=1000` sends 1000 failure-test events for the first usage-metered entitlement discovered
for the customer. Recovery/replay is intentionally left to the frontend workflow.
