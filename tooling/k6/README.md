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
usage event slugs, the run sends `EVENTS * eventSlugCount` reported usage events.

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
BUDGETS=1      # optional; adds budgets.authorize then settle, charge, record, and get
```

With `BUDGETS=1`, setup creates one budget (`k6-latency:<timestamp>`, closing after a day, so it
deletes itself 7 days later) and times each verb against it after the usage scenarios. A spend
scenario's rate counts authorize-then-settle pairs. The API's `Server-Timing` header carries a
`budget` mark: the round trip to the budget's Durable Object, apart from key auth and the Worker.

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

## Budgets: concurrency, accuracy, and latency

`budgets.ts` load-tests the budget primitive (`/v1/budgets/*`). It needs only `UNPRICE_TOKEN` and
`BASE_URL`: setup creates fresh budgets under `k6:budgets/<timestamp>`, so runs never share state.

```bash
pnpm --filter @unprice/k6 budgets
```

Two scenarios run at a fixed arrival rate:

| Scenario | Traffic | Budget |
|---|---|---|
| `gated` | 55% authorize→settle (actual ≤ estimate), 15% authorize→release, 30% charge | `KEYS` budgets, each with one hard lifetime limit of `LIMIT` |
| `recorded` | record at `RECORD_RATE`/s | its own budget with a 1-unit limit, which record runs past |

Amounts are random multiples of 0.0001 up to 1. `DUPLICATE_PERCENT` of the final writes (settle,
release, charge, record) go out twice in one `http.batch`, the way a client retry races its
original. With the defaults, the budget runs out about halfway through the run, so admits and
denials race on the same counter.

What fails the run (exit 99):

| Property | Check |
|---|---|
| Accuracy | `budget_drift_ticks == 0`: every applied amount adds to it, and teardown subtracts what each budget consumed. Any lost or double-counted amount leaves it non-zero. |
| Idempotency | Of the copies that succeed, exactly one applies and the rest replay it. |
| Concurrency | Teardown: no hard limit consumed past its amount, no hold left open, remaining = limit − consumed. |
| Decisions | Every answer is a 200 or a 402 that names the limit with a remedy a lifetime limit allows. Anything else counts in `budget_unexpected`. |
| Latency | `p(95) < P95_MS` and `p(99) < P99_MS` for each verb, from `http_req_duration{name:POST /v1/budgets/<verb>}`. |

Knobs (env or `.env`):

```env
RATE=50              # gated iterations per second
DURATION=30s
VUS=50               # pre-allocated VUs for gated
KEYS=1               # 1 = every request contends on one budget; raise to spread over budgets
LIMIT=200            # hard lifetime limit per gated budget, in whole units
RECORD_RATE=5        # record requests per second; 0 disables the scenario (default RATE/10)
DUPLICATE_PERCENT=10
P95_MS=500
P99_MS=1500
```

Measure the hot path with `KEYS=1`: every request then serializes through one Durable Object.
Raise `KEYS` to measure throughput across budgets; `LIMIT` is per budget, so scale it down to keep
the budgets running out mid-run.

Against a local `wrangler dev` through Docker Desktop, k6 can reuse a pooled keep-alive connection
the server already closed, and that request fails with `EOF` (status 0, counted as unexpected).
Set `K6_NO_CONNECTION_REUSE=true` for local runs; keep reuse on for preview and production.

## Production plan, customer, and test runner

The production runner owns an isolated test project. It refuses to change a project that contains
plans, events, or features other than its load-test configuration.

Add these values to `tooling/k6/.env`:

```env
BASE_URL=https://api.unprice.dev
PROJECT_ID=proj_xxx
UNPRICE_CONFIG_TOKEN=unprice_config_xxx
UNPRICE_TOKEN=unprice_live_xxx
CONFIRM_PRODUCTION_LOAD_TEST=yes

EVENTS=1000
RATE=20
DURATION=60s
INGESTION_TIMEOUT_SECONDS=600
```

Journal history can take 3 to 7 minutes to appear. The default reconciliation timeout is
600 seconds. Live usage checks do not need this wait.

The configuration token creates draft pricing. The runtime token signs up the customer and sends
usage. The API does not allow one token type to do both jobs.

Run the same command for both phases:

```bash
nvm use
corepack pnpm --filter @unprice/k6 load-test:production
```

The first run creates or reuses the `load-test-pro` draft and prints its review URL. It stops before
customer signup. Publish the draft in the dashboard, then run the command again. The second run
creates separate customers for `latency` and `baseline`, then verifies ingestion only for the
baseline customer. It fails when events are missing after the timeout, rejected, or failed.
