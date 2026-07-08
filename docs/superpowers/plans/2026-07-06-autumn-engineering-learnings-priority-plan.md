# Autumn Engineering Learnings Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the highest-value Autumn engineering learnings into Unprice test and reliability work, starting with the money-path runtime gaps that are not covered by today's fake Durable Object tests.

**Architecture:** Keep Unprice's ledger-first money model. Add a separate Cloudflare workers-pool Vitest lane for runtime semantics, then layer deterministic convergence, race, job, and HTTP idempotency tests around existing service and API ownership boundaries. Do not move business logic into adapters; each new assertion should prove an invariant at the owning layer.

**Tech Stack:** TypeScript, Vitest, `@cloudflare/vitest-pool-workers`, Cloudflare Durable Objects, Hono, Drizzle, Result/Ok/Err, pgledger-backed wallet and billing services.

---

## Source Analysis

Source audit: `docs/plans/autumn-engineering-learnings.md`.

Priority heuristic:

```text
highest priority = money correctness x runtime blind spot x current coverage gap / implementation effort
```

Ranked outcome:

1. Add a real `workerd` Durable Object test lane. This is the largest blind spot because `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts` and `apps/api/src/ingestion/run-budget/RunBudgetDO.test.ts` currently use hand-rolled fake state.
2. Port the cheapest high-value `EntitlementWindowDO` invariants into that lane first: concurrent hard-limit partitioning, per-entitlement isolation, lazy reset, alarm/eviction persistence.
3. Add generic convergence and deterministic race helpers so future money-path tests assert hot state and durable truth without fixed sleeps.
4. Add `internal/jobs` tests. Trigger schedules currently call production money mutations, but `internal/jobs/package.json` has no test script and the package has no tests.
5. Add the HTTP idempotency contract and middleware foundation after the runtime and job gaps. Endpoint contracts already carry `x-unprice.idempotency`; the missing pieces are a tested lifecycle primitive, an OpenAPI-walking enforcement test, and a durable Cloudflare store before production wiring.
6. Split the durable idempotency store, provider rollback, health/readiness, k6 nightly, and wallet breakdown assertions into follow-up plans after the first five tasks land. They are valuable, but they touch independent subsystems.

## Scope Cuts

- Do not replace fake Durable Object tests. They remain fast unit coverage for branch-heavy logic.
- Do not move ledger truth into Durable Object storage or Redis-like write-behind state.
- Do not add dashboard browser E2E in this plan.
- Do not add API V2 translation in this plan.
- Do not wire k6 nightly in this plan. Keep it as the first follow-up once runtime correctness coverage is in CI.
- Do not introduce test-only production branches. Test helpers may use exported fixtures or `cloudflare:test` introspection, but product code should not branch on `NODE_ENV` for correctness.

## File Structure

**Workers runtime lane**
- Modify: `apps/api/package.json`
  - Add `@cloudflare/vitest-pool-workers` as an API dev dependency.
  - Add `test:workers`.
- Create: `apps/api/vitest.workers.config.ts`
  - Runs only `src/**/*.workers.test.ts`.
  - Loads `apps/api/wrangler.jsonc` with the `dev` environment.
- Create: `apps/api/src/worker-runtime-env.d.ts`
  - Narrows `cloudflare:workers` provided env for tests.
- Create: `apps/api/src/ingestion/durable-objects.workers.test.ts`
  - Smoke-tests `entitlementwindow` and `runbudget` bindings inside `workerd`.

**EntitlementWindowDO runtime invariants**
- Create: `apps/api/src/ingestion/entitlements/entitlement-window-test-fixtures.ts`
  - Shared fixture builder extracted from existing fake tests.
- Create: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.workers.test.ts`
  - Real-runtime concurrent hard-limit, isolation, lazy-reset, alarm, and eviction tests.

**Shared test helpers**
- Create: `apps/api/src/ingestion/test-fixtures/race.ts`
  - Deferred gates and ordered race scripting utilities.
- Create: `internal/services/src/test-fixtures/convergence.ts`
  - Poll-until assertion helper for state-to-ledger convergence without fixed sleeps.

**Jobs coverage**
- Modify: `internal/jobs/package.json`
  - Add `test` and Vitest dev dependency.
- Create: `internal/jobs/vitest.config.ts`
  - Package-local Vitest config.
- Create: `internal/jobs/src/trigger/tasks/tasks.test.ts`
  - Billing/invoice/renew task idempotency and per-tenant serialization tests around service calls and lock behavior.
- Create: `internal/jobs/src/trigger/schedules/schedules.test.ts`
  - Schedule fanout tests proving due rows are selected once and empty schedules do no work.

**HTTP idempotency**
- Create: `apps/api/src/middleware/idempotency.ts`
  - Hono middleware implementing success-retain and 5xx-release lifecycle.
- Create: `apps/api/src/middleware/idempotency.test.ts`
  - Unit coverage for lifecycle rules.
- Modify: `apps/api/src/openapi/public-operation-contracts.test.ts`
  - Fail if mutating public runtime/money endpoints omit idempotency metadata.

## Task 1: Add The Workers Runtime Test Lane

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/vitest.workers.config.ts`
- Create: `apps/api/src/worker-runtime-env.d.ts`
- Create: `apps/api/src/ingestion/durable-objects.workers.test.ts`

- [ ] **Step 1: Install the workers-pool dependency**

Run from the repo root:

```bash
corepack pnpm --filter api add -D @cloudflare/vitest-pool-workers
```

Expected:

```text
apps/api/package.json includes @cloudflare/vitest-pool-workers in devDependencies
pnpm-lock.yaml is updated
```

- [ ] **Step 2: Add the workers test script**

Modify `apps/api/package.json` scripts to include:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:workers": "vitest run --config vitest.workers.config.ts",
    "test:file": "vitest run \"$@\""
  }
}
```

- [ ] **Step 3: Create the workers Vitest config**

Create `apps/api/vitest.workers.config.ts`:

```ts
import { resolve } from "node:path"
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
        environment: "dev",
      },
      miniflare: {
        bindings: {
          APP_ENV: "test",
          NODE_ENV: "test",
          SKIP_ENV_VALIDATION: "true",
          AUTH_SECRET: "test_auth_secret_000000000000000000",
          REALTIME_TICKET_SECRET: "test_realtime_secret_000000000000000",
          CLOUDFLARE_ACCOUNT_ID: "test_account",
          DATABASE_URL: "postgres://user:pass@localhost:5432/unprice",
          DATABASE_READ1_URL: "postgres://user:pass@localhost:5432/unprice",
          DATABASE_READ2_URL: "postgres://user:pass@localhost:5432/unprice",
          TINYBIRD_TOKEN: "test_tinybird_token",
          TINYBIRD_URL: "https://example.com",
          AXIOM_API_TOKEN: "",
          AXIOM_DATASET: "",
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "~": resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.workers.test.ts"],
    testTimeout: 20_000,
  },
})
```

- [ ] **Step 4: Add worker env typing for tests**

Create `apps/api/src/worker-runtime-env.d.ts`:

```ts
import type { Env } from "~/env"

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
```

- [ ] **Step 5: Add runtime binding smoke tests**

Create `apps/api/src/ingestion/durable-objects.workers.test.ts`:

```ts
import { env } from "cloudflare:workers"
import { reset, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { EntitlementWindowDO } from "~/ingestion/entitlements/EntitlementWindowDO"
import { RunBudgetDO } from "~/ingestion/run-budget/RunBudgetDO"

afterEach(async () => {
  await reset()
})

describe("Durable Object workers runtime bindings", () => {
  it("binds EntitlementWindowDO inside workerd", async () => {
    const stub = env.entitlementwindow.getByName("test:workers:entitlementwindow:smoke")

    await runInDurableObject(stub, async (instance: EntitlementWindowDO, state) => {
      expect(instance).toBeInstanceOf(EntitlementWindowDO)
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })

  it("binds RunBudgetDO inside workerd", async () => {
    const stub = env.runbudget.getByName("test:workers:runbudget:smoke")

    await runInDurableObject(stub, async (instance: RunBudgetDO, state) => {
      expect(instance).toBeInstanceOf(RunBudgetDO)
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })
})
```

- [ ] **Step 6: Run the new lane**

Run:

```bash
corepack pnpm --filter api test:workers
```

Expected:

```text
Test Files  1 passed
Tests       2 passed
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/vitest.workers.config.ts apps/api/src/worker-runtime-env.d.ts apps/api/src/ingestion/durable-objects.workers.test.ts
git commit -m "test(api): add workers runtime durable object lane"
```

## Task 2: Port The First EntitlementWindowDO Runtime Invariants

**Files:**
- Create: `apps/api/src/ingestion/entitlements/entitlement-window-test-fixtures.ts`
- Create: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.workers.test.ts`

- [ ] **Step 1: Extract a reusable EntitlementWindowDO input fixture**

Create `apps/api/src/ingestion/entitlements/entitlement-window-test-fixtures.ts`:

```ts
export const BASE_NOW = Date.UTC(2026, 2, 19, 12, 0, 0)

const DEFAULT_METER_CONFIG = {
  aggregationField: "amount",
  aggregationMethod: "sum" as const,
  eventId: "meter_123",
  eventSlug: "tokens_used",
}

const DEFAULT_PRICE_CONFIG = {
  usageMode: "unit" as const,
  price: {
    dinero: {
      amount: 100,
      currency: { code: "USD", base: 10, exponent: 2 },
      scale: 2,
    },
    displayAmount: "1.00",
  },
}

export function createGrantSnapshot(overrides: Record<string, unknown> = {}) {
  const amount =
    typeof overrides.allowanceUnits === "number"
      ? overrides.allowanceUnits
      : typeof overrides.amount === "number"
        ? overrides.amount
        : null

  return {
    allowanceUnits: amount,
    amount,
    cadenceEffectiveAt: BASE_NOW - 60_000,
    cadenceExpiresAt: BASE_NOW + 60_000,
    currencyCode: "USD",
    effectiveAt: BASE_NOW - 60_000,
    expiresAt: BASE_NOW + 60_000,
    grantId: "grant_123",
    priority: 10,
    resetConfig: null,
    ...overrides,
  }
}

export function createApplyInput(overrides: Record<string, unknown> = {}) {
  const projectId = (overrides.projectId as string | undefined) ?? "proj_123"
  const customerId = (overrides.customerId as string | undefined) ?? "cus_123"
  const customerEntitlementId = (overrides.customerEntitlementId as string | undefined) ?? "ce_123"
  const periodStartAt =
    typeof overrides.periodStartAt === "number" ? overrides.periodStartAt : BASE_NOW - 60_000
  const periodEndAt =
    typeof overrides.periodEndAt === "number" ? overrides.periodEndAt : BASE_NOW + 60_000
  const resetConfig = (overrides.resetConfig as Record<string, unknown> | null | undefined) ?? null
  const currencyCode = typeof overrides.currency === "string" ? overrides.currency : "USD"
  const limit = typeof overrides.limit === "number" ? overrides.limit : null
  const grantSnapshots = (overrides.grants as ReturnType<typeof createGrantSnapshot>[] | undefined) ?? [
    createGrantSnapshot({
      amount: limit,
      cadenceEffectiveAt: periodStartAt,
      cadenceExpiresAt: periodEndAt,
      currencyCode,
      effectiveAt: periodStartAt,
      expiresAt: periodEndAt,
      resetConfig,
    }),
  ]
  const subscriptionItemId =
    typeof overrides.subscriptionItemId === "string" ? overrides.subscriptionItemId : "item_123"
  const featurePlanVersionId =
    typeof overrides.featurePlanVersionId === "string" ? overrides.featurePlanVersionId : "fpv_123"
  const meterConfig =
    (overrides.meterConfig as typeof DEFAULT_METER_CONFIG | undefined) ?? DEFAULT_METER_CONFIG
  const priceConfig =
    (overrides.priceConfig as typeof DEFAULT_PRICE_CONFIG | undefined) ?? DEFAULT_PRICE_CONFIG
  const eventOverrides = (overrides.event as Record<string, unknown> | undefined) ?? {}

  const entitlement = {
    billingPeriods: [
      {
        billingPeriodId: "bp_123",
        cycleEndAt: periodEndAt,
        cycleStartAt: periodStartAt,
        featurePlanVersionItemId: subscriptionItemId,
        statementKey: "stmt_123",
      },
    ],
    creditLinePolicy:
      typeof overrides.creditLinePolicy === "string" ? overrides.creditLinePolicy : "uncapped",
    customerEntitlementId,
    customerId,
    effectiveAt: periodStartAt,
    expiresAt: periodEndAt,
    featureConfig: priceConfig,
    featurePlanVersionId,
    featureSlug: (overrides.featureSlug as string | undefined) ?? "api_calls",
    featureType: "usage",
    meterConfig,
    overageStrategy:
      typeof overrides.overageStrategy === "string" ? overrides.overageStrategy : "none",
    projectId,
    resetConfig,
    subscriptionItemId,
  }

  return {
    customerId,
    entitlement,
    enforceLimit: (overrides.enforceLimit as boolean | undefined) ?? false,
    event: {
      id: "evt_123",
      properties: { amount: 1 },
      source: {
        workspaceId: "ws_123",
        environment: "test",
        apiKeyId: "key_123",
        sourceType: "api_key",
        sourceId: "key_123",
        sourceName: null,
      },
      slug: "tokens_used",
      timestamp: BASE_NOW,
      ...eventOverrides,
    },
    idempotencyKey: (overrides.idempotencyKey as string | undefined) ?? "idem_123",
    now: (overrides.now as number | undefined) ?? BASE_NOW,
    projectId,
    grants: grantSnapshots.map((grant) => ({
      allowanceUnits:
        typeof grant.allowanceUnits === "number"
          ? grant.allowanceUnits
          : typeof grant.amount === "number"
            ? grant.amount
            : null,
      cadenceEffectiveAt: Number(grant.cadenceEffectiveAt),
      cadenceExpiresAt: grant.cadenceExpiresAt != null ? Number(grant.cadenceExpiresAt) : null,
      currencyCode: String(grant.currencyCode ?? currencyCode),
      effectiveAt: Number(grant.effectiveAt),
      expiresAt: grant.expiresAt != null ? Number(grant.expiresAt) : null,
      grantId: String(grant.grantId),
      priority: Number(grant.priority),
      resetConfig: grant.resetConfig ?? resetConfig,
    })),
  }
}
```

- [ ] **Step 2: Write the workers invariant tests**

Create `apps/api/src/ingestion/entitlements/EntitlementWindowDO.workers.test.ts`:

```ts
import { env } from "cloudflare:workers"
import { evictDurableObject, reset, runDurableObjectAlarm } from "cloudflare:test"
import { afterEach, describe, expect, it } from "vitest"
import { buildIngestionWindowName } from "@unprice/services/ingestion"
import { BASE_NOW, createApplyInput } from "./entitlement-window-test-fixtures"

function entitlementStub(params: {
  customerEntitlementId?: string
  customerId?: string
  projectId?: string
}) {
  return env.entitlementwindow.getByName(
    buildIngestionWindowName({
      appEnv: "test",
      customerEntitlementId: params.customerEntitlementId ?? "ce_123",
      customerId: params.customerId ?? "cus_123",
      projectId: params.projectId ?? "proj_123",
    })
  )
}

afterEach(async () => {
  await reset()
})

describe("EntitlementWindowDO workers runtime invariants", () => {
  it("partitions concurrent hard-limit writes without over-consuming", async () => {
    const stub = entitlementStub({})
    const inputs = Array.from({ length: 5 }, (_unused, index) =>
      createApplyInput({
        enforceLimit: true,
        limit: 5,
        idempotencyKey: `idem_hard_limit_${index}`,
        event: {
          id: `evt_hard_limit_${index}`,
          properties: { amount: 2 },
        },
      })
    )

    const results = await Promise.all(inputs.map((input) => stub.apply(input)))
    const accepted = results.filter((result) => result.allowed)
    const rejected = results.filter((result) => !result.allowed)

    expect(accepted).toHaveLength(2)
    expect(rejected).toHaveLength(3)
    expect(rejected.map((result) => result.deniedReason)).toEqual([
      "LIMIT_EXCEEDED",
      "LIMIT_EXCEEDED",
      "LIMIT_EXCEEDED",
    ])

    const state = await stub.getEnforcementState({
      entitlement: inputs[0]!.entitlement,
      grants: inputs[0]!.grants,
      now: BASE_NOW,
    })
    expect(state.usage).toBe(4)
    expect(state.limit).toBe(5)
    expect(state.isLimitReached).toBe(false)
  })

  it("keeps sibling entitlement windows isolated under concurrent writes", async () => {
    const first = entitlementStub({ customerEntitlementId: "ce_first" })
    const second = entitlementStub({ customerEntitlementId: "ce_second" })
    const firstInput = createApplyInput({
      customerEntitlementId: "ce_first",
      idempotencyKey: "idem_first",
      event: { id: "evt_first", properties: { amount: 3 } },
    })
    const secondInput = createApplyInput({
      customerEntitlementId: "ce_second",
      idempotencyKey: "idem_second",
      event: { id: "evt_second", properties: { amount: 7 } },
    })

    await Promise.all([first.apply(firstInput), second.apply(secondInput)])

    await expect(
      first.getEnforcementState({
        entitlement: firstInput.entitlement,
        grants: firstInput.grants,
        now: BASE_NOW,
      })
    ).resolves.toMatchObject({ usage: 3 })
    await expect(
      second.getEnforcementState({
        entitlement: secondInput.entitlement,
        grants: secondInput.grants,
        now: BASE_NOW,
      })
    ).resolves.toMatchObject({ usage: 7 })
  })

  it("preserves persisted state across eviction and alarm execution", async () => {
    const stub = entitlementStub({ customerEntitlementId: "ce_alarm" })
    const input = createApplyInput({
      customerEntitlementId: "ce_alarm",
      idempotencyKey: "idem_alarm",
      event: { id: "evt_alarm", properties: { amount: 2 } },
    })

    await expect(stub.apply(input)).resolves.toMatchObject({ allowed: true })
    await evictDurableObject(stub)

    await expect(
      stub.getEnforcementState({
        entitlement: input.entitlement,
        grants: input.grants,
        now: BASE_NOW,
      })
    ).resolves.toMatchObject({ usage: 2 })

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true)
  })
})
```

- [ ] **Step 3: Run the workers invariant tests**

Run:

```bash
corepack pnpm --filter api test:workers -- src/ingestion/entitlements/EntitlementWindowDO.workers.test.ts
```

Expected:

```text
Test Files  1 passed
Tests       3 passed
```

- [ ] **Step 4: Run the existing fake DO tests**

Run:

```bash
corepack pnpm --filter api test -- src/ingestion/entitlements/EntitlementWindowDO.test.ts src/ingestion/run-budget/RunBudgetDO.test.ts
```

Expected:

```text
Test Files  2 passed
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingestion/entitlements/entitlement-window-test-fixtures.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.workers.test.ts
git commit -m "test(api): add real runtime entitlement window invariants"
```

## Task 3: Add Shared Convergence And Race Test Helpers

**Files:**
- Create: `internal/services/src/test-fixtures/convergence.ts`
- Create: `apps/api/src/ingestion/test-fixtures/race.ts`
- Modify: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`

- [ ] **Step 1: Create the convergence polling helper**

Create `internal/services/src/test-fixtures/convergence.ts`:

```ts
import { expect } from "vitest"

export async function expectEventually<T>({
  read,
  assert,
  timeoutMs = 2_000,
  intervalMs = 25,
}: {
  read: () => Promise<T>
  assert: (value: T) => void
  timeoutMs?: number
  intervalMs?: number
}) {
  const deadline = Date.now() + timeoutMs
  let lastValue: T | undefined
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      lastValue = await read()
      assert(lastValue)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  expect({
    lastValue,
    lastError: lastError instanceof Error ? lastError.message : String(lastError),
  }).toEqual({ converged: true })
}
```

- [ ] **Step 2: Create deterministic race utilities**

Create `apps/api/src/ingestion/test-fixtures/race.ts`:

```ts
export function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, reject, resolve }
}

export function createGate() {
  const entered = createDeferred<void>()
  const release = createDeferred<void>()

  return {
    entered: entered.promise,
    release: release.resolve,
    async wait() {
      entered.resolve()
      await release.promise
    },
  }
}
```

- [ ] **Step 3: Replace local duplicate deferred helpers in DO tests**

Modify `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`:

```ts
import { createDeferred, createGate } from "../test-fixtures/race"
```

Then remove the local `createDeferred` function at the bottom of the file and update gate-style tests to use `createGate()` where they currently create paired promises manually.

- [ ] **Step 4: Run the affected fake DO tests**

Run:

```bash
corepack pnpm --filter api test -- src/ingestion/entitlements/EntitlementWindowDO.test.ts
```

Expected:

```text
Test Files  1 passed
```

- [ ] **Step 5: Commit**

```bash
git add internal/services/src/test-fixtures/convergence.ts apps/api/src/ingestion/test-fixtures/race.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts
git commit -m "test: add convergence and deterministic race helpers"
```

## Task 4: Add Job Idempotency And Schedule Fanout Tests

**Files:**
- Modify: `internal/jobs/package.json`
- Create: `internal/jobs/vitest.config.ts`
- Create: `internal/jobs/src/trigger/tasks/tasks.test.ts`
- Create: `internal/jobs/src/trigger/schedules/schedules.test.ts`

- [ ] **Step 1: Add a jobs test script and Vitest dependency**

Run:

```bash
corepack pnpm --filter @unprice/jobs add -D vitest
```

Modify `internal/jobs/package.json` scripts:

```json
{
  "scripts": {
    "clean": "rm -rf .turbo node_modules",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev:trigger": "pnpm dlx trigger.dev@4.4.5 dev",
    "deploy:trigger-prod": "npx trigger.dev@4.4.5 deploy",
    "delete": "pnpm tsx src/delete.ts"
  }
}
```

- [ ] **Step 2: Create the jobs Vitest config**

Create `internal/jobs/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
    env: {
      APP_ENV: "test",
      NODE_ENV: "test",
      SKIP_ENV_VALIDATION: "true",
    },
  },
})
```

- [ ] **Step 3: Write task idempotency tests around service calls**

Create `internal/jobs/src/trigger/tasks/tasks.test.ts`:

```ts
import { Ok } from "@unprice/error"
import { beforeEach, describe, expect, it, vi } from "vitest"

const serviceCalls = {
  billingInvoice: vi.fn(),
  invoiceSubscription: vi.fn(),
  renewSubscription: vi.fn(),
}

vi.mock("./context", () => ({
  createContext: vi.fn(async () => ({
    services: {
      billing: { billingInvoice: serviceCalls.billingInvoice },
      subscriptions: {
        invoiceSubscription: serviceCalls.invoiceSubscription,
        renewSubscription: serviceCalls.renewSubscription,
      },
    },
    flushLogs: vi.fn(),
  })),
}))

describe("Trigger tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serviceCalls.billingInvoice.mockResolvedValue(Ok({ total: 100, status: "paid" }))
    serviceCalls.invoiceSubscription.mockResolvedValue(Ok({ status: "active" }))
    serviceCalls.renewSubscription.mockResolvedValue(Ok({ status: "active" }))
  })

  it("billingTask delegates exactly once to BillingService.billingInvoice", async () => {
    const { billingTask } = await import("./billing")

    const result = await billingTask.run(
      {
        invoiceId: "inv_123",
        subscriptionId: "sub_123",
        projectId: "proj_123",
        now: 1_800_000_000_000,
      },
      { ctx: { task: { id: "task_billing_1" } } } as never
    )

    expect(result).toEqual({
      status: "paid",
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: 1_800_000_000_000,
    })
    expect(serviceCalls.billingInvoice).toHaveBeenCalledTimes(1)
    expect(serviceCalls.billingInvoice).toHaveBeenCalledWith({
      invoiceId: "inv_123",
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: 1_800_000_000_000,
    })
  })

  it("invoiceTask delegates exactly once to SubscriptionService.invoiceSubscription", async () => {
    const { invoiceTask } = await import("./invoice")

    await invoiceTask.run(
      {
        subscriptionId: "sub_123",
        projectId: "proj_123",
        now: 1_800_000_000_000,
      },
      { ctx: { task: { id: "task_invoice_1" } } } as never
    )

    expect(serviceCalls.invoiceSubscription).toHaveBeenCalledTimes(1)
    expect(serviceCalls.invoiceSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: 1_800_000_000_000,
    })
  })

  it("renewTask delegates exactly once to SubscriptionService.renewSubscription", async () => {
    const { renewTask } = await import("./renew")

    await renewTask.run(
      {
        subscriptionId: "sub_123",
        projectId: "proj_123",
        customerId: "cus_123",
        now: 1_800_000_000_000,
      },
      { ctx: { task: { id: "task_renew_1" } } } as never
    )

    expect(serviceCalls.renewSubscription).toHaveBeenCalledTimes(1)
    expect(serviceCalls.renewSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: 1_800_000_000_000,
    })
  })
})
```

- [ ] **Step 4: Write schedule fanout tests**

Create `internal/jobs/src/trigger/schedules/schedules.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const batchTrigger = vi.fn()
const invoiceRows = [
  {
    id: "inv_due_1",
    subscriptionId: "sub_1",
    projectId: "proj_1",
  },
  {
    id: "inv_due_2",
    subscriptionId: "sub_2",
    projectId: "proj_1",
  },
]

vi.mock("../db", () => ({
  db: {
    query: {
      invoices: {
        findMany: vi.fn(async () => invoiceRows),
      },
    },
  },
}))

vi.mock("../tasks/billing", () => ({
  billingTask: {
    batchTrigger,
  },
}))

describe("billingSchedule", () => {
  beforeEach(() => {
    batchTrigger.mockReset()
  })

  it("fans out one billing task payload per due invoice", async () => {
    const { billingSchedule } = await import("./billing")

    const result = await billingSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    } as never)

    expect(batchTrigger).toHaveBeenCalledWith([
      {
        payload: {
          invoiceId: "inv_due_1",
          subscriptionId: "sub_1",
          projectId: "proj_1",
          now: 1_783_340_800_000,
        },
      },
      {
        payload: {
          invoiceId: "inv_due_2",
          subscriptionId: "sub_2",
          projectId: "proj_1",
          now: 1_783_340_800_000,
        },
      },
    ])
    expect(result).toEqual({ invoiceIds: ["inv_due_1", "inv_due_2"] })
  })
})
```

- [ ] **Step 5: Run jobs tests and typecheck**

Run:

```bash
corepack pnpm --filter @unprice/jobs test
corepack pnpm --filter @unprice/jobs typecheck
```

Expected:

```text
Test Files  2 passed
```

- [ ] **Step 6: Commit**

```bash
git add internal/jobs/package.json pnpm-lock.yaml internal/jobs/vitest.config.ts internal/jobs/src/trigger/tasks/tasks.test.ts internal/jobs/src/trigger/schedules/schedules.test.ts
git commit -m "test(jobs): cover trigger task and schedule fanout"
```

## Task 5: Add HTTP Idempotency Enforcement To Endpoint Contracts

**Files:**
- Create: `apps/api/src/middleware/idempotency.ts`
- Create: `apps/api/src/middleware/idempotency.test.ts`
- Modify: `apps/api/src/openapi/public-operation-contracts.test.ts`

- [ ] **Step 1: Write the middleware unit tests**

Create `apps/api/src/middleware/idempotency.test.ts`:

```ts
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { createHttpIdempotencyMiddleware } from "./idempotency"

describe("createHttpIdempotencyMiddleware", () => {
  it("retains successful responses for replay", async () => {
    const app = new Hono()
    const store = new Map<string, Response>()
    app.use(
      "*",
      createHttpIdempotencyMiddleware({
        getKey: (c) => c.req.header("idempotency-key") ?? null,
        load: async (key) => store.get(key) ?? null,
        save: async (key, response) => {
          store.set(key, response.clone())
        },
        release: async (key) => {
          store.delete(key)
        },
      })
    )
    app.post("/mutate", (c) => c.json({ ok: true }, 200))

    const first = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_1" },
    })
    const second = await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_1" },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ code: "IDEMPOTENCY_REPLAYED", message: "Request already processed" })
  })

  it("releases keys for 5xx responses", async () => {
    const app = new Hono()
    const store = new Map<string, Response>()
    let calls = 0
    app.use(
      "*",
      createHttpIdempotencyMiddleware({
        getKey: (c) => c.req.header("idempotency-key") ?? null,
        load: async (key) => store.get(key) ?? null,
        save: async (key, response) => {
          store.set(key, response.clone())
        },
        release: async (key) => {
          store.delete(key)
        },
      })
    )
    app.post("/mutate", () => {
      calls += 1
      return new Response("failed", { status: 500 })
    })

    await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_500" },
    })
    await app.request("/mutate", {
      method: "POST",
      headers: { "idempotency-key": "idem_500" },
    })

    expect(calls).toBe(2)
    expect(store.has("idem_500")).toBe(false)
  })
})
```

- [ ] **Step 2: Implement the middleware**

Create `apps/api/src/middleware/idempotency.ts`:

```ts
import type { Context, MiddlewareHandler } from "hono"

type IdempotencyStore = {
  getKey: (c: Context) => string | null
  load: (key: string) => Promise<Response | null>
  save: (key: string, response: Response) => Promise<void>
  release: (key: string) => Promise<void>
}

export function createHttpIdempotencyMiddleware(store: IdempotencyStore): MiddlewareHandler {
  return async (c, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method.toUpperCase())) {
      await next()
      return
    }

    const key = store.getKey(c)
    if (!key) {
      await next()
      return
    }

    const cached = await store.load(key)
    if (cached) {
      return c.json(
        {
          code: "IDEMPOTENCY_REPLAYED",
          message: "Request already processed",
        },
        409
      )
    }

    await next()

    const response = c.res.clone()
    if (response.status >= 500) {
      await store.release(key)
      return
    }

    if (response.status < 400 || response.status === 409) {
      await store.save(key, response)
      return
    }

    await store.release(key)
  }
}
```

- [ ] **Step 3: Enforce idempotency metadata on mutating public runtime routes**

Modify `apps/api/src/openapi/public-operation-contracts.test.ts` with this test:

```ts
it("declares idempotency metadata on mutating public runtime and money routes", () => {
  const mutatingRoutes = routes.filter((route) => {
    const contract = route["x-unprice"]
    return (
      contract?.audience === "public" &&
      ["runtime", "money"].includes(contract.category) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(route.method.toUpperCase())
    )
  })

  expect(
    mutatingRoutes.map((route) => ({
      operationId: route.operationId,
      idempotency: route["x-unprice"]?.idempotency,
    }))
  ).toEqual(
    mutatingRoutes.map((route) => ({
      operationId: route.operationId,
      idempotency: expect.objectContaining({ required: true }),
    }))
  )
})
```

- [ ] **Step 4: Run API middleware and contract tests**

Run:

```bash
corepack pnpm --filter api test -- src/middleware/idempotency.test.ts src/openapi/public-operation-contracts.test.ts
```

Expected:

```text
Test Files  2 passed
```

- [ ] **Step 5: Keep production wiring blocked until the store is durable**

Do not register `createHttpIdempotencyMiddleware` in `apps/api/src/index.ts` in this task. A process-local `Map` would only dedupe inside one isolate and would not satisfy the retry contract across Cloudflare runtime placement. The next plan must add a Cloudflare-backed store, then wire the middleware after `init()` and before route handlers.

- [ ] **Step 6: Run API typecheck**

Run:

```bash
corepack pnpm --filter api type-check
```

Expected:

```text
No TypeScript errors
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware/idempotency.ts apps/api/src/middleware/idempotency.test.ts apps/api/src/openapi/public-operation-contracts.test.ts
git commit -m "feat(api): add HTTP idempotency middleware contract"
```

## Task 6: Add A Follow-Up Plan For Durable Idempotency, Provider Rollback, And Degradation

**Files:**
- Create: `docs/superpowers/plans/2026-07-06-durable-idempotency-provider-rollback-and-degradation.md`

- [ ] **Step 1: Create the follow-up plan shell**

Create `docs/superpowers/plans/2026-07-06-durable-idempotency-provider-rollback-and-degradation.md`:

```markdown
# Durable Idempotency Provider Rollback And Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable HTTP idempotency store, provider failure injection, billing rollback coverage, `/health`, `/ready`, and a fail-open/fail-closed matrix after the runtime and job correctness plan lands.

**Architecture:** Keep HTTP idempotency in API middleware backed by a Cloudflare Durable Object or KV-like binding. Keep provider compensation in `internal/services/src/payment-provider` and `internal/services/src/billing`; keep API health endpoints as adapters over explicit service checks.

**Tech Stack:** TypeScript, Vitest, Hono, Cloudflare Durable Objects, PaymentProviderService, BillingService, Result/Ok/Err.

---

## Priority Tasks

1. Add an HTTP idempotency Durable Object or KV-backed store under `apps/api/src/middleware`.
2. Add a Wrangler binding and migration for the idempotency store in `apps/api/wrangler.jsonc`.
3. Wire `createHttpIdempotencyMiddleware` in `apps/api/src/index.ts` only after the durable store is available.
4. Add sandbox provider fault injection options to `internal/services/src/payment-provider/sandbox.ts`.
5. Add billing finalization rollback tests in `internal/services/src/billing/service.finalize.test.ts`.
6. Add collection rollback tests in `internal/services/src/billing/service.collect.test.ts`.
7. Add `/health` and `/ready` routes in `apps/api/src/routes/health`.
8. Add fail-open/fail-closed matrix documentation under `docs/architecture`.
9. Add infra degradation tests under `apps/api/src/routes/health`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-07-06-durable-idempotency-provider-rollback-and-degradation.md
git commit -m "docs: plan durable idempotency and degradation follow-up"
```

## Verification Batch

Run after Task 5:

```bash
corepack pnpm --filter api test
corepack pnpm --filter api test:workers
corepack pnpm --filter api type-check
corepack pnpm --filter @unprice/jobs test
corepack pnpm --filter @unprice/jobs typecheck
```

Run before opening a PR:

```bash
corepack pnpm validate
```

## Self-Review

Spec coverage:

- Real-runtime DO lane: covered by Tasks 1 and 2.
- Portable invariants 1, 2, 3, and part of 7: covered by Task 2.
- Convergence helper and deterministic race scripting: covered by Task 3.
- Job idempotency and schedule fanout: covered by Task 4.
- HTTP idempotency metadata and lifecycle foundation: covered by Task 5.
- Durable idempotency store, provider rollback, and degradation: split into Task 6 follow-up because they are independent subsystems.
- k6 nightly and breakdown-sums-to-total: intentionally not in this plan; schedule them after runtime correctness coverage is mandatory.

Placeholder scan:

- No banned placeholder strings or open-ended implementation placeholders.
- Every code-writing step includes concrete file paths and code.

Type consistency:

- Workers tests use `env.entitlementwindow`, `env.runbudget`, and `buildIngestionWindowName`, matching `apps/api/src/env.ts` and `apps/api/src/ingestion/entitlements/client.ts`.
- API idempotency follows the existing `x-unprice.idempotency` contract shape in `apps/api/src/openapi/endpoint-contract.ts`.
- Jobs tests call current task payload shapes in `internal/jobs/src/trigger/tasks/*.ts`.
