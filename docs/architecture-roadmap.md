# Architecture Roadmap — Clean(ish) Architecture for Unprice

> Goal: adopt a pragmatic clean architecture that gives AI agents (and humans) a
> predictable, repeatable pattern to follow when building features, fixing bugs,
> or refactoring code.

---

## Foundation Already Built

Before this roadmap starts, the injection layer is complete:

- `ServiceDeps` type + `createServiceContext` factory wire all domain services
- `BillingService`, `SubscriptionService`, `EntitlementService` accept injected collaborators
- tRPC context has `ctx.services` — every procedure can access the full service graph
- Jobs, Hono, and queue consumer all use the factory
- Hono routes are already thin adapters (zero direct DB access)
- See `docs/architecture-migration.md` for the full record

---

## Current State — Problems Identified

### 1. tRPC routers contain business logic + raw DB queries
- **Where:** 72 tRPC router files with 88 direct `ctx.db.*` calls
- **Problem:** Routes directly query/mutate the DB, bypassing services. Logic is
  duplicated between tRPC routes and the Hono API routes that call services.
- **Impact:** Two paths to do the same thing = inconsistent patterns. Agents don't
  know where business logic lives.

### 2. God-class services
- **Where:** `CustomerService` (1,725 lines), `BillingService` (2,843 lines),
  `SubscriptionService` (1,624 lines)
- **Problem:** These services mix orchestration (multi-step business flows),
  data access (DB queries + cache), analytics, and domain rules in one file.
- **Impact:** One change risks breaking unrelated flows. Testing requires wiring
  the entire service graph.

### 3. Cache concerns mixed into business logic
- **Where:** 13 inline `cache.swr()` calls across 5 service files
- **Problem:** Business logic is obscured by caching boilerplate and retry loops.
- **Impact:** Hard to read, hard to test, cache patterns get copy-pasted incorrectly.

### 4. PaymentProviderService created on-demand inside CustomerService
- **Where:** `customers/service.ts` lines 775, 1409
- **Problem:** CustomerService handles token decryption, provider selection, and
  PaymentProviderService instantiation. Hidden dependency.
- **Impact:** Can't mock payment provider in isolation. Adding a new provider
  requires modifying CustomerService.

### 5. Domain types are coupled to the DB layer
- **Where:** `internal/db/src/validators/` defines `Customer`, `Plan`, etc.
- **Problem:** Domain types derived from Drizzle schemas. Every consumer imports
  from `@unprice/db/validators`.
- **Impact:** Drizzle insert schemas leak into API contracts. Changing the DB schema
  forces changes to domain contracts.

---

## Use Cases vs Services — The Key Distinction

The biggest architectural question: when should logic live in a **use case** vs a
**service**? They solve different problems.

### Services = capabilities (stateful, reusable, infrastructure-aware)

A service provides **data access and cross-cutting capabilities** that multiple
operations share. Services know about:
- Cache (SWR patterns, invalidation, retry)
- Database queries (Drizzle, joins, filters)
- Metrics emission
- External API clients (analytics, payment providers)

Services are **nouns** — they represent a capability: "the plan service can fetch
plan versions with caching and retry."

```typescript
// services/plans/service.ts — a capability
class PlanService {
  // Reusable data access with cache + metrics
  async getPlanVersion({ planVersionId }): Promise<Result<PlanVersionApi | null, FetchError>> {
    return this.cache.planVersion.swr(planVersionId, () =>
      this.getPlanVersionData({ planVersionId })
    )
  }

  // Another reusable query
  async listPlanVersions({ projectId, query }): Promise<Result<PlanVersionApi[] | null, FetchError>> { ... }
}
```

**Keep in a service when:**
- It's a single query/mutation with cache, retry, or metrics
- Multiple callers (use cases, routes, jobs) need the same operation
- The method is <30 lines and doesn't orchestrate other services

### Use cases = operations (stateless, single-purpose, orchestration)

A use case is a **single business operation** that orchestrates services to fulfill
a user intent. Use cases know about:
- Business rules (validation, authorization, invariants)
- Ordering of steps (create customer, then subscription, then phase)
- Error handling (what to do when step 3 fails after step 2 succeeded)
- Transaction boundaries

Use cases are **verbs** — they represent an action: "sign up a customer."

```typescript
// use-cases/customer/sign-up.ts — an operation

// Deps: narrow typed — only the services + infra this operation needs
// `db` included because this use case opens a transaction
type SignUpDeps = {
  services: Pick<ServiceContext, "plans" | "customers" | "subscriptions">
  db: Database
  logger: Logger
  analytics: Analytics
  waitUntil: (p: Promise<unknown>) => void
}

export async function signUp(
  deps: SignUpDeps,
  input: SignUpInput
): Promise<Result<SignUpResult, SignUpError>> {
  const { services, db, logger } = deps

  // 1. Set business context on the wide event
  logger.set({ business: { operation: "customer.sign_up", email: input.email } })

  // 2. Resolve plan version (delegates to PlanService — read, no tx needed)
  const { err, val: plan } = await services.plans.getPlanVersion({ ... })
  if (err) return Err(new SignUpError({ message: err.message }))

  // 3. Business rule: validate plan is available
  if (!plan) return Err(new SignUpError({ message: "Plan not found" }))

  // 4. Create customer + subscription atomically
  return db.transaction(async (tx) => {
    const customer = await services.customers.create(input, { db: tx })
    const sub = await services.subscriptions.createSubscription({ ... }, { db: tx })
    // 5. External side effects AFTER tx commits (Stripe, analytics)
    return Ok({ customerId: customer.val.id, url: sub.val.url })
  })
}
```

**Make it a use case when:**
- The operation orchestrates 2+ services
- There are business rules beyond simple CRUD
- The same flow is called from both tRPC and Hono (or jobs)
- The method is >30 lines in the current service class

### The decision matrix

```
                  Single DB query     Multi-step orchestration
                  with cache/retry    with business rules
                  ──────────────────  ────────────────────────
One caller        Service method      Use case
Multiple callers  Service method      Use case
```

If it's a single cached query → service method.
If it orchestrates multiple things → use case.
The number of callers doesn't change the pattern, only whether you need it at all.

### What this looks like in practice

```
CustomerService.getCustomer()           → service (single query, cached, reusable)
CustomerService.getCustomerByExternalId() → service (single query, cached, reusable)
CustomerService.signUp()                → use case (orchestrates customer + subscription + phase + payment)
CustomerService.signOut()               → use case (orchestrates session cleanup + cache invalidation)

PlanService.getPlanVersion()            → service (single query, cached, reusable)
PlanService.listPlanVersions()          → service (single query, cached, reusable)
PlanService.createPlan()                → borderline (single insert + validation) — service is fine

BillingService.billingInvoice()         → use case (orchestrates invoice + payment + state machine)
BillingService.finalizeInvoice()        → use case (orchestrates finalization + provider call + state update)
BillingService.generateBillingPeriods() → use case (orchestrates period creation + phase iteration)
```

### How routers call them

After moving `logger`, `analytics`, and `waitUntil` out of the services bag and onto
the adapter context directly (see "Prerequisite: move infra out of services bag" below),
routers pass narrow deps to use cases:

```typescript
// tRPC router — calls use case (orchestration)
.mutation(async ({ ctx, input }) => {
  const { val, err } = await signUp(
    { services: ctx.services, db: ctx.db, logger: ctx.logger, analytics: ctx.analytics, waitUntil: ctx.waitUntil },
    { ...input, projectId: ctx.project.id }
  )
  if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err.message })
  return val
})

// tRPC router — calls service directly (simple query, no use case needed)
.query(async ({ ctx, input }) => {
  const { val, err } = await ctx.services.plans.getPlanVersion({ planVersionId: input.id })
  if (err) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message })
  return { planVersion: val }
})

// Hono route — same use case, different adapter
app.openapi(route, async (c) => {
  const { val, err } = await signUp(
    { services: c.get("services"), db: c.get("db"), logger: c.get("logger"), analytics: c.get("analytics"), waitUntil: c.get("waitUntil") },
    { ...input, projectId: key.projectId }
  )
  if (err) throw new UnpriceApiError({ code: "BAD_REQUEST", message: err.message })
  return c.json(val, 200)
})
```

### Prerequisite: move infra out of services bag

Currently `logger`, `analytics`, `db`, and `waitUntil` live inside `c.get("services")`
(Hono) and are mixed into the tRPC context alongside domain services. Before use cases
can receive them as separate deps, they need to be top-level on the adapter context:

**Hono:** `c.get("logger")`, `c.get("analytics")`, `c.get("db")`, `c.get("waitUntil")`
become separate variables (set in `init.ts`), alongside `c.get("services")` which
contains only domain services.

**tRPC:** `ctx.logger`, `ctx.analytics`, `ctx.db`, `ctx.waitUntil` already exist as
separate fields on the tRPC context. No change needed — they're already accessible
independently from `ctx.services`.

This is a mechanical refactor: move the assignments in `init.ts` from the services bag
to separate `c.set()` calls, update the `HonoEnv` type, and update routes that currently
destructure them from `c.get("services")`.
```

### Use case composition rules

**Top-level use cases** are called by adapters (tRPC, Hono, jobs). They own a
complete user-intent flow.

**Internal helpers** are shared sub-operations that top-level use cases call.
They live in the same `use-cases/` directory but are not exported to adapters.

Rules:
- **Adapters** call top-level use cases or simple service methods. Never raw DB.
- **Top-level use cases** may call services and internal helpers. They should NOT
  call other top-level use cases — if two flows share a sub-operation, extract
  the shared part as an internal helper.
- **Internal helpers** may call services but never other use cases.
- **For any given operation, there is one canonical owner.** Once a use case
  exists for an operation, the old service method should be deleted or deprecated.

---

## Pareto Analysis — The 20% That Generates 80% of Value

### Why agents need patterns

Agents work best when:
1. **One operation = one file** — they can find it, read it, replicate it.
2. **Consistent structure** — input validation -> orchestration -> persistence -> response.
3. **Clear boundaries** — "orchestration goes in use cases, queries go in services."
4. **Small surface area** — a 100-line use case is easier to reason about than a
   1700-line god class.
5. **Greppable conventions** — `use-cases/customer/sign-up.ts` is self-documenting.

### The 80/20 ranking

| Priority | Change | Effort | Agent Impact | Why |
|----------|--------|--------|-------------|-----|
| **P0** | **Extract orchestration into use-case functions** | Medium | Very High | THE pattern. One file per operation, `(services, input) -> Result`. Decomposes god classes. Agents can find, read, test, replicate. |
| **P0** | **Make tRPC routers thin** | Medium | Very High | Eliminates "two paths." Queries call services. Orchestration calls use cases. Routers become 10-line adapters. |
| **P1** | **Use-case-specific input/output types** | Low | High | Stop using Drizzle insert schemas as API input. Each use case defines what it accepts. Defer full domain package. |


---

## P0 Implementation Plan

### Target structure

```
internal/
  services/
    src/
      use-cases/                      <- NEW: one file per orchestration
        customer/
          sign-up.ts                    signUp(services, input) -> Result
          sign-out.ts                   signOut(services, input) -> Result
        subscription/
          create.ts                     createSubscription(services, input) -> Result
          create-phase.ts               createPhase(services, input) -> Result
        billing/
          billing-invoice.ts            billingInvoice(services, input) -> Result
          finalize-invoice.ts           finalizeInvoice(services, input) -> Result
          generate-periods.ts           generateBillingPeriods(services, input) -> Result
        entitlement/
          get-entitlements.ts           getEntitlements(services, input) -> Result
          get-usage-estimates.ts        getUsageEstimates(services, input) -> Result

      customers/
        service.ts                    <- KEEP: data access + cache methods
                                         (getCustomer, getCustomerByExternalId, etc.)
                                         Remove orchestration methods (signUp, signOut)

      plans/
        service.ts                    <- KEEP: getPlanVersion, listPlanVersions, createPlan

      billing/
        service.ts                    <- SLIM DOWN: keep invoice computation helpers
                                         Move billingInvoice, finalizeInvoice to use cases
```

### Use-case function signature

```typescript
// use-cases/customer/sign-up.ts
import type { ServiceContext } from "../../context"
import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import type { Analytics } from "@unprice/analytics"
import type { Result } from "@unprice/error"

// Deps: narrow typed — only what this operation needs
// - `services` uses Pick<> to declare exactly which domain services are used
// - `db` is included because this use case opens a transaction
// - `logger` is included because this use case sets business context
type SignUpDeps = {
  services: Pick<ServiceContext, "plans" | "customers" | "subscriptions">
  db: Database
  logger: Logger
  analytics: Analytics
  waitUntil: (p: Promise<unknown>) => void
}

// Input: what this operation accepts (not a Drizzle schema)
interface SignUpInput {
  email: string
  name: string
  projectId: string
  planVersionId?: string
  planSlug?: string
  config?: SubscriptionItemConfig[]
  // ...
}

// Output: what this operation returns
interface SignUpResult {
  success: boolean
  url: string
  customerId: string
}

export async function signUp(
  deps: SignUpDeps,
  input: SignUpInput
): Promise<Result<SignUpResult, UnPriceCustomerError | FetchError>> {
  // orchestration logic extracted from CustomerService.signUp()
}
```

**Note on deps:**
- Read-only use cases that don't need transactions omit `db` from their deps.
- Use cases that don't log business context can omit `logger`.
- The `Pick<ServiceContext, ...>` makes the dependency set visible in the signature.

### Triage rule for the 72 tRPC files

Not everything needs a use case. Apply this rule:

- **Query <15 lines, single DB call** -> Move query to existing service, call `ctx.services.x.method()` from procedure. No use case needed.
- **Mutation with business logic / multi-step** -> Extract to use case function.
- **Simple CRUD insert/update** -> Add method to service, call from procedure.

Estimate: ~50 of the 72 files are simple queries that just need a service method.
~15-20 are orchestrations that justify a use case.

### Migration strategy

1. **Start with the simplest** — `plan/create` is already extracted to `PlanService.createPlan()`.
   Moving it to a use-case function is one rename. Proves the file structure.
2. **Do a simple read** — `customer/get-by-id`. Shows the minimal pattern (service method,
   not use case, but tRPC router calls service instead of DB).
3. **Do a moderate orchestration** — `subscription/create`. Already delegated to
   `SubscriptionService`. Extract to use case.
4. **Do the complex one** — `customer/sign-up`. The 200-line monster. Extracts from
   `CustomerService.signUp()`. This is the proof that the pattern handles real complexity.
5. **Batch the remaining simple queries** — one commit per domain (plans, features, pages, etc.)

### CLAUDE.md conventions

Once P0 is in place, add to the root `CLAUDE.md`:

```markdown
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
- Deps type: `{ services: Pick<ServiceContext, ...>, db?, logger?, analytics?, waitUntil? }`
  — only what the operation needs. `db` only if it opens transactions. `logger` only
  if it sets business context. Never the full ServiceContext.
- Signature: `(deps: XxxDeps, input: Input) -> Promise<Result<Output, Error>>`
- Use cases NEVER import from tRPC or Hono
- Top-level use cases should NOT call other top-level use cases — extract
  shared sub-operations as internal helpers
- Use cases define their own Input/Output types (not Drizzle schemas)

### Adapter rules
- Adapters (tRPC routers, Hono routes, jobs) call use cases or simple service methods
- Adapters NEVER access ctx.db directly — always go through a service or use case
- For any given operation, there is ONE canonical owner (use case or service method)
```

---

## Error Handling Strategy

### Current state (measured)

- **349** `Ok()`/`Err()` returns across 12 service files — the dominant pattern
- **25** `throw new XError(...)` — explicit throws (constructors, engine assertions)
- **17** `throw err` — re-throws from catch blocks (the real problem)
- Only 5 of 12 service files use `toErrorContext()` for structured error logging

The codebase is ~80% Result-based. The remaining 20% is inconsistent: some methods
return `Result`, then have internal catch blocks that `throw` instead of returning `Err`.

### The rule: Result at boundaries, throw only for programmer errors

**Use `Result<T, E>` for:**
- All public service methods (already mostly the case)
- All use case functions (always — this is the contract)
- Any error a caller can reasonably handle (not found, conflict, validation failure, external API failure)

**`throw` is acceptable only for:**
- Constructor validation (bad wiring = programmer error, crash is correct)
- Assertion failures inside domain engines (`engine.ts` — invariant violations that indicate bugs)
- Transaction rollbacks in Drizzle (Drizzle uses throw for tx control flow)

**Never `throw` for:**
- DB query failures — wrap in `Err(new FetchError(...))`
- Business rule violations — return `Err(new UnPriceXxxError(...))`
- "Not found" — return `Ok(null)` or `Err(new NotFoundError(...))`

### The problem pattern to fix

This appears 17 times across services:

```typescript
// BAD: catch-and-rethrow loses the Result contract
private async someQuery() {
  return this.db.query.plans.findFirst({ ... })
    .catch((err) => {
      throw err  // <-- caller expects Result but gets an exception
    })
}
```

Fix:

```typescript
// GOOD: catch-and-wrap preserves the Result contract
private async someQuery(): Promise<Result<Plan | null, FetchError>> {
  const { val, err } = await wrapResult(
    this.db.query.plans.findFirst({ ... }),
    (err) => new FetchError({ message: err.message, retry: false })
  )
  if (err) return Err(err)
  return Ok(val)
}
```

### Error types per domain

Each domain already has its own error class. Keep this pattern:

| Domain | Error class | Already exists |
|--------|-------------|----------------|
| Customers | `UnPriceCustomerError` | Yes |
| Subscriptions | `UnPriceSubscriptionError` | Yes |
| Billing | `UnPriceBillingError` | Yes |
| Entitlements | `UnPriceEntitlementError` | Yes |
| Grants | `UnPriceGrantError` | Yes |
| API Keys | `UnPriceApiKeyError` | Yes |
| Plans | (none — uses `FetchError`) | Add `UnPricePlanError` |

Use cases can define operation-specific errors or reuse these domain errors.
Don't create a new error class per use case — that's overkill.

---

## Logging Strategy

### Current state (measured)

- **128** `this.logger.*` calls across 12 service files
- No standard for what gets logged where
- `logger.set()` (wide event context) and `logger.error()` (message logs) are mixed
- Only 5 files use `toErrorContext()` for structured error data
- Some errors are logged AND returned as `Err()` — some are only returned, some only logged

### The problem

Three inconsistencies:

**1. Log-and-return vs return-only vs log-and-throw**

```typescript
// Pattern A: log + return Err (customers/service.ts — good, but verbose)
this.logger.set({ error: toErrorContext(err) })
this.logger.error("error getting customer", { error: err.message })
return Err(new FetchError({ message: err.message }))

// Pattern B: return Err only (plans/service.ts — loses observability)
return Err(new FetchError({ message: err.message }))

// Pattern C: log + throw (billing/service.ts — breaks Result contract)
this.logger.error("error in billing", { error: err.message })
throw err
```

No one knows which pattern to use. Agents copy whichever they see first.

**2. Wide event context (`logger.set`) is inconsistent**

`CustomerService` sets `{ customers: { operation, name, ... } }`.
`EntitlementService` sets `{ business: { ... } }` and `{ entitlements: { ... } }`.
`BillingService` sets `{ lock: { ... } }`.
No shared vocabulary for context keys.

**3. Error context is unstructured**

Only 5 files use `toErrorContext()`. The rest pass `{ error: err.message }` or
`{ error: err }` directly — losing type, stack, and structured metadata.

### The rule: log at the boundary, enrich in the service

**Where to log:**

| Layer | What to log | How |
|-------|------------|-----|
| **Use case** | Operation start + outcome (success/failure) | `logger.set({ business: { operation, ... } })` at start. Return `Result`, let the caller log the outcome. |
| **Service method** | Only unexpected failures (DB errors, cache misses worth tracking) | `logger.warn()` or `logger.error()` with `toErrorContext()` |
| **Router (tRPC/Hono)** | Nothing — the middleware already logs request/response | The `publicProcedure` middleware and Hono `init.ts` handle this |

**The key principle:** The tRPC `publicProcedure` middleware (trpc.ts:335-406) already
logs every request outcome with duration, status, and flushes the wide event. Services
don't need to duplicate this. Services should **enrich** the wide event with business
context (`logger.set()`), not emit their own log lines for expected flows.

**When a service SHOULD log:**
- `logger.warn()` — a retry happened, a cache miss was unexpected, a fallback was used
- `logger.error()` — an unrecoverable internal failure (not a business error)
- `logger.set({ business: ... })` — adding context to the wide event

**When a service should NOT log:**
- "Customer not found" — that's a business result, not a log event. Return `Ok(null)`.
- "Plan version not found" — same. Return the `Result`, let the caller decide.
- Any expected error path — return `Err()`, don't log.

### Structured error context — always use `toErrorContext()`

```typescript
// BAD
this.logger.error("something failed", { error: err.message })

// GOOD
this.logger.error("something failed", { error: toErrorContext(err) })
```

This preserves error type, message, and stack in the wide event.

### Wide event context keys — standardize

```typescript
// Business context (set once per operation)
this.logger.set({
  business: {
    operation: "customer.sign_up",     // always: domain.verb
    customer_id: customerId,           // entity IDs relevant to the operation
    project_id: projectId,
    plan_version_id: planVersionId,
  }
})

// Error context (only on unexpected failures)
this.logger.set({
  error: toErrorContext(err)
})
```

Don't invent per-service context keys (`customers: { ... }`, `entitlements: { ... }`).
Use `business` for operation context and `error` for error context. The wide event
middleware at the router layer already handles `request`, `geo`, `cloud`, `duration`.

---

## Transaction Propagation — Critical Missing Piece

### The problem

Use cases own transaction boundaries, but services are constructed with a fixed
`this.db`. When `signUp` needs to create a customer, subscription, and phase
atomically, the use case must open a transaction and pass it down to service
write methods. Without this, "use case owns the transaction" is not implementable.

### Current state

`CustomerService.handleDirectProvisioningFlow()` opens `this.db.transaction()`
and then calls `subscriptionService.createSubscription()` passing the `trx`
object explicitly via an `opts.db` parameter. This pattern already exists in
the codebase but is inconsistent.

### The pattern: optional `db` executor on write methods

```typescript
// Type alias for the executor
type DbExecutor = Database | Transaction

// Service write method accepts optional executor
class SubscriptionService {
  async createSubscription(
    input: CreateSubscriptionInput,
    opts?: { db?: DbExecutor }
  ): Promise<Result<Subscription, UnPriceSubscriptionError>> {
    const db = opts?.db ?? this.db  // fall back to the injected db
    // ... use `db` for all queries
  }
}

// Use case opens the transaction, passes it down
export async function signUp(deps: SignUpDeps, input: SignUpInput) {
  // deps.db is the raw Database — use cases that need transactions declare it in their deps
  return deps.db.transaction(async (tx) => {
    const customer = await deps.services.customers.create(input, { db: tx })
    const sub = await deps.services.subscriptions.createSubscription({ ... }, { db: tx })
    const phase = await deps.services.subscriptions.createPhase({ ... }, { db: tx })
    // External side effects AFTER the transaction commits (see rules below)
    return Ok({ customerId: customer.id })
  })
}
```

### Rules
- **Read methods** never need a tx — they use the service's injected `this.db`
- **Write methods** that participate in cross-service transactions accept
  `opts?: { db?: DbExecutor }`
- **Use cases** open transactions when atomicity is needed; services never open
  transactions themselves (they did before but this moves to use cases)
- **External side effects** (Stripe, analytics) must happen AFTER the transaction
  commits — never inside the tx callback. Use `waitUntil` for fire-and-forget
  side effects after the happy path

### Migration note

The existing `db: trx` parameter in `createSubscription` and `createPhase`
already follows this pattern. Standardize it across all write methods during
P0 extraction.

---

## TODO Checklist

Items are ordered by dependency — an agent should work top to bottom within each phase.
Each item is self-contained: it has a clear input, output, and verification step.

### Execution discipline (required)

- After each checklist point is completed, create a commit before starting the next point.
- Run validation hooks/checks for that point before committing.
- If validation fails, fix the issues first, then commit, then continue.
- Keep and commit formatting or lint changes produced by validation hooks in the same checkpoint commit.

### P0.1 — Infrastructure prerequisites

These unblock everything else. Do them first, in order.

- [x] **Move infra out of Hono services bag**
  - Files: `apps/api/src/middleware/init.ts`, `apps/api/src/hono/env.ts`
  - What: Move `logger`, `analytics`, `db`, `waitUntil`, `metrics` from `c.set("services", { ... })`
    to separate `c.set("logger", logger)`, `c.set("db", db)`, etc. Keep only domain services
    in the services bag (`customer`, `subscription`, `entitlement`, `plans`, `ingestion`,
    `project`, `apikey`).
  - Update `HonoEnv` type: add `logger`, `analytics`, `db`, `waitUntil`, `metrics` as
    top-level Variables alongside `services`.
  - Update all routes that destructure infra from `c.get("services")` to use
    `c.get("logger")`, `c.get("db")`, etc. instead.
  - Note: tRPC already has these as separate context fields — no change needed there.
  - Verify: `pnpm --filter api test` passes, `npx tsc --noEmit -p apps/api/tsconfig.json`
    has no new errors.

- [x] **Define `DbExecutor` type alias**
  - File: `internal/services/src/deps.ts`
  - What: Add `export type DbExecutor = Database | Transaction` (import Transaction from
    Drizzle). This type is used by service write methods that participate in cross-service
    transactions.
  - Verify: typecheck passes.

- [x] **Add use-case conventions to root CLAUDE.md**
  - File: `CLAUDE.md` at repo root
  - What: Add the "Use Cases" section from the CLAUDE.md conventions block in this doc
    (see "CLAUDE.md conventions" section above). This tells agents where to put logic
    and which pattern to follow.
  - Verify: read it back, make sure the pattern and rules are clear.

- [x] **Create `internal/services/src/use-cases/` directory structure**
  - What: Create the directory and add an empty barrel export:
    `internal/services/src/use-cases/index.ts` with `export {}`.
    Add `"./use-cases": "./src/use-cases/index.ts"` to `@unprice/services` package.json exports.
  - Do NOT create domain subdirectories yet — they get created when the first use case
    in each domain is extracted.
  - Verify: typecheck passes.

### P0.2 — First vertical slices (prove the pattern)

Each item extracts one operation. Work top to bottom — each builds on the previous.

- [x] **`plan/create` — move to use-case shape**
  - Already extracted to `PlanService.createPlan()`. Move the logic into
    `use-cases/plan/create.ts` as a function: `createPlan(deps, input) -> Result`.
  - Deps: `{ services: Pick<ServiceContext, "plans">, db: Database, logger: Logger }`
  - Update the tRPC procedure `plans/create.ts` to call the use case.
  - Delete `PlanService.createPlan()` — the use case replaces it.
  - Verify: `pnpm --filter @unprice/services test` passes, tRPC typecheck passes.

- [x] **`customer/get-by-id` — thin router, no use case**
  - This is a simple read — it should call the service directly, not a use case.
  - File: `internal/trpc/src/router/lambda/customers/getById.ts`
  - What: Replace `opts.ctx.db.query.customers.findFirst(...)` with
    `opts.ctx.services.customers.getCustomer(customerId)`.
  - If `CustomerService.getCustomer()` doesn't return the right shape, add a new
    service method that does. Don't create a use case for a single cached query.
  - Verify: tRPC typecheck passes.

- [x] **`subscription/create` — extract to use case**
  - File: create `use-cases/subscription/create.ts`
  - Extract from `SubscriptionService.createSubscription()`. The use case opens the
    transaction, calls service write methods with `{ db: tx }`.
  - Deps: `{ services: Pick<ServiceContext, "customers" | "subscriptions">, db: Database, logger: Logger }`
  - Update the tRPC procedure `subscriptions/create.ts` to call the use case.
  - Verify: `pnpm --filter @unprice/services test` passes, tRPC typecheck passes.

- [x] **`customer/sign-up` — extract the complex proof**
  - File: create `use-cases/customer/sign-up.ts`
  - Extract from `CustomerService.signUp()` (~200 lines). This is the hardest one:
    - Transaction boundary moves to the use case (`deps.db.transaction(...)`)
    - External side effects (analytics, Stripe) happen AFTER tx commits via `waitUntil`
    - The circular dep `CustomerService -> SubscriptionService` may become unnecessary
      — the use case calls both services directly
  - Deps: `{ services: Pick<ServiceContext, "plans" | "customers" | "subscriptions">, db: Database, logger: Logger, analytics: Analytics, waitUntil: ... }`
  - Update both the tRPC procedure AND the Hono route `signUpV1.ts` to call the use case.
  - Delete `CustomerService.signUp()` once both callers are migrated.
  - Verify: `pnpm --filter @unprice/services test` + `pnpm --filter api test` pass.

### P0.3 — Batch migration of remaining tRPC files

After the pattern is proven with P0.2, batch-migrate the remaining 72 tRPC files.

- [x] **Triage the remaining tRPC files into categories**
  - Run: `grep -rl "opts\.ctx\.db\.\|ctx\.db\." internal/trpc/src/router/lambda/`
  - For each file, decide:
    - **Simple query (<15 lines, single DB call)** -> Add service method, call from procedure
    - **Simple CRUD insert/update** -> Add service method, call from procedure
    - **Multi-step orchestration** -> Extract to use case
  - Write the triage result as a checklist (file -> category -> target service or use case)
  - Triage output (71 files remaining after P0.2 migrations):
    - [ ] `internal/trpc/src/router/lambda/analytics/getBrowserVisits.ts` -> `simple-query` -> `service:analytics.getBrowserVisits`
    - [ ] `internal/trpc/src/router/lambda/analytics/getCountryVisits.ts` -> `simple-query` -> `service:analytics.getCountryVisits`
    - [ ] `internal/trpc/src/router/lambda/analytics/getOverviewStats.ts` -> `simple-query` -> `service:analytics.getOverviewStats`
    - [ ] `internal/trpc/src/router/lambda/analytics/getPagesOverview.ts` -> `simple-query` -> `service:analytics.getPagesOverview`
    - [ ] `internal/trpc/src/router/lambda/analytics/getRealtimeTicket.ts` -> `simple-query` -> `service:analytics.getRealtimeTicket`
    - [ ] `internal/trpc/src/router/lambda/apikeys/listByActiveProject.ts` -> `simple-query` -> `service:apikeys.listByActiveProject`
    - [ ] `internal/trpc/src/router/lambda/customers/exist.ts` -> `simple-query` -> `service:customers.exist`
    - [ ] `internal/trpc/src/router/lambda/customers/getByEmail.ts` -> `simple-query` -> `service:customers.getByEmail`
    - [ ] `internal/trpc/src/router/lambda/customers/getByIdActiveProject.ts` -> `simple-query` -> `service:customers.getByIdActiveProject`
    - [ ] `internal/trpc/src/router/lambda/customers/getInvoiceById.ts` -> `simple-query` -> `service:customers.getInvoiceById`
    - [ ] `internal/trpc/src/router/lambda/customers/getInvoices.ts` -> `simple-query` -> `service:customers.getInvoices`
    - [ ] `internal/trpc/src/router/lambda/customers/getSubscriptions.ts` -> `simple-query` -> `service:customers.getSubscriptions`
    - [ ] `internal/trpc/src/router/lambda/customers/listByActiveProject.ts` -> `simple-query` -> `service:customers.listByActiveProject`
    - [ ] `internal/trpc/src/router/lambda/customers/update.ts` -> `simple-crud` -> `service:customers.update`
    - [ ] `internal/trpc/src/router/lambda/domains/create.ts` -> `simple-crud` -> `service:domains.create`
    - [ ] `internal/trpc/src/router/lambda/domains/exists.ts` -> `simple-query` -> `service:domains.exists`
    - [ ] `internal/trpc/src/router/lambda/domains/getAllByActiveWorkspace.ts` -> `simple-query` -> `service:domains.getAllByActiveWorkspace`
    - [ ] `internal/trpc/src/router/lambda/domains/remove.ts` -> `simple-crud` -> `service:domains.remove`
    - [ ] `internal/trpc/src/router/lambda/domains/update.ts` -> `simple-crud` -> `service:domains.update`
    - [ ] `internal/trpc/src/router/lambda/events/listByActiveProject.ts` -> `simple-query` -> `service:events.listByActiveProject`
    - [ ] `internal/trpc/src/router/lambda/events/update.ts` -> `simple-crud` -> `service:events.update`
    - [ ] `internal/trpc/src/router/lambda/features/exist.ts` -> `simple-query` -> `service:features.exist`
    - [ ] `internal/trpc/src/router/lambda/features/getById.ts` -> `simple-query` -> `service:features.getById`
    - [ ] `internal/trpc/src/router/lambda/features/getBySlug.ts` -> `simple-query` -> `service:features.getBySlug`
    - [ ] `internal/trpc/src/router/lambda/features/listByActiveProject.ts` -> `simple-query` -> `service:features.listByActiveProject`
    - [ ] `internal/trpc/src/router/lambda/features/searchBy.ts` -> `simple-query` -> `service:features.searchBy`
    - [ ] `internal/trpc/src/router/lambda/features/update.ts` -> `simple-crud` -> `service:features.update`
    - [ ] `internal/trpc/src/router/lambda/pages/getByDomain.ts` -> `simple-query` -> `service:pages.getByDomain`
    - [ ] `internal/trpc/src/router/lambda/pages/getById.ts` -> `simple-query` -> `service:pages.getById`
    - [ ] `internal/trpc/src/router/lambda/pages/listByActiveProject.ts` -> `simple-query` -> `service:pages.listByActiveProject`
    - [ ] `internal/trpc/src/router/lambda/pages/update.ts` -> `simple-crud` -> `service:pages.update`
    - [ ] `internal/trpc/src/router/lambda/paymentProvider/getConfig.ts` -> `simple-query` -> `service:paymentProvider.getConfig`
    - [ ] `internal/trpc/src/router/lambda/planVersionFeatures/create.ts` -> `simple-crud` -> `service:planVersionFeatures.create`
    - [ ] `internal/trpc/src/router/lambda/planVersionFeatures/getById.ts` -> `simple-query` -> `service:planVersionFeatures.getById`
    - [ ] `internal/trpc/src/router/lambda/planVersionFeatures/getByPlanVersionId.ts` -> `simple-query` -> `service:planVersionFeatures.getByPlanVersionId`
    - [ ] `internal/trpc/src/router/lambda/planVersionFeatures/remove.ts` -> `simple-crud` -> `service:planVersionFeatures.remove`
    - [ ] `internal/trpc/src/router/lambda/planVersionFeatures/update.ts` -> `simple-crud` -> `service:planVersionFeatures.update`
    - [ ] `internal/trpc/src/router/lambda/planVersions/create.ts` -> `simple-crud` -> `service:planVersions.create`
    - [ ] `internal/trpc/src/router/lambda/planVersions/deactivate.ts` -> `simple-crud` -> `service:planVersions.deactivate`
    - [ ] `internal/trpc/src/router/lambda/planVersions/duplicate.ts` -> `orchestration` -> `use-case:plan-version/duplicate.ts`
    - [ ] `internal/trpc/src/router/lambda/planVersions/getById.ts` -> `simple-query` -> `service:planVersions.getById`
    - [ ] `internal/trpc/src/router/lambda/planVersions/listByProjectUnprice.ts` -> `simple-query` -> `service:planVersions.listByProjectUnprice`
    - [ ] `internal/trpc/src/router/lambda/planVersions/publish.ts` -> `orchestration` -> `use-case:plan-version/publish.ts`
    - [ ] `internal/trpc/src/router/lambda/planVersions/remove.ts` -> `simple-crud` -> `service:planVersions.remove`
    - [ ] `internal/trpc/src/router/lambda/planVersions/update.ts` -> `simple-crud` -> `service:planVersions.update`
    - [ ] `internal/trpc/src/router/lambda/plans/exist.ts` -> `simple-query` -> `service:plans.exist`
    - [ ] `internal/trpc/src/router/lambda/plans/getById.ts` -> `simple-query` -> `service:plans.getById`
    - [ ] `internal/trpc/src/router/lambda/plans/getBySlug.ts` -> `simple-query` -> `service:plans.getBySlug`
    - [ ] `internal/trpc/src/router/lambda/plans/getSubscriptionsBySlug.ts` -> `simple-query` -> `service:plans.getSubscriptionsBySlug`
    - [ ] `internal/trpc/src/router/lambda/plans/getVersionsBySlug.ts` -> `simple-query` -> `service:plans.getVersionsBySlug`
    - [ ] `internal/trpc/src/router/lambda/plans/listByActiveProject.ts` -> `simple-query` -> `service:plans.listByActiveProject`
    - [ ] `internal/trpc/src/router/lambda/plans/update.ts` -> `simple-crud` -> `service:plans.update`
    - [ ] `internal/trpc/src/router/lambda/projects/getById.ts` -> `simple-query` -> `service:projects.getById`
    - [ ] `internal/trpc/src/router/lambda/projects/getBySlug.ts` -> `simple-query` -> `service:projects.getBySlug`
    - [ ] `internal/trpc/src/router/lambda/projects/listByActiveWorkspace.ts` -> `simple-query` -> `service:projects.listByActiveWorkspace`
    - [ ] `internal/trpc/src/router/lambda/projects/listByWorkspace.ts` -> `simple-query` -> `service:projects.listByWorkspace`
    - [ ] `internal/trpc/src/router/lambda/projects/transferToPersonal.ts` -> `orchestration` -> `use-case:project/transfer-to-personal.ts`
    - [ ] `internal/trpc/src/router/lambda/projects/transferToWorkspace.ts` -> `orchestration` -> `use-case:project/transfer-to-workspace.ts`
    - [ ] `internal/trpc/src/router/lambda/projects/update.ts` -> `simple-crud` -> `service:projects.update`
    - [ ] `internal/trpc/src/router/lambda/subscriptions/getById.ts` -> `simple-query` -> `service:subscriptions.getById`
    - [ ] `internal/trpc/src/router/lambda/subscriptions/listByActiveProject.ts` -> `simple-query` -> `service:subscriptions.listByActiveProject`
    - [ ] `internal/trpc/src/router/lambda/subscriptions/listByPlanVersion.ts` -> `simple-query` -> `service:subscriptions.listByPlanVersion`
    - [ ] `internal/trpc/src/router/lambda/workspaces/create.ts` -> `simple-crud` -> `service:workspaces.create`
    - [ ] `internal/trpc/src/router/lambda/workspaces/delete.ts` -> `simple-crud` -> `service:workspaces.delete`
    - [ ] `internal/trpc/src/router/lambda/workspaces/deleteMember.ts` -> `simple-crud` -> `service:workspaces.deleteMember`
    - [ ] `internal/trpc/src/router/lambda/workspaces/getBySlug.ts` -> `simple-query` -> `service:workspaces.getBySlug`
    - [ ] `internal/trpc/src/router/lambda/workspaces/inviteMember.ts` -> `orchestration` -> `use-case:workspace/invite-member.ts`
    - [ ] `internal/trpc/src/router/lambda/workspaces/listInvitesByActiveWorkspace.ts` -> `simple-query` -> `service:workspaces.listInvitesByActiveWorkspace`
    - [ ] `internal/trpc/src/router/lambda/workspaces/listMembersByActiveWorkspace.ts` -> `simple-query` -> `service:workspaces.listMembersByActiveWorkspace`
    - [ ] `internal/trpc/src/router/lambda/workspaces/listWorkspacesByActiveUser.ts` -> `simple-query` -> `service:workspaces.listWorkspacesByActiveUser`
    - [ ] `internal/trpc/src/router/lambda/workspaces/resendInvite.ts` -> `orchestration` -> `use-case:workspace/resend-invite.ts`

- [ ] **Migrate simple queries by domain** (one commit per domain):
  - [x] `plans/` — getById, getBySlug, listByActiveProject, exist, getVersionsBySlug, getSubscriptionsBySlug
  - [x] `customers/` — getById, getByEmail, exist, getSubscriptions, getInvoices, getInvoiceById, listByActiveProject
  - [x] `features/` — getById, getBySlug, searchBy, listByActiveProject, exist
  - [x] `pages/` — getById, getByDomain, listByActiveProject, update
  - `workspaces/` — getBySlug, listMembersByActiveWorkspace, listInvitesByActiveWorkspace, listWorkspacesByActiveUser
  - `domains/` — exists, getAllByActiveWorkspace, create, update, remove
  - `projects/` — getById, getBySlug, listByActiveWorkspace, listByWorkspace
  - `analytics/` — getOverviewStats, getCountryVisits, getBrowserVisits, getPagesOverview, getRealtimeTicket
  - `subscriptions/` — getById, listByActiveProject, listByPlanVersion
  - `planVersions/` — getById, create, update, duplicate, deactivate, remove
  - `planVersionFeatures/` — getById, getByPlanVersionId, create, update, remove
  - `events/` — listByActiveProject, update
  - `apikeys/` — listByActiveProject
  - `workspaces/` mutations — create, delete, deleteMember, inviteMember, resendInvite
  - `projects/` mutations — update, transferToWorkspace, transferToPersonal

- [ ] **Extract remaining orchestrations to use cases**
  - After triage, extract each identified orchestration to `use-cases/{domain}/{operation}.ts`
  - Follow the same pattern established in P0.2

- [ ] **Audit `CustomerService.setSubscriptionService()` circular dep**
  - After `customer/sign-up` is a use case, check if `CustomerService` still needs
    `SubscriptionService`. If only the old `signUp()` method used it and that's now
    deleted, remove `setSubscriptionService()` and the circular dep entirely.
  - If a remaining service method still needs it, document why.

### P0.5 — Error handling standardization (do alongside P0.2/P0.3)

Apply these rules to every file you touch during P0. Don't do a separate sweep.

- [ ] **Fix `throw err` re-throws in catch blocks**
  - There are 17 across services. When you touch a service file during P0, fix its
    re-throws: replace `throw err` with `return Err(new FetchError({ message: err.message }))`.
  - Files: `billing/service.ts` (2), `customers/service.ts` (2), `subscriptions/service.ts` (2),
    `subscriptions/invokes.ts` (4), `entitlements/grants.ts` (1), `plans/service.ts` (3),
    `projects/service.ts` (1), `utils/retry.ts` (1)
  - Rule: public methods return `Result`, never throw. Private methods may throw only
    for programmer errors (assertion failures, invariant violations).

- [ ] **Adopt `toErrorContext()` in all service files**
  - Currently only 5 of 12 files use it. When you touch a service file, replace
    `{ error: err.message }` with `{ error: toErrorContext(err) }` in all logger calls.

- [ ] **Add `UnPricePlanError`**
  - File: `internal/services/src/plans/errors.ts` (create if not exists)
  - Plans currently use generic `FetchError`. Create `UnPricePlanError` following the
    pattern in `customers/errors.ts`.

### P0.5 — Logging standardization (do alongside P0.2/P0.3)

Apply these rules to every file you touch during P0. Don't do a separate sweep.

- [ ] **Standardize wide event context keys**
  - In use cases: `logger.set({ business: { operation: "domain.verb", ...entity_ids } })`
  - In services: only `logger.warn()` or `logger.error()` for unexpected failures.
    Use `{ error: toErrorContext(err) }` for error context.
  - Remove per-service custom keys (`customers: { ... }`, `entitlements: { ... }`).
    Use `business` for operation context everywhere.

- [ ] **Remove logging of expected error paths**
  - "Customer not found" is `Ok(null)`, not a log event.
  - "Plan version not found" is `Ok(null)`, not a log event.
  - Only log `warn/error` for unexpected failures (DB connection lost, cache unavailable).

### P2 — Cross-cutting cleanup (after P0 is stable)

- [ ] **Extract cache.swr + retry into reusable wrapper**
  - There are 13 identical cache patterns across 5 service files. Write a generic
    `cachedQuery()` function that encapsulates: skipCache branching, `retry(3, ...)`,
    `cache.swr()`, error wrapping, and logging.
  - File: `internal/services/src/utils/cached-query.ts`
  - Then update all 13 call sites to use the wrapper.
  - Verify: `pnpm --filter @unprice/services test` passes.

- [ ] **Create PaymentProviderResolver service**
  - File: `internal/services/src/payment-provider/resolver.ts`
  - Extract from `CustomerService.getPaymentProviderService()` (lines ~760-785):
    DB lookup for provider config, token decryption, provider instantiation.
  - Add to `createServiceContext` factory, inject into `CustomerService`.
  - Delete `CustomerService.getPaymentProviderService()`.
  - Verify: `pnpm --filter @unprice/services test` passes.
