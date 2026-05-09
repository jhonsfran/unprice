## Use Cases

Business operations live in `internal/services/src/use-cases/{domain}/{operation}.ts`.

### When to create a use case
- The operation orchestrates 2+ services
- There are business rules beyond simple CRUD
- The same flow is called from multiple entrypoints (tRPC, Hono, jobs)

### When to use a service method instead
- Single DB query with cache/retry
- Reusable data access that multiple use cases need

### Pattern
- Deps type: `{ services: Pick<ServiceContext, ...>, db?, logger?, analytics?, waitUntil? }` — only what the operation needs. `db` only if it opens transactions. `logger` only if it sets business context. Never the full ServiceContext.
- Signature: `(deps: XxxDeps, input: Input) -> Promise<Result<Output, Error>>`
- Use cases NEVER import from tRPC or Hono
- Top-level use cases should NOT call other top-level use cases — extract shared sub-operations as internal helpers
- Use cases define their own Input/Output types (not Drizzle schemas)

### Adapter rules
- Adapters (tRPC routers, Hono routes, jobs) call use cases or simple service methods
- Adapters NEVER access ctx.db directly — always go through a service or use case
- For any given operation, there is ONE canonical owner (use case or service method)

## TypeScript

- Never use `any`. Not in production code, not in tests, not in mocks. If a real type isn't reachable, use `unknown` plus a narrowing check, or define a precise local type. `any` silently disables type checking in the surrounding scope and is rejected by `pnpm fmt`/biome.
- Prefer `unknown` for parameters that genuinely accept arbitrary input, then narrow before use.
- A targeted `// biome-ignore lint/...: <reason>` is acceptable when the only correct shape conflicts with a lint rule (e.g., mocking a thenable query builder). Always include the reason. Never reach for `any` to silence the linter.
