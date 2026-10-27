# Billing and metering branch quality review

Date: 2026-10-27. Branch: `codex/billing-metering-correctness`.
The review covers the branch from `f97570af4`. The quality changes start at `a37f26265`.

## Accepted findings and remedies

| Finding | Proof at review head | Remedy |
| --- | --- | --- |
| Batch preparation mixed provisional refill intent with persisted recovery fields. It also built facts twice and searched inputs again at commit. | `processor.ts` normalized pending wallet fields for each event. Preparation built facts twice; commit called `input.events.find` to recover timestamps. | Keep new draft refill intent separate, preserve persisted retry payloads, and carry ordered receipts with timestamps into commit. Build facts once. |
| BILL interleaved accepted-usage validation, fixed-price rating, capture reconciliation, and ledger posting. | `bill-period.ts` contained repeated usage branches and an `Ok([])` rating placeholder. | Resolve both sources into a `PeriodCharge`, then use one posting path. Keep charge proof and calculation in `period-charge.ts`. |
| Seal-before-flush was client orchestration rather than a server invariant. Production dependencies permitted silent omission. | The HTTP gateway called the seal endpoint before the flush endpoint. Services accepted an optional gateway and a production no-op existed. | The canonical server use case seals before any wallet or run flush. The HTTP client sends one request. Require the capability and keep the stub in test fixtures. |
| Integration fixtures obscured their dependencies and derived accepted usage from wallet captures. | `recorded-usage.ts` had two WeakMaps, a RatingService subclass, entrypoint wrappers, analytics mutation, rating calls, and ledger reads. | Return an explicit analytics/gateway bundle. Declare accepted quantity and money independently in each scenario. Test a $10 accepted total beside a $6 capture. |
| Added regression cases enlarged existing test files. | `bill-period.test.ts` crossed 1,000 lines. `processor.test.ts` gained 993 lines. | Extract focused accepted-usage, correction, reset, and wallet-boundary suites with shared fixtures. Preserve their cases and assertions. |
| A separate SQL driver duplicated the normal PostgreSQL harness. | The 272-line script, wrapper, and config monkeypatched the client, encoded raw SQL, replayed mutations, and used a partial schema. | Delete that driver. Keep readiness tests in the existing cadence suite and add two cap boundary cases using the full migrated schema. |

The common charge model was chosen over a snapshot-only helper because it removes repeated usage decisions from ledger posting. The explicit fixture bundle was chosen over another context wrapper because callers can see the dependency. A new generic period-owner repository was rejected. Its query scopes differ, and the shared time-overlap predicate already owns the relevant invariant.

## Review gates

The first BILL test split reached real Drizzle in eight accepted-usage cases because a helper-only mock loaded too late. Hoisted mocks in both test entry files fixed the harness. The next focused run passed all 33 cases.

Independent API review found a regression in the first batch refactor. A failed pending flush could be rebuilt with new event totals under the same sequence. The fix preserves its original amount, quantity, and refill while coalescing only new draft intent.

Both failed-capture and failed-extension cases reproduced the wrong $10 retry payload before the fix. They now retry the original $8 payload while the consumed total remains $10. The exact red and green outputs are retained in the verification log.

The final formatter converted constructor function mocks into arrow functions. The post-format service run caught 24 failures. Explicit class mocks now survive the same formatter and the full service suite passes. The API test split also omitted one direct harness import. That failure is agent-reported because its red log was overwritten. The restored import and successful 169-case entitlement run are directly verified.

The review deliberately keeps the existing processor's larger architecture. The accepted changes simplify the branch's added state handling; a full processor rewrite would add risk outside this task.

## Verification

The PostgreSQL checks use only `unprice_billing_quality_ed6f_20261027` through the existing Compose services. ClickHouse checks execute actual repository SQL with datasource column types and synthetic in-memory input in `tinybird-local`.

| File | At review head | Final lines |
| --- | ---: | ---: |
| `processor.ts` | 2,471 | 2,430 |
| `processor.test.ts` | 2,767 | 1,682 |
| `bill-period.ts` | 609 | 484 |
| `bill-period.test.ts` | 1,061 | 558 |
| `recorded-usage.ts` | 232 | 100 |
| HTTP reservation gateway | 201 | 155 |

The three extracted processor suites have 289, 256, and 468 lines. Their shared fixture has 109 lines. The accepted-usage BILL suite has 356 lines and its shared fixture has 236. The period-charge module has 152 lines.

Independent AST comparison retained all 73 processor test declarations and 253 assertions. The two new retry cases extend that coverage. All 424 existing integration matchers and all financial expectations remain. Seven reporting-call expectations change from one call to zero. All four property range, example, seed, and run configurations remain identical. The eight BILL accepted-usage cases remain; three funding assertions are combined into one object assertion, and completion retry gains a one-transfer assertion.

All checks below exited successfully on the final source. The final `pnpm validate` run applied no changes.

| Check | Final result |
| --- | --- |
| Services unit suite | 124 files, 1,053 tests passed |
| API unit suite | 63 files, 574 tests passed |
| Durable Object workers with real SQLite | 8 files, 63 tests passed |
| Jobs suite | 3 files, 13 tests passed |
| Full PostgreSQL integration suite | 28 files, 78 tests passed |
| Actual ClickHouse endpoint SQL | 18 checks passed, zero failures |
| `pnpm validate` | 29 tasks passed; formatting and checks passed |
| API typecheck | Passed |
| Baseline-to-final whitespace check | Passed |

[billing-metering-quality-verification.log](billing-metering-quality-verification.log) retains actual failure assertions and final summaries. The dedicated PostgreSQL database had zero open connections before cleanup and zero catalog rows after its scoped removal. The existing PostgreSQL, proxy, and Tinybird containers remain running. Validation reports the same pre-existing broken skill symlink warning and exits successfully.

The first three task commits are `bdd82f980` for explicit fixtures, `339ced0b5` for batch state and test decomposition, and `f8debaa38` for canonical invoice preparation and period charges. The final task replaces the readiness driver and commits this verification record. All remain on the same branch.

Independent source reviews covered each source partition and the preserved assertions. GPT-6 Astra checked the decision trail against the active workspace transcript and passed the final audit. No unresolved source or evidence-integrity findings remain. This was a distinct GPT model review; a different model family was unavailable. The overwritten API harness failure remains explicitly labelled as agent-reported.

## Reproduction

Use Node 24.17.0 and pnpm 10.28.0. Run the full PostgreSQL suite alone because the property cases have bounded time allowances.

```sh
rtk proxy pnpm --filter @unprice/services test
rtk proxy pnpm --filter api test
rtk proxy pnpm --filter api test:workers
rtk proxy pnpm --filter @unprice/jobs test
rtk proxy env BILLING_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/unprice_billing_quality_ed6f_20261027 pnpm --filter @unprice/services test:integration
rtk proxy env BILLING_PROOF_CONTAINER=tinybird-local python3 .audit/sql/prove-sql.py
rtk proxy pnpm validate
rtk proxy pnpm --filter api type-check
```

The integration harness creates and migrates the named test database. It truncates test tables between cases. Use a dedicated database. The SQL checks require Python with Jinja2 and PyYAML plus access to Docker.

Model the Domain led to the common period charge and separate draft refill intent. Minimize Reader Load led to explicit fixture dependencies and focused test files. Laziness Protocol removed the custom SQL driver and production no-op. Prove It Works required full suites and real PostgreSQL, ClickHouse, and SQLite execution.
