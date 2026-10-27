# Branch code-quality review

Baseline: `f97570af4`. Review head: `a37f26265`.

## Workflow

- [x] Ground the branch changes and measure file growth.
- [x] Compare structural remedies and choose only material improvements.
- [x] Implement each accepted remedy with behavior preserved.
- [x] Verify focused checks, complete affected suites, and real storage checks.
- [x] Complete independent source and trail review, then commit each task on the same branch.

## Scope

Review the full billing and metering branch. Preserve the nine proved correctness fixes and the fresh-state rollout contract. Backward compatibility remains out of scope. Prefer deletion and explicit data flow over new wrappers or generic frameworks.

The root owns BILL and its tests. Independent reviewers cover API metering, service billing/rating, and test-fixture architecture. Reviewers propose competing structures before implementation. The root owns Git and validation. Any delegated edits must have disjoint file ownership.

## Measured concerns

- `bill-period.test.ts` grew from 762 to 1,061 lines and crosses the skill's 1,000-line threshold.
- `processor.test.ts` grew from 1,774 to 2,767 lines, adding 993 lines to an existing large file.
- `processor.ts` grew from 2,270 to 2,471 lines. Review added conditional state handling rather than decomposing unrelated existing code.
- BILL mixes snapshot proof, fixed-charge rating, capture reconciliation, and invoice orchestration. Compare a common resolved-charge model with a narrow snapshot-validation extraction.
- The recorded-usage test fixture uses two WeakMaps, a RatingService subclass, and a BILL wrapper to recover an implicit dependency. Compare an explicit fixture bundle with a small fixture context method.

## Throughput checkpoint

Count accepted structural findings, fixed units, preserved behavioral assertions, and verified units. Reject findings that only move complexity or replace direct code with shallow layers. Commit one accepted unit at a time after verification.

Six findings were resolved in four task units. The final source passes 1,053 service, 574 API, 63 worker, 13 job, and 78 PostgreSQL tests plus 18 ClickHouse checks. Source reviewers confirmed preserved financial assertions and property configurations. The final validation applies no changes. Independent source and trail audits passed. This record is committed with the final proof-harness task.
