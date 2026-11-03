# Billing and metering correctness review

## Workflow

- [x] Read the Principles section of the Poteto Mode skill.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

## Completion check

Each of the nine audit claims has a reproducible verdict. Each confirmed defect has a failing-before check, a passing-after check, and one fix commit on `codex/billing-metering-correctness`. Relevant tests and the repository validation pass, or the report names the exact external blocker. No deployments or production data changes are in scope.

## Units

1. Rating includes each reset window within a billing period.
2. Billing usage survives out-of-order facts and duplicate delivery.
3. Snapshot meters isolate reset windows.
4. Negative corrections update grant consumption and pricing.
5. Collection retries settle the receivable after failure.
6. Invoice close excludes incomplete reporting.
7. Advance-plan usage waits for the late-event window.
8. Refund failures preserve the ability to retry.
9. Manual collection works without a saved payment method.

## Execution

Review metering, rating, and invoice recovery in parallel with separate output paths. The root agent owns the Git index and applies each accepted task in sequence. Tests fail before production changes and pass after. One task commit includes its test, fix, and evidence record. This follows the user's requested commit shape.

At the throughput checkpoint, compare confirmed issues, completed proofs, validated fixes, and remaining unknowns. Stop treating the original audit wording as authoritative if the tests refute it.

## Validation

Use Node 24.17.0 and pinned pnpm 10.28.0. Restore dependencies offline first. Run focused Vitest tests, then package type checks and the complete repository validation. Keep evidence in `.audit/billing-metering-evidence.md` and decisions in `.audit/billing-metering-decisions.tsv`.

## Clean-rollout follow-up

The user clarified that backward compatibility is not required.

- [x] Remove legacy meter-state recovery and entitlement genesis metadata.
- [x] Keep explicit registration, reset isolation, receipt replay, sealing, retention, and capture guards.
- [x] Verify the simplified implementation and independent review.
- [x] Commit this follow-up once on the same branch.

## Final storage verification

- [x] Select the running Compose services and a dedicated PostgreSQL test database.
- [x] Run the actual ClickHouse billing SQL and PostgreSQL readiness probe.
- [x] Align database setup and the two advance property-test clocks with the tested contract.
- [x] Complete the full PostgreSQL integration suite on the final code.
- [x] Review and commit the final verification evidence.
