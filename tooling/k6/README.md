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

## Latency benchmark

The latency script measures the SDK round-trip time for each endpoint. It prints a percentile table
and one machine-readable `LATENCY_SUMMARY_JSON` line. This is a measurement harness, not a load
test. It has no latency thresholds, and it runs endpoints in sequence so they do not contend with
each other: warm-up, `access.check`, `usage.record`, then `usage.consume`.

```bash
pnpm --filter @unprice/k6 latency
```

Knobs (env or `.env`):

```env
RATE=20        # requests per second per scenario
DURATION=60s   # measured window per scenario ("60s", "2m")
FEATURE_SLUG=  # optional; defaults to the first usage-metered entitlement
```

The optional cold path signs up new customers and times their first check. This includes a new
Durable Object and a grant-context cache miss. It creates real
customers in the target project, so point it only at a disposable load-test project:

```env
COLD_SIGNUPS=20
PLAN_SLUG=pro
```

Run the same command against preview and production by switching `BASE_URL` and
`UNPRICE_TOKEN`. Latency depends on where the client runs: numbers from your laptop include
your last mile, so for publishable results run from a stable region (a small VM) and pair
every number with region + date + this harness. The claim boundaries in
`docs/brand/PRODUCT.md` forbid latency numbers in marketing copy until they come from a
reproducible run like this.

## Shared-run overspend proof

This manual/nightly-only scenario creates one shared run, then issues concurrent, uniquely
idempotent `usage.consume` attempts against it. Each decision must be either accepted or denied
with `insufficient_budget`; any other result fails the test.

Run it only with a funded, disposable customer and project. The final assertion reads the
authoritative run currency totals: consumed minor units must not exceed the budget and remaining
minor units must not be negative. It deliberately does not infer correctness from the number of
accepted requests, because one event can cost more than one currency minor unit.

```bash
BASE_URL=https://preview-api.unprice.dev \
UNPRICE_TOKEN=unprice_test_xxx \
PROJECT_ID=proj_loadtest \
CUSTOMER_ID=cus_loadtest \
BUDGET_AMOUNT=100 \
ATTEMPTS=200 \
VUS=10 \
corepack pnpm --filter @unprice/k6 overspend
```

The final output includes `OVERSPEND_SUMMARY_JSON` with the accepted, budget-denied, and
unexpected-failure counts plus the invariant result. Local verification is limited to
typechecking and bundling; running `overspend` sends requests to the configured target API.

## Ingestion failure test

The ingestion failure script sends valid usage events with the non-production failure-test header.
The API accepts the requests, and the queue consumer reports them as failed ingestion rows that the
Events UI can list.

Run it against a local or preview API where `APP_ENV !== "production"`:

```bash
pnpm --filter @unprice/k6 ingestion-failures
```

`EVENTS=1000` sends 1000 failure-test events for the first usage-metered entitlement discovered
for the customer. Recovery/replay is intentionally left to the frontend workflow.
