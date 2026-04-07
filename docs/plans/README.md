# Plans

This folder groups execution plans and agent-facing breakdowns for work that is
too large to keep in a single document.

## How To Use These Docs

1. Start with the source plan when you need the full roadmap and progress
   tracking.
2. Use the phase docs in this folder when you want a single implementation
   phase broken into a concrete execution brief for an implementation agent.
3. Keep the original phase numbering when reporting progress back to the source
   plan.

The source implementation plan remains in
[../unprice-implementation-plan.md](../unprice-implementation-plan.md). It
already has local edits in the current worktree, so these split docs are
companion plans rather than a rewrite of the source file.

## Source Plan Docs

| Document | Purpose |
| --- | --- |
| [../unprice-implementation-plan.md](../unprice-implementation-plan.md) | Master roadmap for unified billing, rating, ledger, settlement, and agent billing |
| [../unprice-payment-provider-plan.md](../unprice-payment-provider-plan.md) | Existing provider-specific planning notes |
| [../unprice-unified-billing-plan.md](../unprice-unified-billing-plan.md) | Existing unified billing planning notes |
| [../testing-priority-services-use-cases.md](../testing-priority-services-use-cases.md) | Service and use-case testing priorities |

## Unprice Unified Billing Phase Docs

| Phase | Execution Doc | Depends On |
| --- | --- | --- |
| 1 | [./unprice-phase-01-rating-service.md](./unprice-phase-01-rating-service.md) | None |
| 2 | [./unprice-phase-02-provider-data-foundation.md](./unprice-phase-02-provider-data-foundation.md) | None |
| 3 | [./unprice-phase-03-provider-runtime-refactor.md](./unprice-phase-03-provider-runtime-refactor.md) | Phase 2 |
| 4 | [./unprice-phase-04-ledger-foundation.md](./unprice-phase-04-ledger-foundation.md) | Phase 1 |
| 5 | [./unprice-phase-05-settlement-webhooks.md](./unprice-phase-05-settlement-webhooks.md) | Phases 2, 3, 4 |
| 6 | [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md) | Phases 1, 3, 4 |
| 7 | [./unprice-phase-07-trace-aggregation.md](./unprice-phase-07-trace-aggregation.md) | Phase 6 |

## Parallel Tracks

- Track A: Phase 1 -> Phase 4
- Track B: Phase 2 -> Phase 3 -> Phase 5
- Track C: Phase 6 after Phases 1, 3, and 4
- Optional: Phase 7 only if trace-level billing is needed after Phase 6

## Shared Guardrails

- Do not introduce a second pricing implementation outside
  `@unprice/db/validators/subscriptions/prices.ts`.
- Keep orchestration in services and use cases, not in API routes, adapters, or
  database validators.
- Prefer replacing Stripe-specific runtime assumptions over keeping long-lived
  dual read or dual write shims.
- Keep new financial records append-only when possible.
- Treat invoices as settlement artifacts, not the long-term financial source of
  truth.
- If a phase lands incrementally, the landing slice still needs to move the
  runtime closer to the target architecture.
