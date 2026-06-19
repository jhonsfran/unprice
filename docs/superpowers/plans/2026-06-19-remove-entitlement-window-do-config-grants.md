# Remove EntitlementWindowDO Config And Grant Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `entitlement_config` and `grants` SQLite tables from `EntitlementWindowDO` while preserving ingestion correctness, enforcement-state verification, run-budget forwarding, wallet recovery, and generated Durable Object migrations.

**Architecture:** The service-layer ingestion context becomes the source of truth for entitlement config and fully enriched grants. `EntitlementWindowDO` keeps only mutable durable state: period usage, meter state, wallet reservation, and idempotency. The DO uses caller-provided entitlement/grant input directly for apply, batch apply, and enforcement-state reads, and generated Drizzle migrations drop the redundant tables.

**Tech Stack:** TypeScript, Zod, Drizzle durable SQLite, Cloudflare Durable Objects, Vitest, pnpm workspace scripts

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `internal/services/src/entitlements/grant-consumption.ts` | Modify | Export shared `extractCurrencyCodeFromFeatureConfig()` helper next to pricing helpers. |
| `internal/services/src/entitlements/grant-consumption.test.ts` | Modify | Prove currency extraction works for direct unit price, tier price, and missing currency. |
| `apps/api/src/ingestion/entitlements/meter-helpers.ts` | Modify | Reuse and re-export shared currency helper; keep API-local meter identity and numeric event helpers. |
| `apps/api/src/ingestion/entitlements/meter-helpers.test.ts` | Existing test | Verifies API re-export still behaves the same. |
| `internal/services/src/ingestion/entitlement-context.ts` | Modify | Extend `IngestionGrant` and enrich grants when loading customer entitlement context. |
| `internal/services/src/ingestion/entitlement-context.test.ts` | Modify | Assert `toIngestionEntitlement()` emits enriched grants. |
| `apps/api/src/ingestion/entitlements/contracts.ts` | Modify | Make `activeGrantSchema` the enriched grant schema and keep enforcement-state input object required without requiring a non-empty grant array. |
| `apps/api/src/ingestion/entitlements/contracts.test.ts` | Create | Lock the DO contract: enriched grants are retained, legacy grants are rejected, enforcement-state accepts an empty grant array. |
| `apps/api/src/ingestion/run-budget/contracts.ts` | Modify | Make RunBudgetDO accept and forward enriched grants. |
| `apps/api/src/ingestion/run-budget/contracts.test.ts` | Modify | Assert run-budget sync input retains enriched grants. |
| `internal/services/src/ingestion/entitlement-window-applier.ts` | Modify | Require `getEnforcementState(input)` at the service boundary. |
| `internal/services/src/ingestion/feature-verification.ts` | Verify only | Already passes entitlement, grants, and timestamp into `getEnforcementState()`. |
| `apps/api/src/ingestion/entitlements/entitlement-window-store.ts` | Modify | Delete config/grant sync/read methods and dead imports. Keep mutable state methods. |
| `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` | Modify | Stop writing/reading config and grants from SQLite; use parsed input directly in apply, batch, and enforcement-state paths. |
| `apps/api/src/ingestion/entitlements/db/schema.ts` | Modify | Remove `entitlementConfigTable` and `grantsTable` from the durable SQLite schema. |
| `apps/api/src/ingestion/entitlements/drizzle/0001_drop_config_grants.sql` | Generate | Drizzle-generated table drop migration. |
| `apps/api/src/ingestion/entitlements/drizzle/meta/0001_snapshot.json` | Generate | Drizzle-generated post-drop snapshot. |
| `apps/api/src/ingestion/entitlements/drizzle/meta/_journal.json` | Generate | Drizzle-generated journal entry. |
| `apps/api/src/ingestion/entitlements/drizzle/migrations.js` | Generate | Drizzle-generated migration import/export. |
| `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts` | Modify | Update grant fixture helper, remove no-input enforcement-state tests, and pin direct input usage. |
| `apps/api/src/ingestion/entitlements/entitlement-window-store.test.ts` | Modify | Remove store tests for deleted sync/read methods. |
| `apps/api/src/ingestion/entitlements/batch-apply-helpers.test.ts` | Modify if typecheck fails | Ensure any grant literals use enriched shape. |
| `apps/api/src/ingestion/run-budget/RunBudgetDO.test.ts` | Modify | Use enriched grants in run-budget DO fixtures. |
| `internal/services/src/ingestion/service.test.ts` | Modify | Use enriched grants in service-layer ingestion fixtures. |
| `internal/services/src/ingestion/feature-verification.test.ts` | Modify | Use enriched grants in verification fixtures. |
| `internal/services/src/ingestion/entitlement-window-applier.test.ts` | Modify | Use enriched grants in applier fixtures and keep required `getEnforcementState` mock shape. |
| `internal/services/src/ingestion/entitlement-routing.test.ts` | Modify | Use enriched grants where grant literals are present. |
| `internal/services/src/ingestion/message.test.ts` | Modify if typecheck fails | Keep default empty grant arrays valid under the new type. |
| `internal/services/src/ingestion/prepared-message-processor.test.ts` | Modify if typecheck fails | Keep default empty grant arrays valid under the new type. |
| `internal/services/src/ingestion/sync-processor.test.ts` | Modify if typecheck fails | Use enriched grants where grant literals are present. |
| `internal/services/src/ingestion/subscription-catchup.test.ts` | Modify if typecheck fails | Keep default empty grant arrays valid under the new type. |

---

### Task 1: Share Currency Extraction From Services

**Files:**
- Modify: `internal/services/src/entitlements/grant-consumption.ts`
- Modify: `internal/services/src/entitlements/grant-consumption.test.ts`
- Modify: `apps/api/src/ingestion/entitlements/meter-helpers.ts`
- Test: `apps/api/src/ingestion/entitlements/meter-helpers.test.ts`

- [ ] **Step 1: Add failing service tests for currency extraction**

Modify the import block in `internal/services/src/entitlements/grant-consumption.test.ts` to include `extractCurrencyCodeFromFeatureConfig`:

```typescript
import {
  type GrantConsumptionGrant,
  type GrantConsumptionState,
  computeGrantPeriodBucket,
  computeMaxMarginalPriceMinor,
  computeUsagePriceDeltaExplanation,
  computeUsagePriceDeltaMinor,
  consumeGrantsByPriority,
  extractCurrencyCodeFromFeatureConfig,
} from "./grant-consumption"
```

Append this test block above `describe("consumeGrantsByPriority", () => {`:

```typescript
describe("extractCurrencyCodeFromFeatureConfig", () => {
  it("returns the direct unit price currency", () => {
    expect(extractCurrencyCodeFromFeatureConfig(priceConfig("EUR"))).toBe("EUR")
  })

  it("returns the first tier unit price currency", () => {
    expect(
      extractCurrencyCodeFromFeatureConfig({
        tiers: [{ unitPrice: priceConfig("GBP").price }],
      })
    ).toBe("GBP")
  })

  it("returns null when no pricing currency exists", () => {
    expect(extractCurrencyCodeFromFeatureConfig({ usageMode: "unit" })).toBeNull()
  })
})
```

Append this helper near the other test helpers at the bottom of the file:

```typescript
function priceConfig(currencyCode: "EUR" | "GBP" | "USD") {
  const currency = currencyCode === "EUR" ? EUR : currencyCode === "USD" ? USD : undefined

  return {
    usageMode: "unit",
    price: {
      dinero: {
        amount: 0,
        currency:
          currency?.toJSON() ??
          ({
            code: "GBP",
            base: 10,
            exponent: 2,
          } as const),
        scale: 2,
      },
      displayAmount: "0.00",
    },
  }
}
```

- [ ] **Step 2: Run the failing service test**

Run:

```bash
rtk pnpm --filter @unprice/services test:file src/entitlements/grant-consumption.test.ts
```

Expected: FAIL because `extractCurrencyCodeFromFeatureConfig` is not exported from `./grant-consumption`.

- [ ] **Step 3: Implement the shared helper**

Append this code to `internal/services/src/entitlements/grant-consumption.ts` after `computeUsagePriceDeltaMinor()` and before `computeUsagePriceDeltaExplanation()`:

```typescript
export function extractCurrencyCodeFromFeatureConfig(config: unknown): string | null {
  const currencyFromPrice = extractCurrencyCode(config, "price")
  if (currencyFromPrice) {
    return currencyFromPrice
  }

  if (!isRecord(config) || !Array.isArray(config.tiers)) {
    return null
  }

  for (const tier of config.tiers) {
    const currencyFromTier = extractCurrencyCode(tier, "unitPrice")
    if (currencyFromTier) {
      return currencyFromTier
    }
  }

  return null
}

function extractCurrencyCode(input: unknown, priceKey: string): string | null {
  if (!isRecord(input)) {
    return null
  }

  const price = input[priceKey]
  if (!isRecord(price)) {
    return null
  }

  const dinero = price.dinero
  if (!isRecord(dinero)) {
    return null
  }

  const currency = dinero.currency
  if (!isRecord(currency)) {
    return null
  }

  const code = currency.code
  return typeof code === "string" && code.length > 0 ? code : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
```

- [ ] **Step 4: Reuse the shared helper from the API meter helper**

Replace the imports and exports at the top of `apps/api/src/ingestion/entitlements/meter-helpers.ts` with:

```typescript
import type { MeterConfig } from "@unprice/services/entitlements"
import { deriveMeterKey, extractCurrencyCodeFromFeatureConfig } from "@unprice/services/entitlements"
import type { ApplyInput, EntitlementConfigInput, MeterIdentity } from "./contracts"

export { extractCurrencyCodeFromFeatureConfig } from "@unprice/services/entitlements"
```

Delete these local helper blocks from `apps/api/src/ingestion/entitlements/meter-helpers.ts`:

```typescript
export function extractCurrencyCodeFromFeatureConfig(config: unknown): string | null {
  const currencyFromPrice = extractCurrencyCode(config, "price")
  if (currencyFromPrice) {
    return currencyFromPrice
  }

  if (!isRecord(config) || !Array.isArray(config.tiers)) {
    return null
  }

  for (const tier of config.tiers) {
    const currencyFromTier = extractCurrencyCode(tier, "unitPrice")
    if (currencyFromTier) {
      return currencyFromTier
    }
  }

  return null
}

function extractCurrencyCode(input: unknown, priceKey: string): string | null {
  if (!isRecord(input)) {
    return null
  }

  const price = input[priceKey]
  if (!isRecord(price)) {
    return null
  }

  const dinero = price.dinero
  if (!isRecord(dinero)) {
    return null
  }

  const currency = dinero.currency
  if (!isRecord(currency)) {
    return null
  }

  const code = currency.code
  return typeof code === "string" && code.length > 0 ? code : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
rtk pnpm --filter @unprice/services test:file src/entitlements/grant-consumption.test.ts
rtk pnpm --filter api test:file src/ingestion/entitlements/meter-helpers.test.ts
```

Expected: PASS for both files.

- [ ] **Step 6: Commit**

```bash
rtk git add internal/services/src/entitlements/grant-consumption.ts internal/services/src/entitlements/grant-consumption.test.ts apps/api/src/ingestion/entitlements/meter-helpers.ts
rtk git commit -m "feat(ingestion): share entitlement currency extraction"
```

---

### Task 2: Enrich Service-Layer Ingestion Grants

**Files:**
- Modify: `internal/services/src/ingestion/entitlement-context.ts`
- Modify: `internal/services/src/ingestion/entitlement-context.test.ts`

- [ ] **Step 1: Write the failing entitlement-context assertion**

In `internal/services/src/ingestion/entitlement-context.test.ts`, update the expected `grants` object in `"maps customer entitlement records into ingestion entitlements"` to include the enriched fields:

```typescript
      grants: [
        {
          allowanceUnits: null,
          cadenceEffectiveAt: entitlement.effectiveAt,
          cadenceExpiresAt: entitlement.expiresAt,
          currencyCode: "USD",
          effectiveAt: TEST_NOW - 1_000,
          expiresAt: TEST_NOW + 1_000,
          grantId: "grant_unlimited",
          priority: 20,
          resetConfig: {
            name: "monthly",
            resetAnchor: "dayOfCreation",
            resetInterval: "month",
            resetIntervalCount: 1,
            planType: "recurring",
          },
        },
      ],
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
rtk pnpm --filter @unprice/services test:file src/ingestion/entitlement-context.test.ts
```

Expected: FAIL because `toIngestionEntitlement()` does not emit `cadenceEffectiveAt`, `cadenceExpiresAt`, `currencyCode`, or `resetConfig` on each grant.

- [ ] **Step 3: Extend the service ingestion grant type**

In `internal/services/src/ingestion/entitlement-context.ts`, update the import from `../entitlements`:

```typescript
import {
  INGESTION_MAX_EVENT_AGE_MS,
  extractCurrencyCodeFromFeatureConfig,
} from "../entitlements"
```

Replace the `IngestionGrant` type with:

```typescript
export type IngestionGrant = {
  allowanceUnits: number | null
  cadenceEffectiveAt: number
  cadenceExpiresAt: number | null
  currencyCode: string
  effectiveAt: number
  expiresAt: number | null
  grantId: string
  priority: number
  resetConfig: ResetConfig | null
}
```

- [ ] **Step 4: Enrich grants in `toIngestionEntitlement()`**

Inside `toIngestionEntitlement()`, add local constants before the returned object:

```typescript
  const resetConfig =
    entitlement.featurePlanVersion.resetConfig ??
    toResetConfigFromBillingConfig(entitlement.featurePlanVersion.billingConfig)
  const currencyCode =
    extractCurrencyCodeFromFeatureConfig(entitlement.featurePlanVersion.config) ?? "USD"
```

Then replace the `grants` mapping and top-level `resetConfig` field with:

```typescript
    grants: (entitlement.grants ?? []).map((grant) => ({
      allowanceUnits: grant.allowanceUnits,
      cadenceEffectiveAt: entitlement.effectiveAt,
      cadenceExpiresAt: entitlement.expiresAt,
      currencyCode,
      effectiveAt: grant.effectiveAt,
      expiresAt: grant.expiresAt,
      grantId: grant.id,
      priority: grant.priority,
      resetConfig,
    })),
```

```typescript
    resetConfig,
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
rtk pnpm --filter @unprice/services test:file src/ingestion/entitlement-context.test.ts
rtk pnpm --filter @unprice/services typecheck
```

Expected: the test passes. Typecheck may fail in test fixtures that construct old grant literals; fix those in Task 8 unless production code fails here.

- [ ] **Step 6: Commit**

```bash
rtk git add internal/services/src/ingestion/entitlement-context.ts internal/services/src/ingestion/entitlement-context.test.ts
rtk git commit -m "feat(ingestion): enrich ingestion grants at source"
```

---

### Task 3: Update EntitlementWindowDO Contracts

**Files:**
- Modify: `apps/api/src/ingestion/entitlements/contracts.ts`
- Create: `apps/api/src/ingestion/entitlements/contracts.test.ts`

- [ ] **Step 1: Add failing contract tests**

Create `apps/api/src/ingestion/entitlements/contracts.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { activeGrantSchema, enforcementStateInputSchema } from "./contracts"

const enrichedGrant = {
  allowanceUnits: 100,
  cadenceEffectiveAt: 1_781_503_200_000,
  cadenceExpiresAt: null,
  currencyCode: "USD",
  effectiveAt: 1_781_503_200_000,
  expiresAt: null,
  grantId: "grant_123",
  priority: 10,
  resetConfig: null,
}

const entitlement = {
  billingPeriods: [],
  creditLinePolicy: "capped",
  customerEntitlementId: "ce_123",
  customerId: "cus_123",
  effectiveAt: 1_781_503_200_000,
  expiresAt: null,
  featureConfig: {
    usageMode: "unit",
    price: {
      dinero: {
        amount: 0,
        currency: { code: "USD", base: 10, exponent: 2 },
        scale: 2,
      },
      displayAmount: "0.00",
    },
  },
  featurePlanVersionId: "fpv_123",
  featureSlug: "api_calls",
  featureType: "usage",
  meterConfig: {
    eventId: "evt_usage",
    eventSlug: "usage.recorded",
    aggregationMethod: "sum",
    aggregationField: "amount",
  },
  overageStrategy: "none",
  projectId: "proj_123",
  resetConfig: null,
  subscriptionItemId: null,
}

describe("EntitlementWindowDO contracts", () => {
  it("retains enriched grant fields", () => {
    expect(activeGrantSchema.parse(enrichedGrant)).toEqual(enrichedGrant)
  })

  it("rejects legacy grants without cadence, currency, and reset fields", () => {
    const result = activeGrantSchema.safeParse({
      allowanceUnits: 100,
      effectiveAt: 1_781_503_200_000,
      expiresAt: null,
      grantId: "grant_123",
      priority: 10,
    })

    expect(result.success).toBe(false)
  })

  it("requires enforcement input but allows an empty grant array", () => {
    expect(
      enforcementStateInputSchema.parse({
        entitlement,
        grants: [],
        now: 1_781_503_200_000,
      })
    ).toMatchObject({ grants: [] })
  })
})
```

- [ ] **Step 2: Run the failing contract tests**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/entitlements/contracts.test.ts
```

Expected: FAIL because enriched fields are stripped or legacy grants still parse successfully.

- [ ] **Step 3: Update the grant schemas and types**

In `apps/api/src/ingestion/entitlements/contracts.ts`, replace `activeGrantSchema` with:

```typescript
export const activeGrantSchema = z.object({
  allowanceUnits: z.number().finite().nullable(),
  cadenceEffectiveAt: z.number().finite(),
  cadenceExpiresAt: z.number().finite().nullable(),
  currencyCode: z.string().min(1),
  effectiveAt: z.number().finite(),
  expiresAt: z.number().finite().nullable(),
  grantId: z.string().min(1),
  priority: z.number().int(),
  resetConfig: resetConfigSnapshotSchema.nullable(),
})
```

Keep `applyInputSchema.grants` as:

```typescript
  grants: z.array(activeGrantSchema).min(1),
```

Keep `enforcementStateInputSchema.grants` empty-array tolerant:

```typescript
export const enforcementStateInputSchema = z.object({
  entitlement: entitlementConfigSchema,
  grants: z.array(activeGrantSchema),
  now: z.number().finite(),
})
```

Replace the grant type exports near the schema-derived type section with:

```typescript
export type BatchIdempotencyEntry = z.infer<typeof batchIdempotencyEntrySchema>
export type ActiveGrantInput = z.infer<typeof activeGrantSchema>
export type ApplyGrantInput = ActiveGrantInput
export type ApplyInput = z.infer<typeof applyInputSchema>
export type ApplyBatchInput = z.infer<typeof applyBatchInputSchema>
export type ApplyBatchResultRow = ApplyResult & { correlationKey: string; idempotencyKey: string }
```

Delete the old extension type:

```typescript
export type ActiveGrantInput = ApplyGrantInput & {
  cadenceEffectiveAt: number
  cadenceExpiresAt: number | null
  currencyCode: string
  resetConfig: ResetConfig | null
}
```

Update `EnforcementStateCache` so the no-input/null cache shape is gone:

```typescript
export type EnforcementStateCache = {
  entitlement: EntitlementConfigInput
  grants: ActiveGrantInput[]
  inputSignature: string
  states: GrantConsumptionState[]
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/entitlements/contracts.test.ts
rtk pnpm --filter api type-check
```

Expected: contract test passes. Typecheck may fail in files that still treat `getEnforcementState` as optional or construct legacy grant literals; later tasks address those failures.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/ingestion/entitlements/contracts.ts apps/api/src/ingestion/entitlements/contracts.test.ts
rtk git commit -m "feat(ingestion): require enriched entitlement window grants"
```

---

### Task 4: Update RunBudgetDO Contract Forwarding

**Files:**
- Modify: `apps/api/src/ingestion/run-budget/contracts.ts`
- Modify: `apps/api/src/ingestion/run-budget/contracts.test.ts`

- [ ] **Step 1: Add a failing run-budget contract assertion**

Append this test to `apps/api/src/ingestion/run-budget/contracts.test.ts`:

```typescript
  it("retains enriched grants in run sync input", () => {
    const parsed = applyRunSyncEventInputSchema.parse({
      runId: "run_123",
      customerId: "cus_123",
      projectId: "proj_123",
      featureSlug: "tokens",
      idempotencyKey: "idem_123",
      event: {
        id: "evt_123",
        slug: "tokens_used",
        timestamp: 1_781_503_200_000,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_123",
        environment: "development",
        apiKeyId: "api_123",
        sourceType: "api_key",
        sourceId: "api_123",
        sourceName: null,
      },
      now: 1_781_503_200_001,
      customerEntitlementId: "ce_123",
      entitlement: {
        billingPeriods: [],
        creditLinePolicy: "capped",
        customerEntitlementId: "ce_123",
        customerId: "cus_123",
        effectiveAt: 1_781_503_200_000,
        expiresAt: null,
        featureConfig: { usageMode: "unit" },
        featurePlanVersionId: "fpv_123",
        featureSlug: "tokens",
        featureType: "usage",
        meterConfig: {
          eventId: "evt_usage",
          eventSlug: "tokens_used",
          aggregationMethod: "sum",
          aggregationField: "amount",
        },
        overageStrategy: "none",
        projectId: "proj_123",
        resetConfig: null,
        subscriptionItemId: null,
      },
      grants: [
        {
          allowanceUnits: 100,
          cadenceEffectiveAt: 1_781_503_200_000,
          cadenceExpiresAt: null,
          currencyCode: "USD",
          effectiveAt: 1_781_503_200_000,
          expiresAt: null,
          grantId: "grant_123",
          priority: 10,
          resetConfig: null,
        },
      ],
    })

    expect(parsed.grants[0]).toMatchObject({
      cadenceEffectiveAt: 1_781_503_200_000,
      currencyCode: "USD",
      resetConfig: null,
    })
  })
```

- [ ] **Step 2: Run the failing run-budget contract test**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/run-budget/contracts.test.ts
```

Expected: FAIL because `runGrantSchema` strips the enriched fields.

- [ ] **Step 3: Extend `runGrantSchema`**

In `apps/api/src/ingestion/run-budget/contracts.ts`, replace `runGrantSchema` with:

```typescript
const runGrantSchema = z.object({
  allowanceUnits: z.number().finite().nullable(),
  cadenceEffectiveAt: z.number().finite(),
  cadenceExpiresAt: z.number().finite().nullable(),
  currencyCode: z.string().min(1),
  effectiveAt: z.number().finite(),
  expiresAt: z.number().finite().nullable(),
  grantId: z.string().min(1),
  priority: z.number().int(),
  resetConfig: z.custom<unknown>((val) => val === null || (val != null && typeof val === "object")),
})
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/run-budget/contracts.test.ts
rtk pnpm --filter api type-check
```

Expected: run-budget contract tests pass. Typecheck may still fail in downstream fixtures until Task 8.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/ingestion/run-budget/contracts.ts apps/api/src/ingestion/run-budget/contracts.test.ts
rtk git commit -m "feat(run-budget): accept enriched ingestion grants"
```

---

### Task 5: Require Enforcement-State Input At Service Boundary

**Files:**
- Modify: `internal/services/src/ingestion/entitlement-window-applier.ts`
- Verify: `internal/services/src/ingestion/feature-verification.ts`
- Modify if needed: `internal/services/src/ingestion/feature-verification.test.ts`

- [ ] **Step 1: Add a compile-time contract check in the applier test**

In `internal/services/src/ingestion/entitlement-window-applier.test.ts`, add this test near the existing tests for `applyBatch`:

```typescript
  it("exposes getEnforcementState as an input-required controller method", () => {
    type FirstParam = Parameters<EntitlementWindowController["getEnforcementState"]>[0]
    type InputMustNotIncludeUndefined = undefined extends FirstParam ? false : true
    const assertion: InputMustNotIncludeUndefined = true

    expect(assertion).toBe(true)
  })
```

- [ ] **Step 2: Run services typecheck**

Run:

```bash
rtk pnpm --filter @unprice/services typecheck
```

Expected: FAIL while `getEnforcementState` still accepts optional input.

- [ ] **Step 3: Update the controller signature**

In `internal/services/src/ingestion/entitlement-window-applier.ts`, replace:

```typescript
  getEnforcementState: (input?: EntitlementWindowStateInput) => Promise<EntitlementWindowState>
```

with:

```typescript
  getEnforcementState: (input: EntitlementWindowStateInput) => Promise<EntitlementWindowState>
```

Verify `internal/services/src/ingestion/feature-verification.ts` still calls it with:

```typescript
      .getEnforcementState({
        entitlement: applyEntitlement,
        grants: entitlement.grants,
        now: timestamp,
      })
```

- [ ] **Step 4: Run focused verification tests and typecheck**

Run:

```bash
rtk pnpm --filter @unprice/services test:file src/ingestion/feature-verification.test.ts
rtk pnpm --filter @unprice/services test:file src/ingestion/entitlement-window-applier.test.ts
rtk pnpm --filter @unprice/services typecheck
```

Expected: tests pass after fixture updates from Task 8 are applied. If this task is run before Task 8, typecheck may still report legacy grant fixture errors.

- [ ] **Step 5: Commit**

```bash
rtk git add internal/services/src/ingestion/entitlement-window-applier.ts internal/services/src/ingestion/feature-verification.ts internal/services/src/ingestion/feature-verification.test.ts internal/services/src/ingestion/entitlement-window-applier.test.ts
rtk git commit -m "feat(ingestion): require enforcement state input"
```

---

### Task 6: Remove Store Config And Grant Methods

**Files:**
- Modify: `apps/api/src/ingestion/entitlements/entitlement-window-store.ts`
- Modify: `apps/api/src/ingestion/entitlements/entitlement-window-store.test.ts`

- [ ] **Step 1: Remove tests for deleted store behavior**

In `apps/api/src/ingestion/entitlements/entitlement-window-store.test.ts`, delete any tests that call these methods:

```typescript
store.syncEntitlementConfig
store.readEntitlementConfig
store.syncGrants
store.readGrants
```

Keep tests for these methods because they remain valid:

```typescript
parseCompactGrantStates
replaceGrantConsumptionState
readGrantStatesForActiveGrants
readGrantStatesForBatch
selectGrantStatesForActiveGrants
writeGrantStates
readMeterStateDraft
readWalletReservation
writeBatchIdempotencyResults
```

- [ ] **Step 2: Run the store test before code removal**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/entitlements/entitlement-window-store.test.ts
```

Expected: PASS after deleting tests for behavior that will no longer exist.

- [ ] **Step 3: Remove dead imports from the store**

In `apps/api/src/ingestion/entitlements/entitlement-window-store.ts`, replace the top imports with:

```typescript
import type { GrantConsumptionState } from "@unprice/services/entitlements"
import { DO_IDEMPOTENCY_TTL_MS, computeGrantPeriodBucket } from "@unprice/services/entitlements"
import { asc, desc, eq, inArray, lt } from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import type { z } from "zod"
import { idempotencyEntryToApplyResult } from "./batch-apply-helpers"
import {
  APPLY_BATCH_SIZE_LIMIT,
  IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  WALLET_RESERVATION_ROW_ID,
} from "./constants"
import type {
  ActiveGrantInput,
  ApplyResult,
  BatchIdempotencyEntry,
  WalletReservationSnapshot,
} from "./contracts"
import {
  batchIdempotencyEntryListSchema,
  compactGrantConsumptionStateListSchema,
} from "./contracts"
import {
  entitlementPeriodUsageTable,
  idempotencyKeyBatchesTable,
  meterStateTable,
  type schema,
  walletReservationTable,
} from "./db/schema"
import type { MeterStateDraft } from "./meter-state-adapter"
import { unique } from "./utils"
```

- [ ] **Step 4: Delete the store methods that only persist caller context**

Delete these complete methods from `EntitlementWindowStore`:

```typescript
syncEntitlementConfig
assertImmutableEntitlementConfig
readEntitlementConfig
syncGrants
readGrants
```

After deletion, the comment block should jump from wallet reservation methods directly to grant state methods:

```typescript
  // -------------------------------------------------------------------
  // Grant states
  // -------------------------------------------------------------------
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/entitlements/entitlement-window-store.test.ts
rtk pnpm --filter api type-check
```

Expected: store tests pass. Typecheck will still fail until `EntitlementWindowDO.ts` stops calling the deleted methods in Task 7.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/api/src/ingestion/entitlements/entitlement-window-store.ts apps/api/src/ingestion/entitlements/entitlement-window-store.test.ts
rtk git commit -m "refactor(ingestion): remove entitlement context persistence from window store"
```

---

### Task 7: Use Caller Input Directly In EntitlementWindowDO

**Files:**
- Modify: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`
- Modify: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`

- [ ] **Step 1: Update the DO grant fixture helper**

In `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`, replace `createGrantSnapshot()` with:

```typescript
function createGrantSnapshot(overrides: Record<string, unknown> = {}) {
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
    cadenceExpiresAt: null,
    currencyCode: "USD",
    effectiveAt: BASE_NOW - 60_000,
    expiresAt: null,
    grantId: "grant_123",
    priority: 10,
    resetConfig: null,
    ...overrides,
  }
}
```

In `createApplyInput()`, replace the existing `grants` mapping with:

```typescript
    grants: grantSnapshots.map((grant) => ({
      allowanceUnits:
        typeof grant.allowanceUnits === "number"
          ? grant.allowanceUnits
          : typeof grant.amount === "number"
            ? grant.amount
            : null,
      cadenceEffectiveAt: Number(grant.cadenceEffectiveAt),
      cadenceExpiresAt: grant.cadenceExpiresAt != null ? Number(grant.cadenceExpiresAt) : null,
      currencyCode: String(grant.currencyCode),
      effectiveAt: Number(grant.effectiveAt),
      expiresAt: grant.expiresAt != null ? Number(grant.expiresAt) : null,
      grantId: String(grant.grantId),
      priority: Number(grant.priority),
      resetConfig: grant.resetConfig ?? null,
    })),
```

- [ ] **Step 2: Replace no-input enforcement-state calls in tests**

In `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`, replace calls like:

```typescript
await durableObject.getEnforcementState()
```

with calls that pass the same entitlement and grants used to seed/apply the test:

```typescript
await durableObject.getEnforcementState({
  entitlement: input.entitlement,
  grants: input.grants,
  now: BASE_NOW,
})
```

For the fresh-DO default test, use an expired enriched grant instead of no input:

```typescript
const input = createApplyInput({
  grants: [
    createGrantSnapshot({
      grantId: "grant_expired",
      expiresAt: BASE_NOW - 1,
    }),
  ],
})

const result = await durableObject.getEnforcementState({
  entitlement: input.entitlement,
  grants: input.grants,
  now: BASE_NOW,
})

expect(result).toEqual({
  usage: 0,
  limit: null,
  isLimitReached: false,
  spending: {
    currency: "USD",
    ledgerAmount: 0,
    scale: LEDGER_SCALE,
  },
})
```

- [ ] **Step 3: Run the failing DO test**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/entitlements/EntitlementWindowDO.test.ts
```

Expected: FAIL while `EntitlementWindowDO` still calls removed store methods or accepts no-input enforcement-state reads.

- [ ] **Step 4: Simplify optimized batch setup**

In `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`, replace `prepareOptimizedBatch()` with:

```typescript
  private prepareOptimizedBatch(
    input: ApplyBatchInput,
    createdAt: number,
    idempotencyKeys: string[]
  ): OptimizedBatchSetup {
    const entitlement = input.entitlement
    const grants = input.grants
    const meter = resolveMeterIdentity(entitlement)

    return this.db.transaction((tx) => {
      return {
        cachedResults: this.store.lookupCachedIdempotencyResults(idempotencyKeys),
        entitlement,
        grantStates: this.store.readGrantStatesForBatch(
          tx,
          grants,
          input.events.map((event) => event.timestamp)
        ),
        grants,
        meter,
        meterState: this.store.readMeterStateDraft(tx, meter.key, createdAt),
        wallet: this.store.readWalletReservation(tx),
      }
    })
  }
```

- [ ] **Step 5: Simplify single apply context setup**

Replace `prepareSingleApplyContext()` with:

```typescript
  private prepareSingleApplyContext(input: ApplyInput, _createdAt: number): SingleApplyContext {
    const activeGrants = resolveActiveGrants(input.grants, input.event.timestamp)

    if (activeGrants.length === 0) {
      throw new Error("No active grants found for event timestamp")
    }

    return {
      activeGrants,
      creditLinePolicy: input.entitlement.creditLinePolicy,
      entitlement: input.entitlement,
      meter: resolveMeterIdentity(input.entitlement),
      overageStrategy: input.entitlement.overageStrategy,
    }
  }
```

- [ ] **Step 6: Require input in `getEnforcementState()`**

Replace the method signature and input parsing in `getEnforcementState()` with:

```typescript
  public async getEnforcementState(
    rawInput: EnforcementStateInput
  ): Promise<EnforcementStateResult> {
    await this.ready

    const input = enforcementStateInputSchema.parse(rawInput)
    const timestamp = input.now
    const snapshot = this.readEnforcementStateSnapshot(input, timestamp)
    const { entitlement, states } = snapshot
    const activeGrants = resolveActiveGrants(snapshot.grants, timestamp)
```

Keep the existing safe-default return block for `activeGrants.length === 0`.

- [ ] **Step 7: Simplify enforcement-state snapshot reads**

Replace `readEnforcementStateSnapshot()` with:

```typescript
  private readEnforcementStateSnapshot(
    input: EnforcementStateInput,
    timestamp: number
  ): EnforcementStateCache {
    const inputSignature = this.enforcementStateInputSignature(input, timestamp)

    if (
      this.enforcementStateCache &&
      this.enforcementStateCache.inputSignature === inputSignature
    ) {
      return this.enforcementStateCache
    }

    const snapshot = this.db.transaction((tx) => {
      const grants = input.grants
      const activeGrants = resolveActiveGrants(grants, timestamp)

      return {
        entitlement: input.entitlement,
        grants,
        inputSignature,
        states: this.store.readGrantStatesForActiveGrants(tx, activeGrants, timestamp),
      }
    })

    this.enforcementStateCache = snapshot
    return snapshot
  }
```

- [ ] **Step 8: Fix the enforcement-state cache signature**

Replace `enforcementStateInputSignature()` with:

```typescript
  private enforcementStateInputSignature(input: EnforcementStateInput, timestamp: number): string {
    const bucketKeys = [
      ...new Set(
        input.grants
          .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
          .filter((key): key is string => typeof key === "string" && key.length > 0)
      ),
    ].sort()

    return JSON.stringify({
      entitlement: input.entitlement,
      grants: input.grants,
      bucketKeys,
    })
  }
```

- [ ] **Step 9: Remove deleted table imports from the DO**

Keep this schema import:

```typescript
import { meterStateTable, schema, walletReservationTable } from "./db/schema"
```

Remove all calls to:

```typescript
this.store.syncEntitlementConfig
this.store.syncGrants
this.store.readEntitlementConfig
this.store.readGrants
```

- [ ] **Step 10: Run focused DO tests and typecheck**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/entitlements/EntitlementWindowDO.test.ts
rtk pnpm --filter api type-check
```

Expected: DO tests pass after fixture updates. Typecheck may still fail until schema/migration removal from Task 9 is complete.

- [ ] **Step 11: Commit**

```bash
rtk git add apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts
rtk git commit -m "refactor(ingestion): use entitlement window input directly"
```

---

### Task 8: Fix Service And Run-Budget Test Fixtures

**Files:**
- Modify: `internal/services/src/ingestion/service.test.ts`
- Modify: `internal/services/src/ingestion/feature-verification.test.ts`
- Modify: `internal/services/src/ingestion/entitlement-window-applier.test.ts`
- Modify: `internal/services/src/ingestion/entitlement-routing.test.ts`
- Modify: `internal/services/src/ingestion/sync-processor.test.ts`
- Modify if typecheck fails: `internal/services/src/ingestion/message.test.ts`
- Modify if typecheck fails: `internal/services/src/ingestion/prepared-message-processor.test.ts`
- Modify if typecheck fails: `internal/services/src/ingestion/subscription-catchup.test.ts`
- Modify: `apps/api/src/ingestion/run-budget/RunBudgetDO.test.ts`
- Modify if typecheck fails: `apps/api/src/ingestion/entitlements/batch-apply-helpers.test.ts`

- [ ] **Step 1: Add an enriched grant helper to service ingestion tests with grant literals**

In each service ingestion test file that constructs non-empty `grants` arrays, add this helper near the local `createEntitlement()` helper:

```typescript
function createIngestionGrant(
  overrides: Partial<IngestionEntitlement["grants"][number]> = {}
): IngestionEntitlement["grants"][number] {
  return {
    allowanceUnits: 100,
    cadenceEffectiveAt: TEST_NOW - 1_000,
    cadenceExpiresAt: null,
    currencyCode: "USD",
    effectiveAt: TEST_NOW - 1_000,
    expiresAt: null,
    grantId: "grant_123",
    priority: 10,
    resetConfig: null,
    ...overrides,
  }
}
```

If a file uses `BASE_NOW` instead of `TEST_NOW`, use this helper in that file:

```typescript
function createIngestionGrant(
  overrides: Partial<IngestionEntitlement["grants"][number]> = {}
): IngestionEntitlement["grants"][number] {
  return {
    allowanceUnits: 100,
    cadenceEffectiveAt: BASE_NOW - 1_000,
    cadenceExpiresAt: null,
    currencyCode: "USD",
    effectiveAt: BASE_NOW - 1_000,
    expiresAt: null,
    grantId: "grant_123",
    priority: 10,
    resetConfig: null,
    ...overrides,
  }
}
```

- [ ] **Step 2: Replace old service grant literals**

Replace literals shaped like:

```typescript
{
  allowanceUnits: 7,
  effectiveAt: TEST_NOW - 1_000,
  expiresAt: TEST_NOW + 1_000,
  grantId: "grant_active",
  priority: 20,
}
```

with:

```typescript
createIngestionGrant({
  allowanceUnits: 7,
  effectiveAt: TEST_NOW - 1_000,
  expiresAt: TEST_NOW + 1_000,
  grantId: "grant_active",
  priority: 20,
})
```

Replace unlimited grant literals shaped like:

```typescript
{
  allowanceUnits: null,
  effectiveAt: TEST_NOW - 1_000,
  expiresAt: null,
  grantId: "grant_unlimited",
  priority: 20,
}
```

with:

```typescript
createIngestionGrant({
  allowanceUnits: null,
  effectiveAt: TEST_NOW - 1_000,
  expiresAt: null,
  grantId: "grant_unlimited",
  priority: 20,
})
```

- [ ] **Step 3: Update `service.test.ts` fallback grant records**

In `internal/services/src/ingestion/service.test.ts`, update the fallback grant object inside `toGrantRecords()` so it is enriched before being mapped:

```typescript
          createIngestionGrant({
            allowanceUnits: 100,
            cadenceEffectiveAt: entitlement.effectiveAt,
            cadenceExpiresAt: entitlement.expiresAt,
            effectiveAt: entitlement.effectiveAt,
            expiresAt: entitlement.expiresAt,
            grantId: `${entitlement.customerEntitlementId}_grant`,
            priority: 10,
            resetConfig: entitlement.resetConfig,
          }),
```

- [ ] **Step 4: Update RunBudgetDO test grants**

In `apps/api/src/ingestion/run-budget/RunBudgetDO.test.ts`, replace the top-level grant fixture with:

```typescript
  grants: [
    {
      allowanceUnits: 1000,
      cadenceEffectiveAt: 1_781_503_200_000,
      cadenceExpiresAt: null,
      currencyCode: "USD",
      effectiveAt: 1_781_503_200_000,
      expiresAt: null,
      grantId: "grant_1",
      priority: 10,
      resetConfig: null,
    },
  ],
```

- [ ] **Step 5: Run fixture-heavy tests**

Run:

```bash
rtk pnpm --filter @unprice/services test:file src/ingestion/feature-verification.test.ts src/ingestion/entitlement-window-applier.test.ts src/ingestion/service.test.ts src/ingestion/entitlement-routing.test.ts src/ingestion/sync-processor.test.ts
rtk pnpm --filter api test:file src/ingestion/run-budget/RunBudgetDO.test.ts src/ingestion/entitlements/batch-apply-helpers.test.ts
rtk pnpm --filter @unprice/services typecheck
rtk pnpm --filter api type-check
```

Expected: tests pass and typecheck no longer reports old `IngestionGrant` or DO grant shape errors. If typecheck names additional test files with old grant literals, apply the same helper pattern in those files and rerun this step.

- [ ] **Step 6: Commit**

```bash
rtk git add internal/services/src/ingestion apps/api/src/ingestion/run-budget/RunBudgetDO.test.ts apps/api/src/ingestion/entitlements/batch-apply-helpers.test.ts
rtk git commit -m "test(ingestion): use enriched grant fixtures"
```

---

### Task 9: Drop Config And Grant Tables With Generated Migrations

**Files:**
- Modify: `apps/api/src/ingestion/entitlements/db/schema.ts`
- Generate: `apps/api/src/ingestion/entitlements/drizzle/0001_drop_config_grants.sql`
- Generate: `apps/api/src/ingestion/entitlements/drizzle/meta/0001_snapshot.json`
- Generate: `apps/api/src/ingestion/entitlements/drizzle/meta/_journal.json`
- Generate: `apps/api/src/ingestion/entitlements/drizzle/migrations.js`

- [ ] **Step 1: Remove deleted tables from the schema**

In `apps/api/src/ingestion/entitlements/db/schema.ts`, remove these type imports if they become unused:

```typescript
ConfigFeatureVersionType
MeterConfig
OverageStrategy
ResetConfig
```

Delete these table definitions:

```typescript
export const entitlementConfigTable = sqliteTable("entitlement_config", {
  customerEntitlementId: text("customer_entitlement_id").primaryKey(),
  projectId: text("project_id").notNull(),
  customerId: text("customer_id").notNull(),
  effectiveAt: integer("effective_at").notNull(),
  expiresAt: integer("expires_at"),
  featureConfig: text("feature_config", { mode: "json" })
    .$type<ConfigFeatureVersionType>()
    .notNull(),
  featurePlanVersionId: text("feature_plan_version_id").notNull(),
  featureSlug: text("feature_slug").notNull(),
  meterConfig: text("meter_config", { mode: "json" }).$type<MeterConfig>().notNull(),
  overageStrategy: text("overage_strategy").$type<OverageStrategy>().notNull(),
  resetConfig: text("reset_config", { mode: "json" }).$type<ResetConfig | null>(),
  addedAt: integer("added_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const grantsTable = sqliteTable("grants", {
  grantId: text("grant_id").primaryKey(),
  customerEntitlementId: text("customer_entitlement_id").notNull(),
  allowanceUnits: real("allowance_units"),
  effectiveAt: integer("effective_at").notNull(),
  expiresAt: integer("expires_at"),
  priority: integer("priority").notNull(),
  addedAt: integer("added_at").notNull(),
})
```

Replace the schema export with:

```typescript
export const schema = {
  idempotencyKeyBatchesTable,
  entitlementPeriodUsageTable,
  meterStateTable,
  walletReservationTable,
}

export type SchemaIngestion = typeof schema
```

- [ ] **Step 2: Generate the named entitlements migration**

Run:

```bash
rtk pnpm --filter api exec drizzle-kit generate --config=drizzle.ingestion.entitlements.config.ts --name=drop_config_grants
```

Expected: Drizzle creates or updates these files:

```text
apps/api/src/ingestion/entitlements/drizzle/0001_drop_config_grants.sql
apps/api/src/ingestion/entitlements/drizzle/meta/0001_snapshot.json
apps/api/src/ingestion/entitlements/drizzle/meta/_journal.json
apps/api/src/ingestion/entitlements/drizzle/migrations.js
```

The SQL file should contain the generated equivalent of:

```sql
DROP TABLE `entitlement_config`;
--> statement-breakpoint
DROP TABLE `grants`;
```

- [ ] **Step 3: Run the repo migration check**

Run:

```bash
rtk pnpm --filter api db:check:ingestion:migrations
```

Expected: PASS with no additional git diff after the generated files are present. This command also checks the run-budget DO migrations; do not hand-edit migration metadata to satisfy it.

- [ ] **Step 4: Run API typecheck**

Run:

```bash
rtk pnpm --filter api type-check
```

Expected: PASS. If the compiler reports imports of `entitlementConfigTable` or `grantsTable`, remove those imports and rerun.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/ingestion/entitlements/db/schema.ts apps/api/src/ingestion/entitlements/drizzle
rtk git commit -m "feat(ingestion): drop entitlement window context tables"
```

---

### Task 10: Final Verification

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run affected service tests**

Run:

```bash
rtk pnpm --filter @unprice/services test:file src/entitlements/grant-consumption.test.ts src/ingestion/entitlement-context.test.ts src/ingestion/feature-verification.test.ts src/ingestion/entitlement-window-applier.test.ts src/ingestion/service.test.ts src/ingestion/entitlement-routing.test.ts src/ingestion/sync-processor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run affected API tests**

Run:

```bash
rtk pnpm --filter api test:file src/ingestion/entitlements/contracts.test.ts src/ingestion/entitlements/meter-helpers.test.ts src/ingestion/entitlements/entitlement-window-store.test.ts src/ingestion/entitlements/EntitlementWindowDO.test.ts src/ingestion/run-budget/contracts.test.ts src/ingestion/run-budget/RunBudgetDO.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run affected package typechecks**

Run:

```bash
rtk pnpm --filter @unprice/services typecheck
rtk pnpm --filter api type-check
rtk pnpm --filter @unprice/trpc typecheck
```

Expected: PASS.

- [ ] **Step 4: Run migration check again**

Run:

```bash
rtk pnpm --filter api db:check:ingestion:migrations
```

Expected: PASS with no diff.

- [ ] **Step 5: Run full validation**

Run:

```bash
rtk pnpm validate
```

Expected: PASS.

- [ ] **Step 6: Inspect final diff**

Run:

```bash
rtk git status --short
rtk git diff --stat
```

Expected: only files named in this plan are changed, plus generated migration artifacts. Existing unrelated changes such as `tooling/k6/budgeted-runs.js` should remain untouched unless the user explicitly asks to include them.

- [ ] **Step 7: Commit final fixes if validation required changes**

```bash
rtk git add internal/services/src/entitlements/grant-consumption.ts internal/services/src/entitlements/grant-consumption.test.ts internal/services/src/ingestion apps/api/src/ingestion
rtk git commit -m "test(ingestion): validate entitlement window context table removal"
```

---

## Self-Review

**Spec coverage:** This plan removes redundant DO-local config/grant persistence, enriches the upstream grant contract, updates normal ingestion and run-budget forwarding, keeps enforcement-state reads input-driven, and uses generated durable SQLite migrations.

**Placeholder scan:** The plan avoids banned placeholder terms and open-ended implementation steps. The generated file names are made deterministic by using Drizzle's `--name=drop_config_grants` option.

**Type consistency:** `IngestionGrant`, `activeGrantSchema`, `ActiveGrantInput`, RunBudgetDO `runGrantSchema`, and test helpers all use the same fields: `allowanceUnits`, `cadenceEffectiveAt`, `cadenceExpiresAt`, `currencyCode`, `effectiveAt`, `expiresAt`, `grantId`, `priority`, and `resetConfig`.

**Tradeoff:** The DO no longer checks immutable entitlement config drift against its previous SQLite snapshot. That check was on the hot path and duplicated the service-layer source of truth. The replacement invariant is stronger at the boundary: every caller must send fully enriched grants, and Zod rejects legacy grant shapes before the DO mutates durable usage state.
