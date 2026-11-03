# Final billing and metering verification

Date: 2026-10-27.

This report records verification at `a37f26265`. The later code-quality review and its final verification are recorded in [billing-metering-quality-review.md](billing-metering-quality-review.md). Its normal integration harness replaces the historical readiness driver below.

The user requested PostgreSQL and ClickHouse checks on the final branch, using the running localhost Compose services.

Production code is unchanged from `7f55e2bf5`. This follow-up changes only test tooling, two property-test clocks and timeouts, and evidence files.

## Services and data

- PostgreSQL 15.6 runs in the existing `unprice-db-1` container. The integration suite uses the dedicated database `unprice_billing_final_ed6f_20261027` through the existing Compose Neon proxy on localhost port 5433.
- ClickHouse 25.8.28.2 runs in `tinybird-local`. The proof renders the actual repository endpoint SQL with the datasource column types and executes it through `clickhouse-local` with synthetic in-memory input. It does not publish or change Tinybird datasources.
- The readiness probe executes the actual generated repository SQL against temporary PostgreSQL tables inside `BEGIN` and `ROLLBACK`.
- No application database was selected. An initial setup attempt used the default `unprice_test` database while workers selected the new database, which did not yet exist. The shared test helper now applies `BILLING_TEST_DATABASE_URL` to both setup and workers. Later runs use only the dedicated database.

After verification, the dedicated test database had zero open connections and was removed. The existing PostgreSQL, proxy, and Tinybird containers remain running.

## Fixture corrections

The first full PostgreSQL run after aligning database setup passed 74 tests and failed two advance-billing property tests. Both called BILL at the cycle end and expected one processed phase, although the corrected contract waits through usage grace. Their literal result was zero processed phases.

Those two tests now call BILL at `feb1 + LATE_EVENT_GRACE_MS`. Fixed-charge clocks, statement windows, due dates, monetary assertions, generated ranges, explicit examples, run counts, and seeds are unchanged.

A subsequent database run overlapped the full unit and worker suites and hit the ten-second property-test limit. That run was interrupted, and its database connections were confirmed closed. The two tests now use the existing arrears capped-wallet property's twenty-second allowance. The final database run executes alone, with all generated cases retained.

Independent source review passed the database override, readiness arguments, test clocks, timeouts, unchanged financial assertions, and comment checks. No production change was needed.

## Final results

All checks exited successfully on the final source. The complete affected suites were rerun along with the requested storage checks.

| Check | Result |
| --- | --- |
| Full PostgreSQL integration suite | 27 files, 76 tests passed |
| Actual PostgreSQL readiness and phase-cap SQL | 1 test passed |
| Actual ClickHouse endpoint SQL | 18 checks passed, zero failures |
| Services unit suite | 122 files, 1,044 tests passed |
| API unit suite | 60 files, 572 tests passed |
| Durable Object worker suite, including real SQLite | 8 files, 63 tests passed |
| Jobs suite | 3 files, 13 tests passed |
| `pnpm validate` | 29 tasks passed; formatting and checks passed |
| API type checking | Passed |
| Baseline-to-final whitespace check | Passed |

The PostgreSQL suite includes all four billing property files, financial ledger operations, wallet funding and expiration, phase changes, invoice collection and webhook retries, billing concurrency, statement grace, and project cascades. The generated cases retain their default run counts and explicit examples.

`billing-metering-final-verification.log` preserves the actual final summaries, ClickHouse outputs, readiness result, and the earlier property-fixture failure assertions. Repository validation still reports the existing broken `.claude/skills/cloudflare-doctor` symlink and exits successfully.

Independent trail review by GPT-6 Astra passed. It checked the actual results, unchanged financial assertions, generated cases, interrupted run, test-database cleanup, and existing container state. No new evidence-integrity flags remain. The fresh-state rollout contract still applies. This was a distinct-model GPT review, not a different model family.

## Reproduction

Run from the repository root with Node 24.17.0 and pnpm 10.28.0.

```sh
rtk proxy env BILLING_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/unprice_billing_final_ed6f_20261027 pnpm --filter @unprice/services test:integration
rtk proxy env BILLING_PROOF_CONTAINER=tinybird-local python3 .audit/sql/prove-sql.py
```

The integration suite creates and migrates its named test database. It truncates that database's test tables between cases. Use a dedicated database name. The SQL proof requires Python with Jinja2 and PyYAML, plus access to the running Docker containers.

Prove It Works required execution against PostgreSQL, ClickHouse, and Durable Object SQLite. Build the Lever made database and container selection explicit so the existing proofs can run against Compose services.
