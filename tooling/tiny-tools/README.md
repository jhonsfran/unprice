# @unprice/tiny-tools

E2E test suite for the Unprice public API, `@unprice/api`. It runs against local, preview, or
production environments.

## Requirements

- A valid `UNPRICE_TOKEN` (project API token)
- A `CUSTOMER_ID` with an active subscription

## Setup

Copy the example file and set the values for the target environment:

```bash
cp tooling/tiny-tools/.env.example tooling/tiny-tools/.env
```

All commands load `tooling/tiny-tools/.env` when it exists. Variables set in the shell override
values from the file.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CUSTOMER_ID` | yes | none | Customer ID to run tests against (`cus_xxx`) |
| `UNPRICE_TOKEN` | yes | none | Project API token |
| `UNPRICE_API_URL` | no | `http://localhost:8787` | API base URL |
| `ONLY` | no | (all tests) | Comma-separated test name substrings to filter |

## Running tests

```bash
# Against local dev server
pnpm --filter @unprice/tiny-tools e2e:local

# Wallet-only checks
pnpm --filter @unprice/tiny-tools e2e:wallet:local

# Against a specific environment
UNPRICE_API_URL=https://api.unprice.dev pnpm --filter @unprice/tiny-tools e2e

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

### Plan tests

```bash
UNPRICE_TOKEN=unprice_dev_1234567890 CREDIT_LINE_POLICY=capped CREDIT_LINE_AMOUNT=10000 pnpm --filter @unprice/tiny-tools e2e:signup:local
UNPRICE_TOKEN=unprice_dev_1234567890 pnpm --filter @unprice/tiny-tools e2e:signup:local
```

## Test coverage

Tests run in sequence. Later tests reuse state from earlier tests. For example, ingestion tests use
the usage feature found during verification.

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

## Wallet E2E tests

`pnpm --filter @unprice/tiny-tools e2e:wallet:local` runs wallet-specific checks without sending usage. It requires a customer with at least one capped entitlement and verifies:

| Test | What it checks |
|---|---|
| `entitlements: customer has capped wallet-backed entitlement` | A capped entitlement exists, which means wallet-backed usage is expected |
| `wallet: returns current available balance` | `wallet.balance` returns display-ready `available` and `held` amounts |
| `wallet: credits reconcile to available balance` | Active credit availability does not exceed wallet availability |

## Budget E2E tests

`pnpm --filter @unprice/tiny-tools e2e:budget:local` walks one budget through every verb. It needs
only `UNPRICE_TOKEN`; it creates a fresh budget at `e2e:budget/run:<timestamp>` each run. Steps
share the budget and assert the exact balance each one leaves.

| Test | What it checks |
|---|---|
| `upsert: creates the budget` | Each limit is reported as `limit.added`; currency shorthand expands to `money:USD` |
| `upsert: the same definition changes nothing` | No changes, version stays 1 |
| `get: returns the definition and history` | Limits, hold settings, and a history array |
| `authorize: holds the estimate and replays by key` | Held amount and remaining; the same idempotency key returns the same hold |
| `settle: consumes the actual, returns the rest, replays` | covered, released, overrun; same amount replays, another amount is a 409 |
| `release: returns the whole hold, replays` | Releases the full hold; a second release replays |
| `charge: consumes once per idempotency key` | Replays by key; the same key with another amount is a 409 |
| `charge: decimal amounts stay exact` | `0.1 + 0.2` adds to exactly `0.3` |
| `spend: authorizes the estimate and settles the actual` | The SDK's `spend` helper settles what the callback returns |
| `soft limit: reports crossing without denying` | A soft limit appears in `crossed` and goes negative |
| `hard limit: denies with the blocking limit and remedy` | `raise_limit`, `wait_for_reset`, and `release_holds` remedies |
| `record: never denied, counted once per key and amount` | Pushes remaining negative; a retry with another `occurredAt` replays, another amount is a 409 |
| `errors: maps rejections to statuses` | Unknown hold 404, TTL over max 400, unit change 409, usage older than 24 hours 409, nine decimals 400, unknown budget 404 |
| `closesAt: stops new spend, keeps settle and record` | Authorize after close is 409 `budget_closed`; an open hold still settles; record still counts |

The hard limit is monthly, so a run that straddles a UTC month boundary fails its balance
assertions.

## Exit codes

- `0`: all tests passed
- `1`: one or more tests failed
