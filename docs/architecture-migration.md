# Architecture Migration: Clean Service Composition

Incremental migration from nested service construction to flat, injected service graph.

## Completed

### Phase 1 — Foundation
- [x] `internal/services/src/deps.ts` — `ServiceDeps` interface (6 shared infra deps)
- [x] `internal/services/src/context.ts` — `createServiceContext(deps)` factory
- [x] `./deps` and `./context` exports in `@unprice/services` package.json
- [x] `PlanService` added to `ServiceContext` and `HonoEnv`
- [x] `getPlanVersionV1.ts` and `listPlanVersionsV1.ts` use `c.get("services").plans`

### Phase 2 — Service Injection (BillingService)
- [x] `BillingService` constructor requires `customerService` + `grantsManager`
- [x] Updated 7 call sites: 3 jobs, 1 tRPC, 1 SubscriptionService, 1 EntitlementService, 1 test
- [x] Imports changed to `type` imports — no circular instantiation

### Phase 2 — Service Injection (SubscriptionService)
- [x] `SubscriptionService` constructor requires `customerService` + `billingService`
- [x] Updated 11 call sites: 2 jobs, 5 tRPC, `init.ts`, `CustomerService`, 2 tests
- [x] `CustomerService` gains `setSubscriptionService()` to break Customer <-> Subscription cycle
- [x] `createServiceContext` resolves the cycle via post-construction setter

### Phase 2 — Service Injection (EntitlementService)
- [x] `EntitlementService` constructor requires `customerService` + `grantsManager` + `billingService`
- [x] Removed in-method `new BillingService(...)` — uses injected instance
- [x] `init.ts` now uses `svcCtx.entitlements` from factory

## Pending

### Phase 3 — Consolidate Composition Roots
- [ ] Have jobs `context.ts` call `createServiceContext()` instead of manual wiring
- [ ] Have tRPC procedures use a shared factory instead of inline `new Service(...)` in each procedure
- [ ] Introduce `createTRPCServiceContext()` that wraps `createServiceContext()`
- [ ] Migrate `trpc/utils/shared.ts` from direct `CustomerService` import

### Phase 4 — Remaining Services
- [ ] `ApiProjectService` wraps `ProjectService` internally — inject or merge
- [ ] `ApiKeysService` — add to `createServiceContext`
- [ ] `IngestionService` — already uses injection; move construction into factory
- [ ] Queue consumer `queue.ts` — use `createServiceContext` instead of `createQueueServices`

### Phase 5 — Context Cleanup
- [ ] Split `HonoEnv.ServiceContext` into infra (db/cache/logger/metrics) and domain services
- [ ] Routes should only destructure domain services, not raw infra deps
- [ ] Remove `db` from route-visible context (routes use services, not raw DB)
- [ ] Move `plans/create.ts` tRPC raw DB logic into `PlanService.createPlan()` method

### Phase 6 — tRPC Procedure Cleanup
- [ ] All tRPC procedures that do `new XService(ctx)` should use `ctx.services.x`
- [ ] Add `services` to tRPC context type (like HonoEnv has)
- [ ] Remove ad-hoc service construction from individual procedures

### Stretch Goals
- [ ] Extract `ServiceDeps` spreading into a helper: `spreadDeps(deps)` to reduce 6-field repetition
- [ ] Consider lazy service construction in factory for services not used on every request
- [ ] Add integration test that verifies `createServiceContext` wires everything correctly

## Design Decisions

- **No DI framework** — plain TypeScript constructor injection
- **No base class** — services share `ServiceDeps` type, not inheritance
- **Circular dep resolution** — `Customer.setSubscriptionService()` setter pattern
- **`GrantsManager` transaction scoping** — `SubscriptionService.createGrantManager(trx)` stays for tx-bound usage
- **IngestionService is the gold standard** — it was already correctly injection-based
