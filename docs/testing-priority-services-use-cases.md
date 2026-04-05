# Service and Use-Case Test Priority Backlog

Date: 2026-04-05
Scope: `internal/services/src/**` (service + use-case reliability tests)

## Why this exists

This backlog identifies the service/use-case tests that will produce the highest reliability gains first.
It is based on:

- architectural criticality (payment, signup, subscription lifecycle, entitlement enforcement)
- blast radius (cross-cutting dependencies and DB transactions)
- current coverage gaps

## Current coverage snapshot

- Service files found: 16
- Services with a direct `service.test.ts`: 2 (`ingestion`, `subscriptions`)
- Use-case files found: 13
- Use-cases with direct tests: 0

Large services with no direct test file (highest risk by size + responsibility):

- `internal/services/src/billing/service.ts` (~2844 LOC)
- `internal/services/src/plans/service.ts` (~2302 LOC)
- `internal/services/src/customers/service.ts` (~1428 LOC)
- `internal/services/src/entitlements/service.ts` (~875 LOC)
- `internal/services/src/projects/service.ts` (~602 LOC)
- `internal/services/src/workspaces/service.ts` (~576 LOC)
- `internal/services/src/apikey/service.ts` (~577 LOC)
- `internal/services/src/analytics/service.ts` (~533 LOC)

## Priority tiers

## P0 — Critical reliability (test first)

| Type | File | Why this is P0 | Minimum scenarios to cover |
|---|---|---|---|
| Use-case | `internal/services/src/use-cases/customer/sign-up.ts` | Core revenue entry path, multi-branch plan resolution, DB transaction, async analytics side effects | happy path, plan-resolution branches (session/slug/default), external-id conflict, subscription/phase creation failures, transaction rollback behavior |
| Use-case | `internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts` | Stripe callback finalizes signup + customer upsert + subscription orchestration | invalid metadata/session, customer-session missing, upsert conflict, subscription/phase failures, success redirect contract |
| Use-case | `internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts` | Stripe setup callback mutates payment metadata used for billing | invalid metadata, payment-method lookup failure, customer missing, update failure, success redirect contract |
| Use-case | `internal/services/src/use-cases/plan-version/publish.ts` | Controls publish state transitions and billing constraints | version-not-found, already-published/no-features, payment-method-required checks, transaction updates for features + versions |
| Use-case | `internal/services/src/use-cases/plan-version/duplicate.ts` | Critical mutation path for plan configuration cloning | not-found, default-plan conflict rule, cloned feature/version consistency, transactional failure path |
| Service | `internal/services/src/billing/service.ts` | Highest-complexity financial logic, invoice and period correctness risk | invoice generation state transitions, retry/idempotency semantics, boundary dates, failure propagation |
| Service | `internal/services/src/customers/service.ts` | Central customer identity/payment-provider interactions, high fan-out | payment provider resolution, customer lookup edge cases, conflict/error mapping, side-effect safety |
| Service | `internal/services/src/entitlements/service.ts` | Authorization/usage enforcement backbone | entitlement resolution correctness, current/historical window behavior, error classification, invalid config handling |
| Service | `internal/services/src/plans/service.ts` | Plan/version retrieval and mutation correctness directly impacts pricing behavior | version selection rules, status/active filters, mutation invariants, error semantics |
| Ingestion sub-services | `internal/services/src/ingestion/preparation-service.ts` and `internal/services/src/ingestion/state-resolution-service.ts` | Extracted from ingestion orchestration; currently covered mostly indirectly | customer-not-found/no-usage-grant outcomes, invalid entitlement config path, aggregation payload filtering |

## P1 — High value, medium urgency

| Type | File | Why | Minimum scenarios |
|---|---|---|---|
| Use-case | `internal/services/src/use-cases/workspace/invite-member.ts` | Membership + invite flow with cache invalidation side effects | personal workspace conflict, already-member, direct add, invite creation, cache invalidation fire-and-forget |
| Use-case | `internal/services/src/use-cases/workspace/resend-invite.ts` | Re-invitation behavior and inviter identity correctness | personal workspace conflict, invite-not-found, inviter fallback name/email |
| Use-case | `internal/services/src/use-cases/project/transfer-to-workspace.ts` | Ownership transitions can orphan data if wrong | main-project guard, same-workspace guard, target-not-found, successful transfer output |
| Use-case | `internal/services/src/use-cases/project/transfer-to-personal.ts` | Similar transfer risk with personal workspace lookup | already-personal/main-project guards, personal-workspace-not-found, success output |
| Use-case | `internal/services/src/use-cases/payment-provider/save-config.ts` | Provider credential storage path | encryption failure, validation errors, update failure, success persistence |
| Service | `internal/services/src/projects/service.ts` | Frequently used read/write capability | get/list filters, update invariants, workspace scoping |
| Service | `internal/services/src/workspaces/service.ts` | Membership and invite read-model consistency | member/invite queries, authorization assumptions, state filtering |
| Service | `internal/services/src/payment-provider/service.ts` | External-provider abstraction correctness | provider routing, API error normalization, unsupported provider behavior |
| Service | `internal/services/src/apikey/service.ts` | Security-sensitive data path | active-project scoping, key lookup edge cases, error handling |

## P2 — Useful hardening after P0/P1

| Type | File | Why |
|---|---|---|
| Use-case | `internal/services/src/use-cases/plan/create.ts` | Business-rule coverage for default/enterprise exclusivity |
| Use-case | `internal/services/src/use-cases/subscription/create.ts` | Thin wrapper but transaction behavior should be locked |
| Use-case | `internal/services/src/use-cases/user/set-onboarding-completed.ts` | Low complexity but user-state correctness |
| Service | `internal/services/src/analytics/service.ts` | Important for reporting correctness, lower immediate risk than payment/signup |
| Service | `internal/services/src/events/service.ts` | Event listing/update paths with moderate blast radius |
| Service | `internal/services/src/features/service.ts` | Feature CRUD/query consistency |
| Service | `internal/services/src/pages/service.ts` | Content retrieval/update reliability |
| Service | `internal/services/src/domains/service.ts` | Domain mapping correctness |
| Service | `internal/services/src/cache/service.ts` | Behavior mostly infrastructural; valuable after domain-critical flows |

## Suggested execution order

1. Complete P0 use-cases first (signup + payment callbacks + plan-version publish/duplicate).
2. Add P0 service suites for `billing`, `customers`, `entitlements`, `plans`.
3. Add direct unit suites for ingestion extracted sub-services.
4. Move through P1 by business criticality (`workspace` -> `project` -> `payment-provider` -> `apikey`).
5. Finish with P2 hardening.

## Notes for implementers

- Prefer deterministic unit tests with dependency fakes at service/use-case boundaries.
- Add integration tests only where transactional guarantees must be proven.
- Keep route tests as adapter-contract checks; business correctness belongs in service/use-case tests.
