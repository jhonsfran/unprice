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
```

## Run

```bash
pnpm --filter @unprice/k6 baseline
```

`EVENTS=1000` means at least 1000 `/v1/events/ingest` calls. If the customer has multiple distinct
usage event slugs, the run sends `EVENTS * eventSlugCount` async usage events.

The script also verifies every active entitlement on every iteration. Usage and verification
requests are sent in parallel with `http.batch()`.
