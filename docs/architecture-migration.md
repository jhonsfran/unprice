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
- [x] All tRPC subscription procedures (6) use `createTRPCServices`
- [x] All tRPC planVersion procedures (2) use `createTRPCServices`
- [x] `init.ts` uses factory for customers, plans, billing, subscriptions, entitlements, grantsManager

### Phase 4 — Remaining tRPC Procedures
- [x] `trpc/utils/shared.ts` — `signOutCustomer` uses `createTRPCServices`
- [x] `trpc/router/lambda/planVersions/publish.ts` — uses `createTRPCServices` for CustomerService
- [x] `trpc/router/lambda/planVersions/listByProjectUnprice.ts` — uses `createTRPCServices`

### Phase 5 — Queue Consumer
- [x] `apps/api/src/ingestion/queue.ts` — `createQueueServices` now uses `createServiceContext` internally
- [x] Return type changed from `{ customerService, grantsManager }` to `{ customers, grantsManager }`

### Phase 6 — Context Type Cleanup
- [x] `HonoEnv` `ServiceContext` split into `InfraContext` + `DomainServiceContext`
- [x] Clear documentation of which layer each type represents

## Pending

### Remaining Items
- [ ] `trpc/router/lambda/apikeys/roll.ts` — `new ApiKeysService(...)` needs `hashCache` (cross-request Map), doesn't fit generic factory
- [ ] Move `plans/create.ts` tRPC raw DB logic into `PlanService.createPlan()` method
- [ ] Consider adding `services` to tRPC context type at `createTRPCContext` level (currently each procedure calls `createTRPCServices`)

### Not Migrating (Platform-Specific)
These services depend on platform-specific bindings and correctly live outside the factory:
- `ApiProjectService` — requires `requestId` (per-request Hono context)
- `ApiKeysService` — requires `hashCache` (cross-request persistent Map)
- `IngestionService` — requires Cloudflare DurableObject stubs + Pipeline bindings

## Design Decisions

- **No DI framework** — plain TypeScript constructor injection
- **No base class** — services share `ServiceDeps` type, not inheritance
- **Circular dep resolution** — `Customer.setSubscriptionService()` setter pattern
- **`GrantsManager` transaction scoping** — `SubscriptionService.createGrantManager(trx)` stays for tx-bound usage
- **IngestionService was the gold standard** — it was already correctly injection-based
- **Platform-specific services stay outside factory** — only pure domain services go in `createServiceContext`
- **`InfraContext` vs `DomainServiceContext`** — type-level separation in HonoEnv makes the layering explicit

## Key Files

| File | Role |
|---|---|
| `internal/services/src/deps.ts` | `ServiceDeps` type definition |
| `internal/services/src/context.ts` | `createServiceContext` factory — single composition root |
| `internal/trpc/src/utils/services.ts` | `createTRPCServices` — thin wrapper for tRPC procedures |
| `internal/jobs/src/trigger/tasks/context.ts` | Jobs composition root, calls `createServiceContext` |
| `apps/api/src/middleware/init.ts` | Hono composition root, calls factory + adds platform services |
| `apps/api/src/hono/env.ts` | `InfraContext`, `DomainServiceContext`, `ServiceContext` types |
| `apps/api/src/ingestion/queue.ts` | Queue consumer composition root, calls `createServiceContext` |
