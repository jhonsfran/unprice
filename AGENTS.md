# Agent Guide

This is the canonical guide for automated agents working in this repository. Read it before
editing. `CLAUDE.md` and `docs/adr/ADR-0001-canonical-backend-architecture-boundaries.md`
contain compatible background; keep them aligned when changing architecture rules.

## Operating Principles

- Fix the problem at the owning architectural layer. Do not hide a domain bug in an API route,
  component, or test helper when the invariant belongs in a service, use case, schema, or database
  model.
- Prefer the simplest correct change. Reuse existing patterns before adding a new abstraction,
  dependency, framework, service, or helper.
- Keep changes scoped. Avoid opportunistic rewrites, formatting churn, file moves, or unrelated
  cleanup.
- Preserve user work. The worktree may be dirty; never revert or overwrite changes you did not
  make unless explicitly asked.
- Use `pnpm` and the workspace package graph. Do not introduce another package manager.

## Repo Map

- `apps/nextjs`: Next.js App Router dashboard and product UI.
- `apps/api`: Hono/Cloudflare API adapters. Routes translate HTTP concerns into service or
  use-case calls.
- `internal/trpc`: tRPC adapters. Procedures translate tRPC concerns into service or use-case
  calls.
- `internal/services`: Domain services, use cases, service graph wiring, and business
  orchestration.
- `internal/db`: Drizzle schema plus Zod validators exported through `@unprice/db/validators`.
- `internal/error`: `Result`, `Ok`, `Err`, and shared error primitives.
- `internal/observability`, `internal/logs`, `internal/metrics`: logging, wide events, and
  metrics.
- `packages/api` and `packages/react`: public package surfaces.
- `tooling/*`: repo tooling and operational utilities.

## Architecture Boundaries

- Follow ADR-0001 for backend boundaries.
- Adapters stay thin. `apps/api/src/routes/**` and `internal/trpc/src/router/**` may handle
  auth/authz, request validation, rate limits, response shaping, and error mapping.
- Adapters must not do direct database work or multi-step business orchestration.
- Use cases live in `internal/services/src/use-cases/{domain}/{operation}.ts`.
- Create a use case when an operation orchestrates two or more services, contains business rules
  beyond simple CRUD, needs a transaction, or is called from multiple entrypoints.
- Use a service method for reusable single-domain capabilities: queries, mutations, cache-aware
  access, external-client access, retries, and simple data access.
- Every operation has one canonical owner: either a use case or a service method. Do not duplicate
  the same flow in tRPC, Hono, jobs, and tests.
- Use cases never import from tRPC, Hono, Next.js, or route modules.
- Top-level use cases should not call other top-level use cases. Extract shared domain helpers
  when orchestration needs to be reused.
- Services do not construct peer services. Add service wiring in `createServiceContext` or the
  relevant composition root.
- Keep infrastructure primitives (`db`, `logger`, `analytics`, `waitUntil`, `cache`, `metrics`)
  explicit and separate from the domain-service bag.
- Dependency bags should use only what is needed, for example
  `services: Pick<ServiceContext, "plans" | "customers">`, plus `db` only for transactions and
  `logger` only when setting business context.

## Zod And Type Contracts

- Prefer Zod schemas as the source of truth for boundary shapes. Define or compose a schema, then
  derive TypeScript with `z.infer<typeof schema>`.
- Avoid standalone object `type` or `interface` definitions for request bodies, responses, DTOs,
  form values, route inputs, use-case inputs, or use-case outputs when a Zod schema can own the
  contract.
- Good exceptions for handwritten types: dependency bags, class constructor params, private
  implementation details, generic utility types, external library adapter types, and shapes that
  cannot usefully be validated at runtime.
- Use `@unprice/db/validators` schemas for DB select/insert/update contracts when they are the
  actual boundary.
- Do not blindly pass Drizzle insert/select schemas into use cases when the business contract is
  different. Define a use-case-local Zod schema and infer the input/output type from it.
- Parse at the boundary. Adapters parse request input, forms parse form input, and service/use-case
  entrypoints validate only when they are themselves the boundary.
- Compose schemas with `.pick`, `.omit`, `.extend`, `.merge`, discriminated unions, and shared
  nested schemas instead of duplicating shape literals.
- Export schemas next to the contract they describe, and export inferred types only when callers
  need them.

## TypeScript And Errors

- Never use `any`. Use `unknown` and narrow. If a lint suppression is truly necessary, use a
  targeted `// biome-ignore lint/...: reason` comment.
- Prefer `Result<T, E>`, `Ok`, and `Err` for expected domain and service failures.
- Use `wrapResult` for thrown I/O or database calls when that matches the local service style.
- Add a custom domain error only when callers need a reusable failure contract. Do not create new
  error classes for one-off messages.
- API routes map expected failures to `UnpriceApiError`/`toUnpriceApiError`. tRPC procedures map
  expected failures to `TRPCError`.
- Leave unexpected programmer failures as raw errors so the platform treats them as internal
  failures.
- Do not add `console.log`. Use the existing logger, wide-event context, and metrics patterns.

## Data And Package Boundaries

- Drizzle tables live in `internal/db/src/schema/**`; Zod validators live in
  `internal/db/src/validators/**` and are exported from `internal/db/src/validators.ts`.
- Keep schema, validators, migrations, services, and tests in sync when a data contract changes.
- Never create, edit, or apply database migrations manually. Always use `bin/migrate.dev`.
- Direct DB access belongs in services, repositories, use cases that own transactions, and
  composition roots. It does not belong in Hono routes or tRPC handlers.
- Prefer package exports such as `@unprice/services/use-cases` and `@unprice/db/validators`.
  Avoid deep cross-package relative imports and API-local pass-through wrappers for shared
  contracts.
- If a shared contract needs a new public path, add an explicit package export instead of importing
  through an unrelated module.

## Testing And Verification

- Put business correctness tests at the service or use-case layer. Route tests should verify
  adapter contracts, auth, validation, and error mapping.
- Use focused unit tests with fakes for service/use-case behavior. Use integration tests when a
  transaction, Drizzle query, or storage invariant must be proven.
- Run the smallest useful verification for the files changed, then broaden if risk or blast radius
  requires it.
- Common commands:
  - `bin/migrate.dev`
  - `pnpm validate`
  - `pnpm --filter @unprice/services test`
  - `pnpm --filter @unprice/services typecheck`
  - `pnpm --filter @unprice/trpc typecheck`
  - `pnpm --filter api test`
  - `pnpm --filter api type-check`
  - `pnpm --filter nextjs typecheck`
- Use `pnpm validate` when checking or validating changes. Targeted commands are for local
  iteration before the full validation.
- Avoid `pnpm fmt:fix` unless broad formatting writes are intentional.

## Frontend Rules

- Follow existing Next.js App Router, shadcn/ui, Tailwind, and local component patterns.
- Prefer tRPC `RouterOutputs`/`RouterInputs` for UI data types when the data comes from tRPC.
- Prefer Zod-backed form schemas and the existing form helpers.
- Keep UI work scoped to the requested workflow. Do not redesign surrounding screens unless the
  requested fix requires it.

## Change Discipline

- Read nearby code before editing. Match naming, file layout, error mapping, and test style.
- Prefer deleting duplication by routing callers to the canonical owner over adding another
  parallel implementation.
- Do not add feature flags, alternate execution paths, queues, caches, state machines, or
  abstractions unless the current problem needs them.
- If a requirement conflicts with ADR-0001 or this guide, write or update an ADR before changing
  the boundary.
- When unsure between a quick adapter patch and a small architectural fix, choose the small
  architectural fix.
