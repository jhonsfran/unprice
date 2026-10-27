# Billing and metering correctness evidence

Baseline commit: `f97570af4`.

Each regression asserts the intended behavior. The before and after results below were executed from isolated source copies. Some regression files also use contracts introduced by the fix. Do not treat an import failure from applying a complete final test file to old code as evidence of the billing defect. Dependency fakes isolate external I/O. SQL checks use isolated PostgreSQL and ClickHouse containers.

Sanitized original failure excerpts and passing summaries are committed in `billing-metering-proof-excerpts.txt`. They preserve the observed assertions after temporary test logs are removed.

## TLDR

All nine claims have a behavioral counterexample and a passing regression after the fix. The tests prove the stated cases. They do not prove the absence of every other billing defect.

| Issue | Observed incorrect result | Correct result |
| --- | --- | --- |
| 1 | Two daily buckets return 15 units and $5 | 40 units and $20 |
| 2 | Reverse event-time arrival bills one accepted unit | Both accepted units remain billable |
| 3 | Next-day max adds zero after a prior-day value of ten | Each reset period has its own raw aggregate |
| 4 | Negative corrections leave grant and wallet state inconsistent | Signed allocation, pricing, quantity, and capture state agree |
| 5 | Failed receivable settlement leaves the invoice paid | Retry can complete settlement without another charge |
| 6 | Ten accepted dollars become a permanent zero invoice | Sealed accepted totals produce one ten-dollar invoice |
| 7 | Advance usage is eligible before its late-event grace ends | Every row in the statement waits through grace |
| 8 | Failed refund lookup still shortens the paid period | The original period remains eligible for refund retry |
| 9 | Manual invoice sending requires a saved card | Only a new automatic charge requires that card |

## Issue 5: Preserve settlement retries

Verdict: VERIFIED.

Test: `internal/services/src/billing/service.collect.test.ts`, `retries settlement after failure`.

Command: `pnpm --filter @unprice/services test src/billing/service.collect.test.ts`.

Before: `Tests 3 failed | 14 passed (17)`. All three collection branches save `paid` after settlement fails. The test expects the original `waiting` or `unpaid` state and receives `paid`.

After: the three retry regressions pass. The invoice keeps its prior state after the first failure. Retry settles the receivable and saves `paid`. The provider receives at most one charge.

Adjacent verification: `pnpm --filter @unprice/services test src/billing/service.collect.test.ts src/billing/invoice-settlement.test.ts src/use-cases/billing/settle-invoice.test.ts`. Result: `Test Files 3 passed (3)`, `Tests 28 passed (28)`.

Independent review: issue 5 diff and before/after logs passed review. No new comments or correctness findings.

## Issue 8: Preserve refund retries

Verdict: VERIFIED.

Test: `internal/services/src/billing/service.generate-periods.test.ts`, `keeps a shortened paid period retryable when its ledger lookup fails`.

Before: `Tests 1 failed | 12 passed (13)`. The stored period end changed from `1775001600000` to `1773662400000` after the failed lookup. No refund was issued, and retry omitted the shortened period.

After: the failed lookup leaves the original period end and zero refund. Retry issues exactly `50_000_000` ledger minor units and shortens the period. The fake requires wallet adjustment to use the same transaction executor.

Command: `pnpm --filter @unprice/services test src/billing/service.generate-periods.test.ts src/billing/service.proration.test.ts`. Result: `Tests 21 passed (21)`.

Independent review: PASS. This regression proves transaction control flow with dependency fakes, not PostgreSQL rollback.

## Issue 9: Send invoices without a saved payment method

Verdict: VERIFIED.

Tests: `sends a manual invoice without a saved payment method` and `reconciles a paid provider invoice without a saved payment method` in `internal/services/src/billing/service.collect.test.ts`.

Command: `pnpm --filter @unprice/services test src/billing/service.collect.test.ts`.

Before: `Tests 4 failed | 17 passed (21)`. Manual sending and paid-provider reconciliation return the payment-method error instead of the expected `waiting` or `paid` result.

After: `Tests 21 passed (21)`. Payment-method validation applies only before a new automatic collection. Independent diff review passed.

## Issue 1: Rate each reset bucket

Verdict: VERIFIED.

Test: `billing across meter resets` in `internal/services/src/rating/service.extended.test.ts`.

Two daily buckets contain 15 and 25 units. Each day includes ten free units and charges one dollar per later unit. The expected statement contains 40 units and charges of `5.00` and `15.00`.

Before: `Tests 2 failed | 9 passed (11)`. The daily assertion is the defect proof. Production rating returned 15 units and only `5.00`. The mixed-cadence fixture also lacked the old analytics method; that fixture error is not evidence of a second production defect. The final mixed-cadence regression passes with the corrected recorded-usage contract.

The first revision passed sixteen rating tests. Independent review then proved another valid configuration. Billing on the 15th with resets on the 1st can start after the free tier is already consumed. Ten earlier free units plus five accepted paid units must yield five units and `5.00` in the partial billing window. Repricing those five units from zero returned `0.00`.

The final recorded-usage path sums accepted signed amounts and units from the same deduplicated fact tuple for every window, including a window wholly inside one reset bucket. Explicit usage overrides retain synthetic pricing. Currency and ledger scale must match the grant. Seven new rating/schema cases fail before this correction and all twenty-three rating cases pass after it. The actual ClickHouse row for the partial window contains five units and `500000000` at scale eight.

Deploy the new `v1_get_billing_usage_allocations` endpoint before the application reader. The final independent review is recorded below.

Final independent review: PASS. The reviewer reran both partial-window queries against ClickHouse and fed their actual rows to production RatingService. Both returned `5.00`. The complete eighteen-check SQL proof also passed independently.

## Issue 2: Preserve out-of-order usage in billing SQL

Verdict: VERIFIED.

`apps/api/src/ingestion/entitlements/billing-snapshot-proof.test.ts` runs the real processor. Two accepted events arrive in reverse timestamp order. Their snapshots contain one and two units. Replay returns the same fact.

`.audit/sql/prove-sql.py` renders the actual repository endpoint SQL and executes it in ClickHouse with the datasource's column types. It requires Python with Jinja2 and PyYAML, RTK, and a running Tinybird container. Set `BILLING_PROOF_CONTAINER` to its Docker name.

Before: `Failed checks 7`. The original SQL returns one unit for the actual processor output and for late sum/count and same-millisecond ordering cases.

After: `python3 .audit/sql/prove-sql.py` reports eighteen passing checks and `Failed checks 0`. The checks cover both billing endpoints, exact transport duplicates, max, latest, signed corrections, and accepted money for partial reset windows. A synthetic large-money check proves that Int128 aggregation preserves an unsafe total for rejection instead of wrapping it to zero. The processor regression also passes.

Independent review reran the same SQL proof and passed it. The archived synthetic processor output is `.audit/sql/processor-facts.ndjson`.

## Issue 7: Apply grace to period-end advance usage

Verdict: VERIFIED.

The two new regressions in `complex-pricing-cadence.integration.test.ts` execute the actual Drizzle repository against isolated PostgreSQL. They assert that advance-plan usage waits through the exact grace boundary and that shortening a phase also shortens its usage invoice time. Period-start fixed charges retain their invoice time.

Before: `Tests 2 failed | 7 skipped (9)`. Advance usage was eligible too early, and its capped invoice time stayed at the old cycle end.

After: `pnpm --filter @unprice/services test:integration:complex-pricing` passes all nine tests. The generation unit suite also passes all thirteen tests. Neon transport was restricted to the approved test proxy by `/private/tmp/unprice-billing-review/isolated-postgres.mjs`; no application database was used.

An additional reproducible PostgreSQL proof is available with `pnpm --filter @unprice/services exec vitest run --config vitest.readiness-proof.config.ts`. It requires the isolated `codex-billing-proof-postgres` container. It runs the generated repository queries against temporary tables inside a rollback transaction.

Independent review: PASS. The reviewer reran the PostgreSQL proof and checked the scheduler, exports, all migrated callers, and comments. No material findings.

The review then added a cross-phase statement case. The old phase has arrears usage and the next phase has a fixed advance charge with the same statement key. The per-phase predicate admitted the fixed phase before the usage grace ended. The actual PostgreSQL probe fails before this follow-up and passes after it. Readiness now checks every pending row under the same project, subscription, and statement key, regardless of phase. A future invoice time also blocks statement closure. Repository and scheduler use the same correlated predicate. Six scheduler tests pass. The permanent complex-pricing integration test also covers two sequential phases.

## Issue 3: Isolate raw aggregates by reset period

Verdict: VERIFIED.

`reset-scoped aggregation correctness` in `apps/api/src/ingestion/entitlements/processor.test.ts` sends 10 before midnight, 6 after midnight, a late 12 before midnight, and 8 after midnight. The literal expected deltas are 10, 6, 2, 2, with day totals 12 and 8. The cases exercise both max and latest through single and batch APIs, then replay a late event.

Before: `Tests 12 failed | 3 passed | 66 skipped (81)`. The first next-day max event adds zero, and the first next-day latest event produces a negative charge. The additional legacy-state regressions also fail.

After: `pnpm --filter api test src/ingestion/entitlements` passes all 129 tests. These tests run the real processor, aggregation engine, grant allocator, pricing, and replay logic with the transactional in-memory storage port.

The fix keys raw state and batch drafts by reset period. Existing unscoped history cannot prove the raw value for an overlapping period. Such a period rejects new events without state changes and requires reconciliation. Periods after the legacy watermark start at zero. Cached and staged replay receipts continue to work without reconstructing raw state.

Independent review: PASS after one additional batch defect was reproduced and fixed. Raw state now loads only after replay, active-grant, and closed-period checks. A valid new-period event succeeds beside a closed legacy event, which receives its normal denial. The reviewer ran twenty focused and independent cases. API type checking also passes.

## Issue 4: Apply negative corrections to grant and wallet accounting

Verdict: VERIFIED.

The correction cases in `apps/api/src/ingestion/entitlements/processor.test.ts` call the real single and batch processors. They assert returned signed facts, persisted raw and grant state, restored capacity, wallet amounts and quantities, and replay results. They include sum and latest, enforced and unenforced limits, overcorrection debt, multiple grants, and overage reversal.

Before: `pnpm --filter api test src/ingestion/entitlements/processor.test.ts -t 'correction|zero-price'` reports `Tests 32 failed | 81 skipped (113)`.

After: all 160 entitlement tests pass. The adjacent aggregation and grant-allocation suites also pass all 65 tests.

Unflushed `+10, -4, +4` finishes at ten units and ten dollars. A four-unit correction against ten units with seven already captured rejects the whole correction. Raw state, grants, and wallet remain unchanged. A three-unit correction remains valid. The same rule protects pending capture intents and retained closed-reservation totals. Zero-price cases verify that quantity watermarks receive the same protection. Rejected requests keep a stable `INVALID_AGGREGATION_PROPERTIES` receipt and a clear credit-workflow message. Reversing captured money requires a separate funded credit operation.

Independent review: PASS. The reviewer independently reran all thirty-two correction cases under the explicit Node 24.17.0 binary. API and services type checks also pass. No added comments or suppressions.

Two further review cases fail before their correction and pass after it. `wallet-correction-preflight.test.ts` runs a valid volume plan through real processor and alarm calls. Eleven units cost `1.10`; reversing to ten units would cost `8.90` more. The denied correction must preserve the closed wallet row and must not create a new hold. Both single and batch cases now do so.

`batch-correction-flush.test.ts` uses the default ten-dollar allocation. Uncommitted draft capture intent remains reversible. `+10, -4` captures exactly six dollars and six units. `+10, -4, +4` captures ten dollars and ten units. `+10, -10` makes no capture or refill call. All three cases fail before this follow-up and pass after it. Persisted capture intents retain their original sequence and payload. The final entitlement suite passes all 165 tests. Independent review reran eleven draft and persisted-intent cases under Node 24 and passed them.

## Issue 6: Close invoices from authoritative accepted totals

Verdict: VERIFIED.

Test: `billing accepted usage despite delayed reporting` in `internal/services/src/use-cases/billing/bill-period.test.ts`.

The regression runs the real entitlement processor and accepts ten units priced at ten dollars. Reporting is empty during the first billing attempt. Reporting contains the accepted usage before retry. The stateful invoice repository retains the period status across both attempts.

Before: `Tests 1 failed | 18 skipped (19)`. BILL saves zero and marks the period invoiced. Retry does not revisit that period. The literal monetary assertion expects `1_000_000_000` ledger minor units and receives `0`.

After: the same regression passes. The processor commits signed billing amounts and quantities in the same transaction as the accepted receipt. BILL reads a sealed durable snapshot, invoices ten dollars once, and acknowledges completion after the database commit. Trial periods explicitly invoice zero. Completion acknowledgement remains retryable after the invoice has committed.

Focused command: `pnpm --filter @unprice/services exec vitest run src/use-cases/billing/bill-period.test.ts -t 'delayed reporting.*normal.*false.*capture: null'`.

Five real Durable Object SQLite tests prove receipt/snapshot rollback, persistence across store reopen, seal enforcement, and receipt-cache invalidation after rollback followed by a real external-run retry. Single, batch, and external-run processor tests cover replay, missing coverage, signed corrections, and a seal that occurs during asynchronous wallet I/O. The commit checks the seal again after that I/O.

Additional review counterexamples fail before their fixes and pass after them. An expired entitlement owner still flushes its billed service window. A capped ten-dollar snapshot refuses closure with only six dollars captured, then succeeds after the remaining four dollars are captured. An uncapped period with six captured dollars and four ordinary dollars posts only four new receivable dollars. Paid, included, and credit-line captures reduce the remainder once. An eleven-dollar capture against a ten-dollar snapshot blocks closure. Capture reconciliation checks money; repeated quantity metadata across funding legs cannot independently prove a capture quantity total.

Period generation registers coverage before activation. Deterministic period IDs preserve registration across remote acknowledgement followed by database failure. Only a canonical new entitlement insert can write the server-owned genesis marker. Existing IDs, conflicting inserts, caller metadata, and recreated empty Durable Objects cannot infer legacy zero coverage. Open and sealed snapshots prevent object deletion. Completed snapshots remain through receipt replay retention.

The SQLite migration was generated with `bin/migrate.dev entitlements --name billing_usage_snapshots`. ADR-0007 records the ownership, retry, retention, and deployment contracts. Independent source review passed the final storage, processor, billing, owner selection, and capture changes.

## Operating limits

- Deploy the API worker, generated SQLite migration, and internal snapshot RPCs before services write genesis markers. Deploy the new analytics allocation endpoint before its reader.
- Existing unmarked entitlements and unknown legacy reset aggregates require explicit reconciliation. Missing data blocks new acceptance or invoice closure instead of becoming an inferred zero.
- Corrections cannot reverse captured or persisted pending money. Those reversals require a separate funded credit workflow.
- No deployment, push, production database write, or live Stripe operation was performed. Provider behavior is verified with fakes. The refund regression proves transactional control flow, not a live PostgreSQL rollback.

## Final verification

Node `24.17.0`, pinned pnpm `10.28.0`.

| Check | Result |
| --- | --- |
| Services unit suite | 122 files, 1,048 tests passed |
| API unit suite | 60 files, 581 tests passed |
| Worker suite, including real SQLite | 8 files, 63 tests passed |
| Isolated PostgreSQL financial matrix | 13 files, 33 tests passed |
| Actual ClickHouse endpoint SQL | 18 checks passed |
| Scheduler unit suite | 6 tests passed |
| Repository `pnpm validate` | Passed |
| API `pnpm --filter api type-check` | Passed |
| `git diff --check` | Passed |

The PostgreSQL matrix includes complex pricing cadence, advance and arrears metered/capped billing, concurrent billing, failure rollback, concurrent finalization, golden cases, phase proration, renewal wallets, paid invoice lifecycle, and monetization lifecycle. Existing financial assertions remain. Advance tests run after the grace boundary. Test-only recorded-usage builders replace the old analytics-only fixtures; production has no reporting fallback.

Validation reports an existing broken `.claude/skills/cloudflare-doctor` symlink. It exits successfully. No unrelated symlink change is included.

The PostgreSQL checks used a dedicated container and a Neon proxy on `127.0.0.1:15433`. An immutable `neonConfig.wsProxy` override pointed every test connection to `127.0.0.1:15433/v1?address=db:5432`. This is necessary because the normal integration configuration hardcodes a different database address. Do not run the database matrix against an application database.

## Commit index

All nine task commits are on `codex/billing-metering-correctness`.

| Issue | Commit |
| --- | --- |
| 1 | `e8d863b19` |
| 2 | `8e822c024` |
| 3 | `1c911fc41` |
| 4 | `535427304` |
| 5 | `111546bba` |
| 6 | Branch HEAD, `fix(billing): invoice sealed authoritative usage totals` |
| 7 | `3e388f4cd` |
| 8 | `087dfc6b4` |
| 9 | `20cdbffd2` |

The final autosquash changed only commit history. The tree before and after was `e63d9e66388ad509233529effa4953c8fb97f550`. Subsequent edits complete this evidence report and the decision trail.

## Independent trail review

GPT-6 Astra checked the decision trail against this workspace's active transcript, actual failure assertions, passing logs, and Git history. Final verdict: PASS. No evidence-integrity flags remain. The operating limits above remain relevant to rollout and captured-money reversals. The review used a distinct GPT model, not a different model family.

The three temporary test containers and their dedicated Docker network were removed after verification. Existing application containers were not changed.

## Principles that changed the implementation

- Model the Domain and Type System Discipline put billing identity and open/sealed/completed states in validated schemas.
- Fix Root Causes and Laziness Protocol put each fix in its owning service, processor, query, or storage boundary.
- Test Behavior, Not Implementation and Prove It Works required literal before/after outcomes and real PostgreSQL, ClickHouse, and Durable Object SQLite checks.
- Sequence Work into Verifiable Units kept one issue per commit. Separate Before Serializing Shared State kept reviewer snapshots separate and the root agent as the only Git writer.
- Build the Lever produced rerunnable SQL probes. Guard the Context Window assigned source partitions to independent reviewers and retained compact evidence in this report.
