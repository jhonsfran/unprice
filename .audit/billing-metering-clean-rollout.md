# Billing clean-rollout follow-up

Date: 2026-10-27.

The subsequent `billing-metering-final-verification.md` report records the PostgreSQL and ClickHouse reruns requested after this cleanup.

The user clarified that backward compatibility is not required. This follow-up simplifies the original nine fixes on the same branch. It does not change their correctness requirements.

## Removed

- Recurring meters no longer read an old unscoped value or classify it by a legacy timestamp watermark.
- Entitlement creation no longer writes `billing_usage_genesis_v1` metadata.
- Billing registration no longer carries or checks a genesis marker. The marker module, exports, fixtures, and marker-only tests were removed.
- Migration-only meter tests were removed. Ordinary replay, staged duplicate, and closed-period tests remain with fresh-state fixtures.

## Retained

- Recurring raw aggregates remain keyed by reset period. Onetime meters retain their canonical key.
- Periods register before activation and subscription usage acceptance. Stable IDs preserve registration retries after ambiguous database failure.
- Missing registered snapshots block acceptance and invoicing. Receipt replay does not add usage again.
- Sealing, accepted totals, atomic receipt writes, snapshot retention, and captured-money guards remain unchanged.

## Rollout contract

Use fresh entitlement IDs, Durable Object state, and matching billing periods. Disable old accepting code during cutover. Existing entitlement state is outside the supported contract. This task does not delete or deploy data.

## Verification

Node 24.17.0 and pnpm 10.28.0.

| Command | Result |
| --- | --- |
| `pnpm --filter @unprice/services test` | 122 files, 1,044 tests passed |
| `pnpm --filter api test` | 60 files, 572 tests passed |
| `pnpm --filter api test:workers` | 8 files, 63 tests passed |
| `pnpm validate` | Passed |
| `pnpm --filter api type-check` | Passed |
| `git diff --check` | Passed |

The count decreased by four service tests and nine API tests. Those cases checked the removed marker and legacy migration behavior. No correctness regression from the original nine findings was removed.

The worker suite first failed to open a sandboxed localhost listener. It passed when rerun with the required listener access. No containers were started for this follow-up.

Repository validation reports the existing broken `.claude/skills/cloudflare-doctor` symlink. It exits successfully. Its only source fix removed a now-unused import from the changed processor tests.

Independent source review passed 115 processor/snapshot tests and 44 service tests under Node 24. It checked reset/onetime key selection, receipt-first replay, registration retries, missing coverage, seals, retention, and capture guards. The comment review passed.

The prior 33 PostgreSQL tests and 18 ClickHouse checks remain recorded in the original evidence. They were not rerun for this follow-up. Billing readiness, analytics endpoint SQL, and financial ledger queries are unchanged.

Subtract Before You Add removed compatibility machinery before considering new logic. Prove It Works required the full affected suites and real SQLite checks after removal.

Independent trail review by GPT-6 Astra passed. It checked the user's clarified scope, actual diff, logs, historical checks, and decision trail. No evidence-integrity flags remain. This was a distinct-model GPT review, not a different model family.

## Captured run summaries

The following lines come from the actual follow-up logs.

```text
clean-rollout-services.log
 Test Files  122 passed (122)
      Tests  1044 passed (1044)

clean-rollout-api.log
 Test Files  60 passed (60)
      Tests  572 passed (572)

clean-rollout-workers.log
 Test Files  8 passed (8)
      Tests  63 passed (63)

clean-rollout-validate.log
 Tasks:    29 successful, 29 total
Formatted 1761 files in 154ms. No fixes applied.
Checked 1761 files in 483ms. Fixed 1 file.

clean-rollout-api-typecheck.log
> api@ type-check /Users/jhonsfran/.codex/worktrees/ed6f/unprice/apps/api
> pnpm exec tsc --noEmit

```
