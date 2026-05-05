# @unprice/tiny-tools

E2E test suite for the Unprice public API (`@unprice/api`). Runs against any environment — local, preview, or production.

## Requirements

- A valid `UNPRICE_TOKEN` (project API token)
- A `CUSTOMER_ID` with an active subscription

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CUSTOMER_ID` | yes | — | Customer ID to run tests against (`cus_xxx`) |
| `UNPRICE_TOKEN` | yes | — | Project API token |
| `UNPRICE_API_URL` | no | `http://localhost:8787` | API base URL |
| `ONLY` | no | (all tests) | Comma-separated test name substrings to filter |

## Running tests

```bash
# Against local dev server
CUSTOMER_ID=cus_xxx UNPRICE_TOKEN=xxx pnpm --filter @unprice/tiny-tools e2e:local

# Against a specific environment
CUSTOMER_ID=cus_xxx UNPRICE_TOKEN=xxx UNPRICE_API_URL=https://api.unprice.dev pnpm --filter @unprice/tiny-tools e2e

# Using infisical for secrets (preview env)
pnpm --filter @unprice/tiny-tools with-env pnpm e2e:local
```

### Run only specific tests

`ONLY` matches against test names (case-insensitive substring):

```bash
# Run only ingestion tests
CUSTOMER_ID=cus_xxx UNPRICE_TOKEN=xxx ONLY=ingestion pnpm --filter @unprice/tiny-tools e2e:local

# Run sync and idempotency tests
CUSTOMER_ID=cus_xxx UNPRICE_TOKEN=xxx ONLY=sync,idempotency pnpm --filter @unprice/tiny-tools e2e:local
```

## Test coverage

Tests run sequentially. Later tests reuse state discovered in earlier ones (e.g. the usage-based feature found during verification is reused for all ingestion tests).

| Test | What it checks |
|---|---|
| `subscription: is active` | Subscription exists with status `active` or `trialing` |
| `entitlements: fetches list` | Customer has at least one entitlement |
| `verification: verify all entitlements` | All features return valid shape; discovers usage-based feature for ingestion tests |
| `sync-ingestion: ingest and verify usage delta` | `ingestSync` → verify; asserts usage changed correctly per aggregation method |
| `async-ingestion: ingest and poll` | `ingest` (async) → polls `verify` up to 10s for eventual consistency |
| `idempotency: duplicate key deduplicated` | Same `idempotencyKey` sent twice; usage increments only once |
| `limit-enforcement: sync rejects at limit` | Pushes usage over the limit; confirms `LIMIT_EXCEEDED` rejection (skips if no limit or too far from limit) |
| `analytics: getUsage returns data` | `getUsage` returns records for the last 24h |
| `verification: non-existent feature` | Fake feature slug returns `feature_missing` or API error |
| `verification: non-existent customer` | Fake customer ID returns `customer_not_found`, `feature_missing`, or API error |

Ingestion tests (`sync-ingestion`, `async-ingestion`, `idempotency`, `limit-enforcement`) are automatically skipped if the customer has no usage-based features or the wallet is not funded for priced usage (`WALLET_EMPTY`).

## Exit codes

- `0` — all tests passed
- `1` — one or more tests failed
