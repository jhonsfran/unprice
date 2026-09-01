# Analytics (Tinybird)

This package contains Tinybird datasources, pipes, endpoints, fixtures, and tests for billing and product analytics.

## Current architecture

- Source of truth: R2 raw lakehouse files.
- Tinybird role: billing and operational analytics.
- Durable Object flush writes to both Tinybird and R2.
- Buffered rows are deleted only after both sinks are confirmed.

## V2 schema direction

The current direction optimizes Tinybird cost and query latency:

- Billing usage dedup no longer relies on `FINAL` in endpoint SQL.
- Verification regions are queried from materialized views.
- Tinybird metadata ingestion from DO flush is disabled.
- Raw usage and verification datasources keep only billing/analytics-essential columns.
- Raw datasources have retention TTLs to limit storage cost.

## Tinybird resources

- Datasources: `internal/analytics/datasources/*.datasource`
- Materialized destinations: `internal/analytics/materializations/*.datasource`
- Materialization pipes: `internal/analytics/pipes/*.pipe`
- Endpoints: `internal/analytics/endpoints/*.pipe`
- Fixtures: `internal/analytics/fixtures/*`
- Tests: `internal/analytics/tests/*.yaml`

## How to test

Tinybird CI already runs:

- `tb build`
- `tb test run`

See `.github/workflows/job_tinybird_ci.yml`.

Local flow:

```bash
cd internal/analytics
tb build
tb test run
```

Add a new endpoint test:

```bash
cd internal/analytics
tb test create endpoints/<pipe_name>.pipe
```

Then edit `tests/<pipe_name>.yaml` and validate expected output.

## Migration and verification runbook

Before deploy:

```bash
cd internal/analytics
tb build
tb test run
tb deploy --check
```

Deploy uses cloud host/token in CI (`.github/workflows/job_tinybird_cd.yml`).

For incompatible schema changes:

- Add `FORWARD_QUERY` in datasource definitions.
- Use explicit defaults for removed columns.
- Deploy readers and endpoint changes first, then writers.

For this project, follow the detailed metering evolution guide:

- `apps/docs/concepts/pricing/schema-evolution.mdx`
