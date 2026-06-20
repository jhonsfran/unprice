# Environment-Aware API Key Prefixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make newly generated API key secrets use `unprice_live_`, `unprice_test_`, or `unprice_dev_` based on runtime `APP_ENV`.

**Architecture:** Keep sortable token generation in `internal/db/src/utils/id.ts`, extract the existing 22-character Base58 ID body generator, and add `newApiKey(env)`. Thread `AppEnv` through the domain service dependency graph so `ApiKeysService` owns environment-aware key generation for both create and roll operations. Keep API key shape validation in the API adapter, where request authorization already happens.

**Tech Stack:** TypeScript, Vitest, Hono/Cloudflare Workers, tRPC, Trigger jobs, `@unprice/db`, `@unprice/services`.

---

## File Structure

- Modify: `internal/db/src/utils/id.ts`
  - Owns `AppEnv`, API key prefix mapping, shared sortable token generation, `newId`, and `newApiKey`.
- Test: `internal/db/src/utils/id.test.ts`
  - Covers environment-specific API key prefixes, Base58 payload length, uniqueness, and removal of `apikey_key` from `prefixes`.
- Modify: `apps/api/src/auth/key.ts`
  - Accepts generated `unprice_test_` keys in production shape validation.
- Test: `apps/api/src/auth/key.test.ts`
  - Covers live, test, dev, malformed, and non-Base58 shapes.
- Modify: `internal/services/src/deps.ts`
  - Adds `appEnv: AppEnv` to `ServiceDeps`.
- Modify: `internal/services/src/apikey/service.ts`
  - Accepts `appEnv` and uses `newApiKey(this.appEnv)` in `createApiKey` and `rollApiKey`.
- Test: `internal/services/src/apikey/service.test.ts`
  - Covers `createApiKey` and `rollApiKey` prefix generation from configured `appEnv`.
- Modify: `internal/services/src/context.ts`
  - Passes `deps.appEnv` into `ApiKeysService`.
- Modify: `apps/api/src/middleware/init.ts`
  - Passes `c.env.APP_ENV` into `createServiceContext` and the standalone `ApiKeysService`.
- Modify: `apps/api/src/ingestion/queue.ts`
  - Passes `params.env.APP_ENV` into `createServiceContext`.
- Modify: `internal/trpc/src/trpc.ts`
  - Passes `env.APP_ENV` into `createServiceContext`.
- Modify: `internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts`
  - Passes `env.APP_ENV` into `createServiceContext`.
- Modify: `internal/jobs/src/trigger/tasks/context.ts`
  - Adds `appEnv: env.APP_ENV` to the shared deps object.
- Modify: service integration tests that call `createServiceContext`
  - `internal/services/src/tests/subscription-scenarios/subscription-renewal-wallet.integration.test.ts`
  - `internal/services/src/tests/subscription-scenarios/phase-change-proration.integration.test.ts`
  - `internal/services/src/tests/payment-scenarios/paid-invoice-lifecycle.integration.test.ts`
  - `internal/services/src/tests/billing-scenarios/golden-cases-db.integration.test.ts`

No migrations, ADRs, or package export changes are needed because `internal/db/src/utils.ts` already exports `./utils/id`.

### Task 1: Add DB Utility Contract For Environment-Aware API Keys

**Files:**
- Modify: `internal/db/src/utils/id.test.ts`
- Modify: `internal/db/src/utils/id.ts`

- [ ] **Step 1: Write the failing DB utility tests**

Update the import in `internal/db/src/utils/id.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { newApiKey, newId, prefixes, randomId } from "./id"
```

Append this test block to `internal/db/src/utils/id.test.ts`:

```ts
describe("newApiKey", () => {
  const apiKeyBodyPattern = "[1-9A-HJ-NP-Za-km-z]{22}"

  it("generates production API keys with live prefix", () => {
    expect(newApiKey("production")).toMatch(new RegExp(`^unprice_live_${apiKeyBodyPattern}$`))
  })

  it("generates preview API keys with test prefix", () => {
    expect(newApiKey("preview")).toMatch(new RegExp(`^unprice_test_${apiKeyBodyPattern}$`))
  })

  it("generates development API keys with dev prefix", () => {
    expect(newApiKey("development")).toMatch(new RegExp(`^unprice_dev_${apiKeyBodyPattern}$`))
  })

  it("generates distinct keys within the same runtime environment", () => {
    const keys = Array.from({ length: 64 }, () => newApiKey("preview"))

    expect(new Set(keys).size).toBe(keys.length)
  })

  it("keeps API key secrets out of the generic newId prefix map", () => {
    expect(Object.prototype.hasOwnProperty.call(prefixes, "apikey_key")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the DB utility test and verify it fails**

Run:

```bash
rtk pnpm --filter @unprice/db test src/utils/id.test.ts
```

Expected: FAIL because `newApiKey` is not exported yet.

- [ ] **Step 3: Implement `AppEnv`, `newApiKey`, and shared sortable token generation**

In `internal/db/src/utils/id.ts`, add `AppEnv` and API key prefixes near the top of the file, after `const b58 = baseX(ALPHABET)`:

```ts
export type AppEnv = "development" | "preview" | "production"

const apiKeyPrefixes = {
  development: "unprice_dev",
  preview: "unprice_test",
  production: "unprice_live",
} as const satisfies Record<AppEnv, string>

type ApiKeyPrefix = (typeof apiKeyPrefixes)[AppEnv]
```

Remove this entry from `prefixes`:

```ts
  apikey_key: "unprice_live",
```

Extract the existing body of `newId` into this helper below the BigInt constants:

```ts
function newSortableIdToken(): string {
  const buf = new Uint8Array(16)

  crypto.getRandomValues(buf)

  let timestamp = BigInt(Date.now()) - EPOCH_TIMESTAMP

  if (timestamp <= lastTimestamp) {
    timestamp = lastTimestamp
    counter++
    if (counter > MAX_COUNTER) {
      timestamp++
      counter = 0
    }
  } else {
    counter = 0
  }
  lastTimestamp = timestamp

  buf[0] = Number((timestamp >> BIGINT_40) & BIGINT_255)
  buf[1] = Number((timestamp >> BIGINT_32) & BIGINT_255)
  buf[2] = Number((timestamp >> BIGINT_24) & BIGINT_255)
  buf[3] = Number((timestamp >> BIGINT_16) & BIGINT_255)
  buf[4] = Number((timestamp >> BIGINT_8) & BIGINT_255)
  buf[5] = Number(timestamp & BIGINT_255)

  buf[6] = (0x7 << 4) | ((counter >> 8) & 0x0f)
  buf[7] = counter & 0xff

  buf[8] = (buf[8]! & 0x3f) | 0x80

  return b58.encode(buf).padStart(22, ALPHABET[0])
}
```

Replace the body of `newId` with:

```ts
export function newId<TPrefix extends keyof typeof prefixes>(
  prefix: TPrefix
): `${(typeof prefixes)[TPrefix]}_${string}` {
  return `${prefixes[prefix]}_${newSortableIdToken()}` as const
}
```

Add `newApiKey` below `newId`:

```ts
export function newApiKey(env: AppEnv): `${ApiKeyPrefix}_${string}` {
  return `${apiKeyPrefixes[env]}_${newSortableIdToken()}` as `${ApiKeyPrefix}_${string}`
}
```

- [ ] **Step 4: Run the DB utility test and verify it passes**

Run:

```bash
rtk pnpm --filter @unprice/db test src/utils/id.test.ts
```

Expected: PASS for `randomId`, `newId budget_run prefix`, and `newApiKey`.

- [ ] **Step 5: Commit the DB utility change**

Run:

```bash
rtk git add internal/db/src/utils/id.ts internal/db/src/utils/id.test.ts
rtk git commit -m "feat: add environment-aware api key ids"
```

### Task 2: Accept Test API Key Shapes In API Auth Validation

**Files:**
- Modify: `apps/api/src/auth/key.test.ts`
- Modify: `apps/api/src/auth/key.ts`

- [ ] **Step 1: Write the failing auth shape tests**

In `apps/api/src/auth/key.test.ts`, update the `isValidApiKeyShape` block to include `unprice_test_` coverage:

```ts
describe("isValidApiKeyShape", () => {
  it("accepts generated live key shape", () => {
    expect(isValidApiKeyShape("unprice_live_123456789ABCDEFGHJKLMN")).toBe(true)
  })

  it("accepts generated test key shape", () => {
    expect(isValidApiKeyShape("unprice_test_123456789ABCDEFGHJKLMN")).toBe(true)
  })

  it("accepts local dev keys only when explicitly allowed", () => {
    expect(isValidApiKeyShape("unprice_dev_1234567890")).toBe(false)
    expect(isValidApiKeyShape("unprice_dev_1234567890", { allowDevKey: true })).toBe(true)
  })

  it("rejects malformed and non-base58 keys", () => {
    expect(isValidApiKeyShape("sk_test_123")).toBe(false)
    expect(isValidApiKeyShape("unprice_live_123")).toBe(false)
    expect(isValidApiKeyShape("unprice_test_123")).toBe(false)
    expect(isValidApiKeyShape("unprice_live_123456789ABCDEFGH0OIlM")).toBe(false)
    expect(isValidApiKeyShape("unprice_test_123456789ABCDEFGH0OIlM")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the auth test and verify it fails**

Run:

```bash
rtk pnpm --filter api test src/auth/key.test.ts
```

Expected: FAIL because `unprice_test_123456789ABCDEFGHJKLMN` is rejected.

- [ ] **Step 3: Add the test API key pattern**

In `apps/api/src/auth/key.ts`, add the test pattern next to the live pattern:

```ts
const LIVE_API_KEY_PATTERN = /^unprice_live_[1-9A-HJ-NP-Za-km-z]{22}$/
const TEST_API_KEY_PATTERN = /^unprice_test_[1-9A-HJ-NP-Za-km-z]{22}$/
const LOCAL_DEV_API_KEY_PATTERN = /^unprice_dev_[A-Za-z0-9_-]+$/
```

Replace `isValidApiKeyShape` with:

```ts
export function isValidApiKeyShape(value: string, opts: { allowDevKey?: boolean } = {}): boolean {
  return (
    LIVE_API_KEY_PATTERN.test(value) ||
    TEST_API_KEY_PATTERN.test(value) ||
    (opts.allowDevKey === true && LOCAL_DEV_API_KEY_PATTERN.test(value))
  )
}
```

- [ ] **Step 4: Run the auth test and verify it passes**

Run:

```bash
rtk pnpm --filter api test src/auth/key.test.ts
```

Expected: PASS for `validateIsAllowedToAccessProject` and `isValidApiKeyShape`.

- [ ] **Step 5: Commit the auth validation change**

Run:

```bash
rtk git add apps/api/src/auth/key.ts apps/api/src/auth/key.test.ts
rtk git commit -m "fix: accept preview api key shape"
```

### Task 3: Make ApiKeysService Generate Keys From AppEnv

**Files:**
- Modify: `internal/services/src/apikey/service.test.ts`
- Modify: `internal/services/src/apikey/service.ts`

- [ ] **Step 1: Write failing ApiKeysService tests**

Update imports in `internal/services/src/apikey/service.test.ts`:

```ts
import type { Database } from "@unprice/db"
import type { AppEnv } from "@unprice/db/utils"
import type { ApiKeyExtended } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { Metrics } from "../metrics"
import { ApiKeysService } from "./service"
```

Inside `describe("ApiKeysService customer binding", () => {`, after `beforeEach`, add this helper:

```ts
  const createService = (db: Database, appEnv: AppEnv = "production") =>
    new ApiKeysService({
      cache,
      metrics,
      analytics,
      logger,
      db,
      waitUntil,
      hashCache,
      appEnv,
    })
```

Replace each existing constructor in this test file with:

```ts
    const service = createService(db)
```

Add these tests after the helper:

```ts
  it("createApiKey generates keys using the configured app environment", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: "api_created",
        name: "Preview key",
        hash: "stored_hash",
        expiresAt: null,
        projectId: "proj_123",
        isRoot: false,
        defaultCustomerId: null,
      },
    ])
    const values = vi.fn().mockReturnValue({ returning })
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
    } as unknown as Database
    const service = createService(db, "preview")

    const result = await service.createApiKey({
      projectId: "proj_123",
      isRoot: false,
      name: "Preview key",
      expiresAt: null,
      defaultCustomerId: null,
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.key).toMatch(/^unprice_test_[1-9A-HJ-NP-Za-km-z]{22}$/)
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^api_[1-9A-HJ-NP-Za-km-z]{22}$/),
        hash: expect.any(String),
      })
    )
  })

  it("rollApiKey generates keys using the configured app environment", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: "api_123",
        hash: "new_hash",
        projectId: "proj_123",
      },
    ])
    const where = vi.fn().mockReturnValue({ returning })
    const set = vi.fn().mockReturnValue({ where })
    const db = {
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as Database
    const service = createService(db, "development")
    vi.spyOn(
      service as unknown as {
        getData: (keyHash: string) => Promise<ApiKeyExtended | null>
      },
      "getData"
    ).mockResolvedValue({
      id: "api_123",
      projectId: "proj_123",
      revokedAt: null,
    } as ApiKeyExtended)

    const result = await service.rollApiKey({
      keyHash: "old_hash",
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.newKey).toMatch(/^unprice_dev_[1-9A-HJ-NP-Za-km-z]{22}$/)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: expect.any(String),
      })
    )
  })
```

- [ ] **Step 2: Run the service test and verify it fails**

Run:

```bash
rtk pnpm --filter @unprice/services test src/apikey/service.test.ts
```

Expected: FAIL because `ApiKeysService` does not accept `appEnv` and still calls `newId("apikey_key")`.

- [ ] **Step 3: Update ApiKeysService to accept AppEnv and call newApiKey**

In `internal/services/src/apikey/service.ts`, replace the utility import with:

```ts
import { type AppEnv, hashStringSHA256, newApiKey, newId } from "@unprice/db/utils"
```

Add `appEnv` to the class fields:

```ts
  private readonly db: Database
  private readonly appEnv: AppEnv
```

Add `appEnv` to constructor options:

```ts
    appEnv: AppEnv
```

Assign it in the constructor:

```ts
    this.hashCache = opts.hashCache
    this.appEnv = opts.appEnv
```

Replace both API key secret generation lines:

```ts
    const apiKey = newApiKey(this.appEnv)
```

```ts
    const newKey = newApiKey(this.appEnv)
```

Keep API key row ids on the generic prefix:

```ts
    const apiKeyId = newId("apikey")
```

- [ ] **Step 4: Run the service test and verify it passes**

Run:

```bash
rtk pnpm --filter @unprice/services test src/apikey/service.test.ts
```

Expected: PASS for the existing customer binding tests plus the new create and roll key generation tests.

- [ ] **Step 5: Commit the service generation change**

Run:

```bash
rtk git add internal/services/src/apikey/service.ts internal/services/src/apikey/service.test.ts
rtk git commit -m "feat: generate api keys from app environment"
```

### Task 4: Thread AppEnv Through ServiceDeps And Composition Roots

**Files:**
- Modify: `internal/services/src/deps.ts`
- Modify: `internal/services/src/context.ts`
- Modify: `apps/api/src/middleware/init.ts`
- Modify: `apps/api/src/ingestion/queue.ts`
- Modify: `internal/trpc/src/trpc.ts`
- Modify: `internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts`
- Modify: `internal/jobs/src/trigger/tasks/context.ts`
- Modify: `internal/services/src/tests/subscription-scenarios/subscription-renewal-wallet.integration.test.ts`
- Modify: `internal/services/src/tests/subscription-scenarios/phase-change-proration.integration.test.ts`
- Modify: `internal/services/src/tests/payment-scenarios/paid-invoice-lifecycle.integration.test.ts`
- Modify: `internal/services/src/tests/billing-scenarios/golden-cases-db.integration.test.ts`

- [ ] **Step 1: Add AppEnv to ServiceDeps**

In `internal/services/src/deps.ts`, add this import:

```ts
import type { AppEnv } from "@unprice/db/utils"
```

Add `appEnv` to `ServiceDeps`:

```ts
export interface ServiceDeps {
  db: Database
  logger: Logger
  analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: platform-specific promise handler
  waitUntil: (promise: Promise<any>) => void
  cache: Cache
  metrics: Metrics
  appEnv: AppEnv
}
```

- [ ] **Step 2: Pass AppEnv into the service graph ApiKeysService**

In `internal/services/src/context.ts`, update the `ApiKeysService` construction:

```ts
  const apikeys = new ApiKeysService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    hashCache: new Map<string, string>(),
    appEnv: deps.appEnv,
  })
```

- [ ] **Step 3: Thread appEnv through runtime composition roots**

In `apps/api/src/middleware/init.ts`, update `createServiceContext`:

```ts
    const svcCtx = createServiceContext({
      db,
      logger,
      analytics,
      waitUntil,
      cache,
      metrics,
      appEnv: c.env.APP_ENV,
    })
```

In the same file, update the standalone `ApiKeysService`:

```ts
    const apikey = new ApiKeysService({
      cache,
      analytics,
      logger,
      metrics,
      db,
      waitUntil,
      hashCache,
      appEnv: c.env.APP_ENV,
    })
```

In `apps/api/src/ingestion/queue.ts`, update `createServiceContext`:

```ts
  const svcCtx = createServiceContext({
    db,
    logger: params.logger,
    analytics,
    waitUntil,
    cache,
    metrics,
    appEnv: params.env.APP_ENV,
  })
```

In `internal/trpc/src/trpc.ts`, update `createServiceContext`:

```ts
  const services = createServiceContext({
    db,
    logger: opts.logger,
    analytics,
    waitUntil: opts.waitUntil,
    cache: opts.cache,
    metrics: opts.metrics,
    appEnv: env.APP_ENV,
  })
```

In `internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts`, update `createServiceContext`:

```ts
    const services = createServiceContext({
      db,
      logger: log,
      analytics,
      waitUntil: () => {},
      cache: cache.getCache(),
      metrics: new NoopMetrics(),
      appEnv: env.APP_ENV,
    })
```

In `internal/jobs/src/trigger/tasks/context.ts`, update the `deps` object:

```ts
  const deps = {
    db,
    logger,
    analytics,
    waitUntil: () => {},
    cache: cache.getCache(),
    metrics,
    appEnv: env.APP_ENV,
  }
```

- [ ] **Step 4: Thread appEnv through service integration test service graphs**

For every `createServiceContext({ ... })` call in these files, add:

```ts
      appEnv: "development",
```

Files:

```text
internal/services/src/tests/subscription-scenarios/subscription-renewal-wallet.integration.test.ts
internal/services/src/tests/subscription-scenarios/phase-change-proration.integration.test.ts
internal/services/src/tests/payment-scenarios/paid-invoice-lifecycle.integration.test.ts
internal/services/src/tests/billing-scenarios/golden-cases-db.integration.test.ts
```

The resulting service context objects should have this shape:

```ts
  const services = createServiceContext({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
    appEnv: "development",
  })
```

If a test uses inline service context creation inside another object, keep the local indentation and add the same `appEnv: "development"` property inside the `createServiceContext` argument.

- [ ] **Step 5: Confirm all service graph call sites have appEnv**

Run:

```bash
rtk rg -n "createServiceContext\\(" apps internal packages tooling --glob '*.ts'
```

Expected call sites:

```text
apps/api/src/ingestion/queue.ts
apps/api/src/middleware/init.ts
internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts
internal/jobs/src/trigger/tasks/context.ts
internal/services/src/context.ts
internal/services/src/tests/billing-scenarios/golden-cases-db.integration.test.ts
internal/services/src/tests/payment-scenarios/paid-invoice-lifecycle.integration.test.ts
internal/services/src/tests/subscription-scenarios/phase-change-proration.integration.test.ts
internal/services/src/tests/subscription-scenarios/subscription-renewal-wallet.integration.test.ts
internal/trpc/src/trpc.ts
```

Each construction outside `internal/services/src/context.ts` should include `appEnv`.

Run:

```bash
rtk rg -n "new ApiKeysService\\(" apps internal packages tooling --glob '*.ts'
```

Expected direct constructors:

```text
apps/api/src/middleware/init.ts
internal/services/src/apikey/service.test.ts
internal/services/src/context.ts
```

Each constructor should include `appEnv`.

- [ ] **Step 6: Commit composition-root wiring**

Run:

```bash
rtk git add internal/services/src/deps.ts internal/services/src/context.ts apps/api/src/middleware/init.ts apps/api/src/ingestion/queue.ts internal/trpc/src/trpc.ts internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts internal/jobs/src/trigger/tasks/context.ts internal/services/src/tests/subscription-scenarios/subscription-renewal-wallet.integration.test.ts internal/services/src/tests/subscription-scenarios/phase-change-proration.integration.test.ts internal/services/src/tests/payment-scenarios/paid-invoice-lifecycle.integration.test.ts internal/services/src/tests/billing-scenarios/golden-cases-db.integration.test.ts
rtk git commit -m "chore: thread app env through services"
```

### Task 5: Verification And Cleanup

**Files:**
- Verify all modified files from Tasks 1-4.

- [ ] **Step 1: Run focused tests**

Run:

```bash
rtk pnpm --filter @unprice/db test src/utils/id.test.ts
rtk pnpm --filter api test src/auth/key.test.ts
rtk pnpm --filter @unprice/services test src/apikey/service.test.ts
```

Expected: all three commands pass.

- [ ] **Step 2: Run typechecks for packages touched by ServiceDeps wiring**

Run:

```bash
rtk pnpm --filter @unprice/db typecheck
rtk pnpm --filter @unprice/services typecheck
rtk pnpm --filter api type-check
rtk pnpm --filter @unprice/trpc typecheck
rtk pnpm --filter @unprice/jobs typecheck
```

Expected: all five commands pass.

- [ ] **Step 3: Confirm removed generic API key prefix has no callers**

Run:

```bash
rtk rg -n "apikey_key|newId\\([\"']apikey_key[\"']\\)" apps internal packages tooling
```

Expected: no matches.

- [ ] **Step 4: Confirm production auth shape allows live and test but not dev by default**

Run:

```bash
rtk pnpm --filter api test src/auth/key.test.ts
```

Expected: PASS, with tests proving `unprice_live_` and `unprice_test_` are accepted and `unprice_dev_` still requires `allowDevKey: true`.

- [ ] **Step 5: Run full repo validation if focused checks pass**

Run:

```bash
rtk pnpm validate
```

Expected: PASS. If it fails, inspect only failures connected to the changed files or package-wide type fallout from `ServiceDeps`.

- [ ] **Step 6: Final commit if verification required additional fixes**

If Step 5 required code changes, run:

```bash
rtk git add internal/db/src/utils/id.ts internal/db/src/utils/id.test.ts apps/api/src/auth/key.ts apps/api/src/auth/key.test.ts internal/services/src/deps.ts internal/services/src/apikey/service.ts internal/services/src/apikey/service.test.ts internal/services/src/context.ts apps/api/src/middleware/init.ts apps/api/src/ingestion/queue.ts internal/trpc/src/trpc.ts internal/jobs/src/trigger/schedules/wallet-credit-expiration.ts internal/jobs/src/trigger/tasks/context.ts internal/services/src/tests/subscription-scenarios/subscription-renewal-wallet.integration.test.ts internal/services/src/tests/subscription-scenarios/phase-change-proration.integration.test.ts internal/services/src/tests/payment-scenarios/paid-invoice-lifecycle.integration.test.ts internal/services/src/tests/billing-scenarios/golden-cases-db.integration.test.ts
rtk git commit -m "test: verify environment-aware api keys"
```

Expected: commit succeeds only when there are verification-driven changes after Task 4.

## Self-Review

- Spec coverage:
  - `newApiKey(env)` and `AppEnv` are added in Task 1.
  - Existing sortable Base58 token generation is reused by extracting `newSortableIdToken` in Task 1.
  - `apikey_key` is removed from `prefixes` and tested in Task 1.
  - `ServiceDeps.appEnv` and all `createServiceContext` call sites are covered in Task 4.
  - `ApiKeysService` constructor, `createApiKey`, and `rollApiKey` are covered in Task 3.
  - API middleware standalone `ApiKeysService` is covered in Task 4.
  - `unprice_test_` validation is covered in Task 2.
  - `id.test.ts`, `key.test.ts`, and `service.test.ts` are covered in Tasks 1-3.
- Placeholder scan:
  - No unspecified implementation steps remain.
- Type consistency:
  - `AppEnv` is imported from `@unprice/db/utils` where the direct type export is needed.
  - `appEnv` uses lower camel case consistently in `ServiceDeps`, constructors, and call sites.
