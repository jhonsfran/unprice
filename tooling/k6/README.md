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

## Latency Benchmark

The latency script measures what an integrator's code observes — SDK call round-trip per
endpoint — and prints a percentile table plus one `LATENCY_SUMMARY_JSON` line for machines.
It is a measurement harness, not a load test: no latency thresholds, endpoints run
sequentially (warm-up → `access.check` → `usage.record` → `usage.consume`) so they never
contend with each other.

```bash
pnpm --filter @unprice/k6 latency
```

Knobs (env or `.env`):

```env
RATE=20        # requests per second per scenario
DURATION=60s   # measured window per scenario ("60s", "2m")
FEATURE_SLUG=  # optional; defaults to the first usage-metered entitlement
```

Cold path (optional): signs up brand-new customers and times their first check — a new
Durable Object plus a grant-context cache miss, the honest worst case. It creates real
customers in the target project, so point it only at a disposable load-test project:

```env
COLD_SIGNUPS=20
PLAN_SLUG=pro
```

Run the same command against preview and production by switching `BASE_URL` and
`UNPRICE_TOKEN`. Latency depends on where the client runs: numbers from your laptop include
your last mile, so for publishable results run from a stable region (a small VM) and pair
every number with region + date + this harness. The claim boundaries in
`docs/brand/PRODUCT.md` forbid latency numbers on marketing surfaces until they come from a
reproducible run like this.

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
