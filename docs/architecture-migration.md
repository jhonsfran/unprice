# Architecture Migration: Clean Service Composition

Incremental migration from nested service construction to flat, injected service graph.

## Completed

### Phase 1 — Foundation
- [x] `internal/services/src/deps.ts` — `ServiceDeps` interface (6 shared infra deps)
- [x] `internal/services/src/context.ts` — `createServiceContext(deps)` factory
- [x] `./deps` and `./context` exports in `@unprice/services` package.json
- [x] `PlanService` added to `ServiceContext` and `HonoEnv`
- [x] `getPlanVersionV1.ts` and `listPlanVersionsV1.ts` use `c.get("services").plans`

### Phase 2 — Service Injection
- [x] `BillingService` constructor requires `customerService` + `grantsManager`
- [x] `SubscriptionService` constructor requires `customerService` + `billingService`
- [x] `EntitlementService` constructor requires `customerService` + `grantsManager` + `billingService`
- [x] `CustomerService` gains `setSubscriptionService()` to break Customer <-> Subscription cycle
- [x] `createServiceContext` resolves the cycle via post-construction setter
- [x] All internal `new ChildService(...)` calls removed from service constructors

### Phase 3 — Consolidated Composition Roots
- [x] Jobs `context.ts` calls `createServiceContext()` — exposes `context.services.*`
- [x] All 5 job task files (`billing`, `finilize`, `period`, `invoice`, `renew`) use `context.services`
- [x] `internal/trpc/src/utils/services.ts` — `createTRPCServices(ctx)` helper wrapping factory
- [x] 6 tRPC subscription procedures use `createTRPCServices` instead of inline wiring
- [x] 2 tRPC planVersion procedures use `createTRPCServices` instead of `new PlanService`
- [x] `init.ts` uses factory for customers, plans, billing, subscriptions, entitlements, grantsManager

## Pending

### Phase 4 — Remaining tRPC Procedures
- [ ] `trpc/utils/shared.ts:151` — `new CustomerService(ctx)` -> use `createTRPCServices`
- [ ] `trpc/router/lambda/planVersions/publish.ts:76` — `new CustomerService(...)` -> use factory
- [ ] `trpc/router/lambda/apikeys/roll.ts:22` — `new ApiKeysService(...)` -> use factory (needs ApiKeysService in context)

### Phase 5 — Context Shape Cleanup
- [ ] Split `HonoEnv.ServiceContext` into infra (db/cache/logger/metrics) and domain services
- [ ] Routes should only destructure domain services, not raw infra deps
- [ ] Remove `db` from route-visible context (routes use services, not raw DB)
- [ ] Move `plans/create.ts` tRPC raw DB logic into `PlanService.createPlan()` method

### Phase 6 — Queue Consumer
- [ ] `apps/api/src/ingestion/queue.ts` — replace `createQueueServices` with `createServiceContext`

### Not Migrating (Platform-Specific)
These services depend on Cloudflare-specific bindings and correctly live outside the factory:
- `ApiProjectService` — requires `requestId` (per-request Hono context)
- `ApiKeysService` — requires `hashCache` (cross-request persistent Map)
- `IngestionService` — requires Cloudflare DurableObject stubs + Pipeline bindings

## Design Decisions

- **No DI framework** — plain TypeScript constructor injection
- **No base class** — services share `ServiceDeps` type, not inheritance
- **Circular dep resolution** — `Customer.setSubscriptionService()` setter pattern
- **`GrantsManager` transaction scoping** — `SubscriptionService.createGrantManager(trx)` stays for tx-bound usage
- **IngestionService is the gold standard** — it was already correctly injection-based
- **Platform-specific services stay outside factory** — only pure domain services go in `createServiceContext`

## Files

| File | Role |
|---|---|
| `internal/services/src/deps.ts` | `ServiceDeps` type definition |
| `internal/services/src/context.ts` | `createServiceContext` factory — single composition root |
| `internal/trpc/src/utils/services.ts` | `createTRPCServices` — thin wrapper for tRPC procedures |
| `internal/jobs/src/trigger/tasks/context.ts` | Jobs composition root, calls `createServiceContext` |
| `apps/api/src/middleware/init.ts` | Hono composition root, calls factory + adds platform services |
