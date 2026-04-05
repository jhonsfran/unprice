# ADR-0001: Canonical Backend Architecture Boundaries

## Status

Accepted

## Date

2026-04-05

## Context

The codebase was repeatedly drifting between multiple architectural styles:

- business logic in adapters (`apps/api` routes, tRPC handlers)
- orchestration mixed into large service classes
- API-local wrappers around shared service contracts
- domain policies located in non-domain modules

This created regressions, duplication, and inconsistent agent-generated changes.
We need one canonical, explicit architecture contract for all future work.

## Decision Drivers

- Keep adapters thin and framework-specific.
- Keep business orchestration framework-agnostic and testable.
- Keep domain rules owned by domain modules.
- Keep dependency wiring explicit in composition roots.
- Make package boundaries obvious for both humans and agents.

## Decision

We standardize on the following boundaries.

### 1) Adapters Are Thin

- `apps/api` routes and `internal/trpc` procedures are adapters only.
- Adapters may do:
  - auth/authz
  - request validation/parsing
  - rate-limiting
  - response mapping
- Adapters must not:
  - access DB directly
  - implement multi-step business orchestration

### 2) Orchestration Lives In Use Cases

- Multi-step flows live under `internal/services/src/use-cases/**`.
- Use cases are the canonical owner for orchestration logic.
- Use cases orchestrate services and return typed results/errors.

### 3) Services Are Reusable Capabilities

- Services encapsulate reusable capabilities (queries, mutations, external clients, cache-aware access).
- Services should not construct other services internally when avoidable.
- Service dependencies are injected via composition roots.

### 4) Composition Root Owns Wiring

- Dependency wiring is centralized in composition roots (e.g. `createServiceContext`, API init/factories).
- Infra (`db`, `logger`, `analytics`, `waitUntil`) remains separate from the domain-service bag.
- Avoid hidden construction inside business services.

### 7) No API-Local Re-Export Wrappers For Shared Contracts

- Do not create API-local pass-through files like `apps/api/src/ingestion/{message,interface,consumer}.ts` for shared contracts.
- Import shared contracts directly from the owning package (for example `@unprice/services/ingestion`).

### 8) Error Strategy

- Use existing domain errors by default.
- Add a new custom error class only when a reusable domain-specific failure contract is needed across multiple callers.

## Consequences

### Positive

- Consistent implementation pattern across API, tRPC, jobs, and queues.
- Better testability (core logic in internal services, infra in adapters).
- Fewer ambiguous ownership decisions for future contributors and agents.
- Cleaner module imports and reduced wrapper churn.

### Negative

- More explicit wiring in composition roots.
- Some refactors require touching both adapter and service modules.
- Teams must learn and follow stricter boundaries.

## Guardrails (Non-Negotiable)

- No direct DB calls from `apps/api/src/routes/**` and tRPC handlers.
- No new orchestration flows inside adapter files.
- No service-internal construction of peer services unless explicitly documented.
- No new API-local wrapper files for shared ingestion contracts.
- Domain policies must stay in their owning domain module.

## Canonical Locations

- Use cases: `internal/services/src/use-cases/**`
- Domain services: `internal/services/src/*/service.ts`
- API adapters: `apps/api/src/routes/**`, `apps/api/src/ingestion/**` (Cloudflare glue only)
- tRPC adapters: `internal/trpc/src/router/**`

## Related Documents

- [Architecture Roadmap](/Users/jhonsfran/repos/unprice/docs/architecture-roadmap.md)
- [Architecture Migration Notes](/Users/jhonsfran/repos/unprice/docs/architecture-migration.md)
- [API Orthogonal Architecture](/Users/jhonsfran/repos/unprice/docs/api-orthogonal-architecture.md)

## Change Process

If a new requirement conflicts with this ADR:

1. Propose a new ADR in `docs/adr/`.
2. Mark whether it supersedes this ADR fully or partially.
3. Update affected roadmap sections and links.
