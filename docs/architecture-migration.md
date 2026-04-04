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
- [x] All 5 job task files use `context.services`
- [x] `init.ts` uses factory for customers, plans, billing, subscriptions, entitlements, grantsManager
- [x] Queue consumer `queue.ts` uses `createServiceContext` internally

### Phase 4 — tRPC Integration
- [x] `services` added to tRPC context at `createInnerTRPCContext` level
- [x] All 10 tRPC procedures migrated from `createTRPCServices()` to `ctx.services`
- [x] `createTRPCServices` helper removed (dead code)
- [x] `plans/create.ts` raw DB logic extracted into `PlanService.createPlan()` method

### Phase 5 — Context Type Cleanup
- [x] `HonoEnv` `ServiceContext` split into `InfraContext` + `DomainServiceContext`

## Pending

### Remaining Items
- [ ] `trpc/router/lambda/apikeys/roll.ts` — `new ApiKeysService(...)` needs `hashCache` (cross-request Map), doesn't fit generic factory

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
- **tRPC gets services on context** — `ctx.services.*` available in every procedure, no per-procedure wiring

## Key Files

| File | Role |
|---|---|
| `internal/services/src/deps.ts` | `ServiceDeps` type definition |
| `internal/services/src/context.ts` | `createServiceContext` factory — single composition root |
| `internal/trpc/src/trpc.ts` | `createInnerTRPCContext` — wires `services` into tRPC context |
| `internal/jobs/src/trigger/tasks/context.ts` | Jobs composition root, calls `createServiceContext` |
| `apps/api/src/middleware/init.ts` | Hono composition root, calls factory + adds platform services |
| `apps/api/src/hono/env.ts` | `InfraContext`, `DomainServiceContext`, `ServiceContext` types |
| `apps/api/src/ingestion/queue.ts` | Queue consumer composition root, calls `createServiceContext` |
