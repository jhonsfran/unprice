# API SDK DX Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public API endpoint contract-first so Hono routes, OpenAPI, docs, and the TypeScript SDK stay aligned from one declared product operation.

**Architecture:** Keep business ownership in the existing Hono route files, but wrap route declarations with a thin endpoint contract helper that records audience, docs exposure, SDK exposure, product category, and idempotency metadata. Rename the public HTTP paths to the same product language as the SDK, then generate SDK resource methods only from public OpenAPI operations whose `x-unprice.sdk` is not `false`. React package work is out of scope.

**Tech Stack:** TypeScript, Hono, `@hono/zod-openapi`, Zod, `openapi-fetch`, `openapi-typescript`, Vitest, Node.js generation scripts, Mintlify docs.

---

## Scope Check

This is one cohesive subsystem: public endpoint contracts, breaking public path renames, and the generated SDK surface. It intentionally excludes `packages/react`, dashboard UI, tRPC, new product behavior, and backwards-compatible aliases. Existing route handlers should keep their service/use-case ownership; this plan changes the public API naming layer, OpenAPI metadata, SDK generation, docs examples, and tooling call sites.

The key invariant:

```text
For every SDK-exposed public endpoint:
operationId === sdk.path.join(".")
audience === "public"
sdk !== false
```

Public endpoints can set `sdk: false` when they should remain callable and documented but not appear as first-class SDK methods. Internal and provider-callback routes must set `sdk: false` and never generate SDK resources.

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `docs/adr/ADR-0003-api-operation-contracts-and-sdk-surface.md` | Create | Documents the endpoint contract architecture and naming rules. |
| `apps/api/src/openapi/endpoint-contract.ts` | Create | Defines endpoint audience, docs, SDK, category, and idempotency metadata and validates route contracts. |
| `apps/api/src/openapi/endpoint-contract.test.ts` | Create | Unit-tests contract validation rules. |
| `apps/api/src/openapi/public-operation-contracts.test.ts` | Create | Imports all route declarations and proves every registered OpenAPI route has a valid endpoint contract. |
| `apps/api/src/routes/**` | Modify | Rename public paths/operation IDs and add `defineEndpointContract(...)` metadata. |
| `packages/api/src/result.ts` | Create | Owns `ApiResult`/`Result` types outside `client.ts` so generated resources can import them. |
| `packages/api/src/operation-types.ts` | Create | Derives typed SDK operation inputs/responses from generated `openapi.d.ts`. |
| `packages/api/scripts/generate-sdk-resources.mjs` | Create | Reads OpenAPI JSON and writes generated SDK resource methods for public operations whose contract has SDK metadata. |
| `packages/api/src/generated/sdk-resources.ts` | Generate | Public SDK resource tree generated from SDK-enabled OpenAPI `x-unprice` metadata. |
| `packages/api/src/client.ts` | Modify | Replace hand-written endpoint wrappers with generated resources and one generic operation caller. |
| `packages/api/src/errors.ts` | Modify | Remove stale `/test` generated residue and derive error payloads from `openapi.d.ts` components. |
| `packages/api/src/client.test.ts` | Modify | Assert the new SDK namespace shape and transport behavior. |
| `packages/api/src/openapi-contract.test.ts` | Create | Fails when docs OpenAPI and generated SDK resources drift. |
| `packages/api/package.json` | Modify | Make `pnpm generate` update docs OpenAPI, generated types, and SDK resource code together. |
| `apps/docs/openapi.json` | Generate | Same OpenAPI source used by docs and SDK generation. |
| `apps/docs/**/*.mdx` | Modify | Update SDK examples to new product operation names. |
| `tooling/tiny-tools/**/*.ts` | Modify | Update non-React SDK call sites to the new generated SDK surface. |
| `lessons.md` | Modify | Add a durable rule for public endpoint contract development. |

## Canonical Public Surface

Use this mapping during route migration. The old paths are intentionally removed; do not add compatibility aliases.

| Current operation | New operation | New path | Audience | Category | SDK |
|---|---|---|---|---|---|
| `access.update` | `access.update` | `POST /v1/access/update` | `public` | `configuration` | `access.update` |
| `entitlements.verify` | `access.check` | `POST /v1/access/check` | `public` | `runtime` | `access.check` |
| `entitlements.get` | `access.entitlements.list` | `POST /v1/access/entitlements/list` | `public` | `configuration` | `access.entitlements.list` |
| `events.ingest` | `usage.record` | `POST /v1/usage/record` | `public` | `runtime` | `usage.record` |
| `events.ingestSync` | `usage.consume` | `POST /v1/usage/consume` | `public` | `runtime` | `usage.consume` |
| `runs.start` | `runs.start` | `POST /v1/runs/start` | `public` | `runtime` | `runs.start` |
| `runs.events.sync` | `runs.consume` | `POST /v1/runs/consume/{runId}` | `public` | `runtime` | `runs.consume` |
| `runs.end` | `runs.end` | `POST /v1/runs/end/{runId}` | `public` | `runtime` | `runs.end` |
| `runs.get` | `runs.get` | `GET /v1/runs/get/{runId}` | `public` | `runtime` | `runs.get` |
| `customers.signUp` | `customers.signUp` | `POST /v1/customers/sign-up` | `public` | `configuration` | `customers.signUp` |
| `features.list` | `features.list` | `GET /v1/features/list` | `public` | `configuration` | `features.list` |
| `plans.listVersions` | `planVersions.list` | `POST /v1/plan-versions/list` | `public` | `configuration` | `planVersions.list` |
| `plans.getVersion` | `planVersions.get` | `GET /v1/plan-versions/get/{planVersionId}` | `public` | `configuration` | `planVersions.get` |
| `subscriptions.get` | `subscriptions.get` | `POST /v1/subscriptions/get` | `public` | `configuration` | `subscriptions.get` |
| `payments.methods.list` | `paymentMethods.list` | `POST /v1/payment-methods/list` | `public` | `configuration` | `paymentMethods.list` |
| `payments.methods.create` | `paymentMethods.create` | `POST /v1/payment-methods/create` | `public` | `configuration` | `paymentMethods.create` |
| `wallet.balance` | `wallet.balance` | `GET /v1/wallet/balance` | `public` | `money` | `wallet.balance` |
| `wallet.creditBalance` | `walletCredits.balance` | `GET /v1/wallet-credits/balance/{walletId}` | `public` | `money` | `walletCredits.balance` |
| `wallet.get` | `wallet.internalGet` | `GET /v1/internal/wallet/get` | `internal` | `money` | `false` |
| `invoices.get` | `invoices.get` | `GET /v1/invoices/get/{invoiceId}` | `public` | `money` | `invoices.get` |
| `analytics.usage.get` | `analytics.usage.get` | `POST /v1/analytics/usage/get` | `public` | `analytics` | `analytics.usage.get` |
| `analytics.explainCharge` | `analytics.charges.explain` | `POST /v1/analytics/charges/explain` | `public` | `analytics` | `analytics.charges.explain` |
| `analytics.forecastUsage` | `analytics.usage.forecast` | `POST /v1/analytics/usage/forecast` | `public` | `analytics` | `analytics.usage.forecast` |
| `analytics.ingestion.status` | `ingestionEvents.status` | `POST /v1/ingestion-events/status` | `public` | `operations` | `ingestionEvents.status` |
| `events.ingest.replay` | `ingestionEvents.replay` | `POST /v1/ingestion-events/replay` | `public` | `operations` | `ingestionEvents.replay` |
| `events.entitlementWindowStatus` | `entitlementWindows.status` | `GET /v1/internal/entitlement-windows/status` | `internal` | `operations` | `false` |
| `billing.reservations.flushForInvoicing` | `billingReservations.flushForInvoicing` | `POST /v1/internal/billing-reservations/flush-for-invoicing` | `internal` | `operations` | `false` |
| `payments.providers.signUp` | `paymentProviderCallbacks.signUp` | `GET /v1/payment-provider-callbacks/{provider}/sign-up/{sessionId}/{projectId}` | `callback` | `configuration` | `false` |
| `payments.providers.setup` | `paymentProviderCallbacks.setup` | `GET /v1/payment-provider-callbacks/{provider}/setup/{sessionId}/{projectId}` | `callback` | `configuration` | `false` |
| `payments.providers.webhook` | `paymentProviderCallbacks.webhook` | `POST /v1/payment-provider-callbacks/{provider}/webhook/{projectId}` | `callback` | `configuration` | `false` |
| `payments.providers.stripeConnectWebhook` | `paymentProviderCallbacks.stripeConnectWebhook` | `POST /v1/payment-provider-callbacks/stripe-connect/webhook` | `callback` | `configuration` | `false` |

Generated SDK namespaces after migration:

```ts
unprice.access.update(...)
unprice.access.check(...)
unprice.access.entitlements.list(...)
unprice.usage.record(...)
unprice.usage.consume(...)
unprice.runs.start(...)
unprice.runs.consume(...)
unprice.runs.end(...)
unprice.runs.get(...)
unprice.customers.signUp(...)
unprice.features.list()
unprice.planVersions.list(...)
unprice.planVersions.get(...)
unprice.subscriptions.get(...)
unprice.paymentMethods.list(...)
unprice.paymentMethods.create(...)
unprice.wallet.balance(...)
unprice.walletCredits.balance(...)
unprice.invoices.get(...)
unprice.analytics.usage.get(...)
unprice.analytics.usage.forecast(...)
unprice.analytics.charges.explain(...)
unprice.ingestionEvents.status(...)
unprice.ingestionEvents.replay(...)
```

### Task 1: Record The Architecture Decision

**Files:**
- Create: `docs/adr/ADR-0003-api-operation-contracts-and-sdk-surface.md`

- [ ] **Step 1: Create the ADR**

Create `docs/adr/ADR-0003-api-operation-contracts-and-sdk-surface.md` with:

```markdown
# ADR-0003: API Operation Contracts And SDK Surface

## Status

Accepted

## Context

The public Hono API, generated OpenAPI types, docs OpenAPI JSON, and TypeScript SDK can drift independently. Recent drift examples include SDK-generated OpenAPI types mentioning operations that the current API source no longer registers, docs OpenAPI missing current routes, stale docs containing removed realtime operations, and public route operation IDs that expose implementation terms instead of product jobs.

Developers using Unprice think in product workflows: checking access, recording usage, consuming usage with an immediate decision, managing runs, reading wallet/invoice state, configuring customers/plans/features/subscriptions/payment methods, and inspecting analytics or ingestion health. They should not need to know whether a workflow is internally implemented as entitlements, events, analytics, Durable Objects, or provider callbacks.

## Decision

Every API route must declare an Unprice endpoint contract next to its Hono OpenAPI route declaration. The contract records:

- `audience`: `public`, `internal`, or `callback`.
- `category`: `runtime`, `configuration`, `money`, `analytics`, or `operations`.
- `docs.expose` when an operation should be visible in generated public docs.
- `sdk.path` for SDK-exposed public operations, or `sdk: false` when an operation should not generate a first-class SDK method.
- `idempotency` metadata for side-effecting public operations.

For every SDK-exposed public endpoint, `operationId` must equal `sdk.path.join(".")`. The first OpenAPI tag and first public path segment must match the top-level SDK namespace using product language.

The TypeScript SDK public resource tree is generated from the OpenAPI document by reading public endpoint contracts whose `sdk` field is not `false`. Hand-written SDK transport logic remains centralized in one generic operation caller; individual endpoint wrappers are generated.

Internal and provider-callback routes may appear in OpenAPI for operational visibility, but they must set `sdk: false` and never generate public SDK resources.

## Consequences

New public endpoint development becomes contract-first: route metadata, OpenAPI, docs JSON, and SDK resources are generated or checked from one declared product operation.

The SDK becomes less hand-written, which reduces polish drift but requires moving endpoint-specific ergonomic defaults into the API contract itself.

Renaming public operations is an explicit API design step. This ADR allows a breaking migration because backwards compatibility is not required for this project stage.

## Rules

- SDK-exposed public endpoint `operationId` equals SDK method path.
- Public endpoints that should stay out of the SDK set `sdk: false`.
- Public SDK methods are one-object calls, except zero-input methods.
- Side-effecting public operations declare idempotency metadata.
- Internal and callback routes set `audience` plus `sdk: false` and are ignored by SDK generation.
- Docs OpenAPI and SDK generated OpenAPI types come from the same local API document.
- `packages/react` is out of scope for this ADR.
```

- [ ] **Step 2: Check the ADR**

Run:

```bash
rtk pnpm biome check --no-errors-on-unmatched docs/adr/ADR-0003-api-operation-contracts-and-sdk-surface.md
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
rtk git add docs/adr/ADR-0003-api-operation-contracts-and-sdk-surface.md
rtk git commit -m "docs: record api sdk contract architecture"
```

Expected: commit succeeds.

### Task 2: Add Endpoint Contract Helper

**Files:**
- Create: `apps/api/src/openapi/endpoint-contract.ts`
- Create: `apps/api/src/openapi/endpoint-contract.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/openapi/endpoint-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { defineEndpointContract } from "./endpoint-contract"

const baseRoute = {
  path: "/v1/usage/record",
  operationId: "usage.record",
  summary: "record usage",
  description: "Record usage asynchronously.",
  method: "post",
  tags: ["usage"],
  responses: {},
} as const

describe("defineEndpointContract", () => {
  it("attaches public endpoint metadata when sdk path matches the operation id", () => {
    const route = defineEndpointContract(baseRoute, {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["usage", "record"],
      },
      idempotency: {
        required: true,
        location: "body",
        field: "idempotencyKey",
      },
    })

    expect(route["x-unprice"]).toEqual({
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["usage", "record"],
      },
      idempotency: {
        required: true,
        location: "body",
        field: "idempotencyKey",
      },
    })
  })

  it("rejects public contracts without sdk metadata", () => {
    expect(() =>
      defineEndpointContract(baseRoute, {
        audience: "public",
        category: "runtime",
      } as never)
    ).toThrow("endpoint usage.record must declare sdk metadata")
  })

  it("allows public routes to opt out of SDK generation", () => {
    const route = defineEndpointContract(
      {
        ...baseRoute,
        operationId: "usage.experimentalInspect",
      },
      {
        audience: "public",
        category: "operations",
        docs: {
          expose: true,
        },
        sdk: false,
      }
    )

    expect(route["x-unprice"].sdk).toBe(false)
  })

  it("rejects public contracts whose sdk path differs from the operation id", () => {
    expect(() =>
      defineEndpointContract(baseRoute, {
        audience: "public",
        category: "runtime",
        docs: {
          expose: true,
        },
        sdk: {
          path: ["events", "ingest"],
        },
      })
    ).toThrow("public endpoint usage.record must use sdk.path usage.record")
  })

  it("rejects routes whose first tag does not match the public sdk namespace", () => {
    expect(() =>
      defineEndpointContract(
        {
          ...baseRoute,
          tags: ["events"],
        },
        {
          audience: "public",
          category: "runtime",
          docs: {
            expose: true,
          },
          sdk: {
            path: ["usage", "record"],
          },
        }
      )
    ).toThrow("public endpoint usage.record must use first tag usage")
  })

  it("rejects routes whose first public path segment does not match the sdk namespace", () => {
    expect(() =>
      defineEndpointContract(
        {
          ...baseRoute,
          path: "/v1/events/ingest",
        },
        {
          audience: "public",
          category: "runtime",
          docs: {
            expose: true,
          },
          sdk: {
            path: ["usage", "record"],
          },
        }
      )
    ).toThrow("public endpoint usage.record must use first /v1 path segment usage")
  })

  it("allows internal routes with sdk disabled", () => {
    const route = defineEndpointContract(
      {
        ...baseRoute,
        path: "/v1/internal/billing-reservations/flush-for-invoicing",
        operationId: "billingReservations.flushForInvoicing",
        tags: ["billingReservations"],
      },
      {
        audience: "internal",
        category: "operations",
        docs: {
          expose: false,
        },
        sdk: false,
      }
    )

    expect(route["x-unprice"].audience).toBe("internal")
  })

  it("rejects internal routes with SDK metadata", () => {
    expect(() =>
      defineEndpointContract(
        {
          ...baseRoute,
          path: "/v1/internal/usage/record",
        },
        {
          audience: "internal",
          category: "operations",
          docs: {
            expose: false,
          },
          sdk: {
            path: ["usage", "record"],
          },
        }
      )
    ).toThrow("internal endpoint usage.record must use sdk: false")
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
rtk pnpm --filter api test src/openapi/endpoint-contract.test.ts
```

Expected: FAIL because `apps/api/src/openapi/endpoint-contract.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/openapi/endpoint-contract.ts`:

```ts
import type { createRoute } from "@hono/zod-openapi"

type RouteConfig = Parameters<typeof createRoute>[0]

export type EndpointAudience = "public" | "internal" | "callback"
export type EndpointCategory = "runtime" | "configuration" | "money" | "analytics" | "operations"

export type EndpointContract = {
  audience: EndpointAudience
  category: EndpointCategory
  docs?: {
    expose: boolean
  }
  sdk: false | {
    path: readonly [string, ...string[]]
  }
  idempotency?: {
    required: boolean
    location: "body" | "header"
    field: string
  }
}

type RouteIdentity = {
  operationId: string
  path: string
  tags: readonly string[]
}

type EndpointRouteConfig = RouteConfig & RouteIdentity

type EndpointRouteExtension = {
  "x-unprice": EndpointContract
}

function sdkPathToOperationId(path: readonly [string, ...string[]]): string {
  return path.join(".")
}

function getFirstPublicPathSegment(path: string): string | null {
  const parts = path.split("/").filter(Boolean)

  if (parts[0] !== "v1") {
    return null
  }

  if (parts[1] === "internal") {
    return parts[2] ?? null
  }

  return parts[1] ?? null
}

function normalizePathSegment(segment: string | null): string | null {
  if (!segment) {
    return null
  }

  return segment.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

export function validateEndpointContract(route: RouteIdentity, contract: EndpointContract): void {
  if (contract.sdk === undefined) {
    throw new Error(`endpoint ${route.operationId} must declare sdk metadata`)
  }

  if (contract.audience !== "public") {
    if (contract.sdk !== false) {
      throw new Error(`${contract.audience} endpoint ${route.operationId} must use sdk: false`)
    }

    return
  }

  if (contract.sdk === false) {
    return
  }

  const expectedOperationId = sdkPathToOperationId(contract.sdk.path)

  if (route.operationId !== expectedOperationId) {
    throw new Error(`public endpoint ${route.operationId} must use sdk.path ${expectedOperationId}`)
  }

  const sdkNamespace = contract.sdk.path[0]
  const firstTag = route.tags[0]

  if (firstTag !== sdkNamespace) {
    throw new Error(`public endpoint ${route.operationId} must use first tag ${sdkNamespace}`)
  }

  const firstPathSegment = normalizePathSegment(getFirstPublicPathSegment(route.path))

  if (firstPathSegment !== sdkNamespace) {
    throw new Error(
      `public endpoint ${route.operationId} must use first /v1 path segment ${sdkNamespace}`
    )
  }
}

export function defineEndpointContract<const TRoute extends EndpointRouteConfig>(
  route: TRoute,
  contract: EndpointContract
): TRoute & EndpointRouteExtension {
  validateEndpointContract(route, contract)

  return {
    ...route,
    "x-unprice": contract,
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
rtk pnpm --filter api test src/openapi/endpoint-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/api/src/openapi/endpoint-contract.ts apps/api/src/openapi/endpoint-contract.test.ts
rtk git commit -m "feat: add api endpoint contract helper"
```

Expected: commit succeeds.

### Task 3: Migrate API Routes To Contract Metadata

**Files:**
- Modify: `apps/api/src/routes/access/updateACLV1.ts`
- Modify: `apps/api/src/routes/entitlements/verifyV1.ts`
- Modify: `apps/api/src/routes/entitlements/getEntitlementsV1.ts`
- Modify: `apps/api/src/routes/events/ingestEventsV1.ts`
- Modify: `apps/api/src/routes/events/ingestEventsSyncV1.ts`
- Modify: `apps/api/src/routes/events/replayIngestionEventsV1.ts`
- Modify: `apps/api/src/routes/runs/startRunV1.ts`
- Modify: `apps/api/src/routes/runs/applyRunSyncEventV1.ts`
- Modify: `apps/api/src/routes/runs/endRunV1.ts`
- Modify: `apps/api/src/routes/runs/getRunV1.ts`
- Modify: `apps/api/src/routes/customers/signUpV1.ts`
- Modify: `apps/api/src/routes/features/getFeaturesV1.ts`
- Modify: `apps/api/src/routes/plans/listPlanVersionsV1.ts`
- Modify: `apps/api/src/routes/plans/getPlanVersionV1.ts`
- Modify: `apps/api/src/routes/subscriptions/getSubscriptionV1.ts`
- Modify: `apps/api/src/routes/payments/methods/listPaymentMethodsV1.ts`
- Modify: `apps/api/src/routes/payments/methods/createPaymentMethodV1.ts`
- Modify: `apps/api/src/routes/wallet/getWalletV1.ts`
- Modify: `apps/api/src/routes/invoices/getInvoiceV1.ts`
- Modify: `apps/api/src/routes/analytics/getUsageV1.ts`
- Modify: `apps/api/src/routes/analytics/explainChargeV1.ts`
- Modify: `apps/api/src/routes/analytics/forecastUsageV1.ts`
- Modify: `apps/api/src/routes/analytics/getIngestionStatusV1.ts`
- Modify: `apps/api/src/routes/entitlements/getEntitlementWindowStatusV1.ts`
- Modify: `apps/api/src/routes/billing/flushReservationsForInvoicingV1.ts`
- Modify: `apps/api/src/routes/payments/providers/providerSignUpV1.ts`
- Modify: `apps/api/src/routes/payments/providers/providerSetupV1.ts`
- Modify: `apps/api/src/routes/payments/providers/providerWebhookV1.ts`
- Modify: `apps/api/src/routes/payments/providers/providerStripeConnectWebhookV1.ts`
- Create: `apps/api/src/openapi/public-operation-contracts.test.ts`

- [ ] **Step 1: Write the route contract conformance test**

Create `apps/api/src/openapi/public-operation-contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { route as updateAccessRoute } from "../routes/access/updateACLV1"
import { route as explainChargeRoute } from "../routes/analytics/explainChargeV1"
import { route as forecastUsageRoute } from "../routes/analytics/forecastUsageV1"
import { route as ingestionStatusRoute } from "../routes/analytics/getIngestionStatusV1"
import { route as analyticsUsageRoute } from "../routes/analytics/getUsageV1"
import { route as flushReservationsRoute } from "../routes/billing/flushReservationsForInvoicingV1"
import { route as signUpRoute } from "../routes/customers/signUpV1"
import { route as entitlementWindowStatusRoute } from "../routes/entitlements/getEntitlementWindowStatusV1"
import { route as getEntitlementsRoute } from "../routes/entitlements/getEntitlementsV1"
import { route as checkAccessRoute } from "../routes/entitlements/verifyV1"
import { route as recordUsageRoute } from "../routes/events/ingestEventsV1"
import { route as consumeUsageRoute } from "../routes/events/ingestEventsSyncV1"
import { route as replayIngestionEventsRoute } from "../routes/events/replayIngestionEventsV1"
import { route as featuresRoute } from "../routes/features/getFeaturesV1"
import { route as invoiceRoute } from "../routes/invoices/getInvoiceV1"
import { route as createPaymentMethodRoute } from "../routes/payments/methods/createPaymentMethodV1"
import { route as listPaymentMethodsRoute } from "../routes/payments/methods/listPaymentMethodsV1"
import { route as providerSetupRoute } from "../routes/payments/providers/providerSetupV1"
import { route as providerSignUpRoute } from "../routes/payments/providers/providerSignUpV1"
import { route as providerStripeConnectWebhookRoute } from "../routes/payments/providers/providerStripeConnectWebhookV1"
import { route as providerWebhookRoute } from "../routes/payments/providers/providerWebhookV1"
import { route as getPlanVersionRoute } from "../routes/plans/getPlanVersionV1"
import { route as listPlanVersionsRoute } from "../routes/plans/listPlanVersionsV1"
import { route as consumeRunRoute } from "../routes/runs/applyRunSyncEventV1"
import { route as endRunRoute } from "../routes/runs/endRunV1"
import { route as getRunRoute } from "../routes/runs/getRunV1"
import { route as startRunRoute } from "../routes/runs/startRunV1"
import { route as subscriptionRoute } from "../routes/subscriptions/getSubscriptionV1"
import {
  route as walletRoute,
  walletBalanceRoute,
  walletCreditBalanceRoute,
} from "../routes/wallet/getWalletV1"
import type { EndpointContract } from "./endpoint-contract"
import { validateEndpointContract } from "./endpoint-contract"

type ContractedRoute = {
  operationId: string
  method: string
  path: string
  tags: readonly string[]
  "x-unprice"?: EndpointContract
}

const routes: ContractedRoute[] = [
  updateAccessRoute,
  startRunRoute,
  consumeRunRoute,
  endRunRoute,
  getRunRoute,
  flushReservationsRoute,
  signUpRoute,
  getEntitlementsRoute,
  checkAccessRoute,
  recordUsageRoute,
  consumeUsageRoute,
  replayIngestionEventsRoute,
  entitlementWindowStatusRoute,
  featuresRoute,
  invoiceRoute,
  listPaymentMethodsRoute,
  createPaymentMethodRoute,
  providerSignUpRoute,
  providerSetupRoute,
  providerWebhookRoute,
  providerStripeConnectWebhookRoute,
  getPlanVersionRoute,
  listPlanVersionsRoute,
  subscriptionRoute,
  explainChargeRoute,
  forecastUsageRoute,
  ingestionStatusRoute,
  analyticsUsageRoute,
  walletBalanceRoute,
  walletCreditBalanceRoute,
  walletRoute,
]

const expectedSdkOperationIds = [
  "access.update",
  "access.check",
  "access.entitlements.list",
  "usage.record",
  "usage.consume",
  "runs.start",
  "runs.consume",
  "runs.end",
  "runs.get",
  "customers.signUp",
  "features.list",
  "planVersions.list",
  "planVersions.get",
  "subscriptions.get",
  "paymentMethods.list",
  "paymentMethods.create",
  "wallet.balance",
  "walletCredits.balance",
  "invoices.get",
  "analytics.usage.get",
  "analytics.charges.explain",
  "analytics.usage.forecast",
  "ingestionEvents.status",
  "ingestionEvents.replay",
]

const expectedRoutePaths: Record<string, string> = {
  "access.update": "POST /v1/access/update",
  "access.check": "POST /v1/access/check",
  "access.entitlements.list": "POST /v1/access/entitlements/list",
  "usage.record": "POST /v1/usage/record",
  "usage.consume": "POST /v1/usage/consume",
  "runs.start": "POST /v1/runs/start",
  "runs.consume": "POST /v1/runs/consume/{runId}",
  "runs.end": "POST /v1/runs/end/{runId}",
  "runs.get": "GET /v1/runs/get/{runId}",
  "customers.signUp": "POST /v1/customers/sign-up",
  "features.list": "GET /v1/features/list",
  "planVersions.list": "POST /v1/plan-versions/list",
  "planVersions.get": "GET /v1/plan-versions/get/{planVersionId}",
  "subscriptions.get": "POST /v1/subscriptions/get",
  "paymentMethods.list": "POST /v1/payment-methods/list",
  "paymentMethods.create": "POST /v1/payment-methods/create",
  "wallet.balance": "GET /v1/wallet/balance",
  "walletCredits.balance": "GET /v1/wallet-credits/balance/{walletId}",
  "wallet.internalGet": "GET /v1/internal/wallet/get",
  "invoices.get": "GET /v1/invoices/get/{invoiceId}",
  "analytics.usage.get": "POST /v1/analytics/usage/get",
  "analytics.charges.explain": "POST /v1/analytics/charges/explain",
  "analytics.usage.forecast": "POST /v1/analytics/usage/forecast",
  "ingestionEvents.status": "POST /v1/ingestion-events/status",
  "ingestionEvents.replay": "POST /v1/ingestion-events/replay",
  "entitlementWindows.status": "GET /v1/internal/entitlement-windows/status",
  "billingReservations.flushForInvoicing":
    "POST /v1/internal/billing-reservations/flush-for-invoicing",
  "paymentProviderCallbacks.signUp":
    "GET /v1/payment-provider-callbacks/{provider}/sign-up/{sessionId}/{projectId}",
  "paymentProviderCallbacks.setup":
    "GET /v1/payment-provider-callbacks/{provider}/setup/{sessionId}/{projectId}",
  "paymentProviderCallbacks.webhook":
    "POST /v1/payment-provider-callbacks/{provider}/webhook/{projectId}",
  "paymentProviderCallbacks.stripeConnectWebhook":
    "POST /v1/payment-provider-callbacks/stripe-connect/webhook",
}

describe("API endpoint contracts", () => {
  it("declares audience metadata for every registered OpenAPI route", () => {
    for (const route of routes) {
      expect(route["x-unprice"], route.operationId).toBeDefined()
    }
  })

  it("has no duplicate operation ids", () => {
    const operationIds = routes.map((route) => route.operationId)
    expect(new Set(operationIds).size).toBe(operationIds.length)
  })

  it("validates every endpoint contract", () => {
    for (const route of routes) {
      const contract = route["x-unprice"]
      expect(contract, route.operationId).toBeDefined()
      validateEndpointContract(route, contract!)
    }
  })

  it("renames registered routes to the canonical public contract paths", () => {
    for (const route of routes) {
      const method = String(route.method).toUpperCase()
      expect(`${method} ${route.path}`, route.operationId).toBe(
        expectedRoutePaths[route.operationId]
      )
    }
  })

  it("exposes exactly the expected SDK operations", () => {
    const sdkOperationIds = routes
      .filter((route) => route["x-unprice"]?.audience === "public")
      .filter((route) => route["x-unprice"]?.sdk !== false)
      .map((route) => route.operationId)
      .sort()

    expect(sdkOperationIds).toEqual([...expectedSdkOperationIds].sort())
  })

  it("keeps non-SDK operations out of generated SDK resources", () => {
    for (const route of routes.filter((route) => route["x-unprice"]?.audience !== "public")) {
      expect(route["x-unprice"]?.sdk, route.operationId).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run the conformance test and verify it fails**

Run:

```bash
rtk pnpm --filter api test src/openapi/public-operation-contracts.test.ts
```

Expected: FAIL because route files do not yet export `x-unprice` metadata and `getEntitlementWindowStatusV1.ts` does not export its `route` constant.

- [ ] **Step 3: Add the helper import to each migrated route file**

In every route file listed for this task, add this import near the existing OpenAPI imports:

```ts
import { defineEndpointContract } from "~/openapi/endpoint-contract"
```

For provider callback routes, internal routes, and public routes, keep `createRoute` from `@hono/zod-openapi`; only wrap its route config argument.

- [ ] **Step 4: Wrap public route declarations**

Use this shape for public routes:

```ts
export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/usage/record",
      operationId: "usage.record",
      summary: "record usage",
      description:
        "Record a raw usage event asynchronously. The event is accepted immediately and processed in the ingestion pipeline.",
      method: "post",
      tags: ["usage"],
      request: {
        body: jsonContentRequired(rawEventSchema, "The usage record payload"),
      },
      responses: {
        [HttpStatusCodes.ACCEPTED]: jsonContent(
          acceptedSchema,
          "The usage event was accepted for asynchronous processing"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["usage", "record"],
      },
      idempotency: {
        required: true,
        location: "body",
        field: "idempotencyKey",
      },
    }
  )
)
```

Apply the same wrapping pattern using the canonical mapping table at the top of this plan. The contract for `apps/api/src/routes/events/ingestEventsSyncV1.ts` must be:

```ts
{
  audience: "public",
  category: "runtime",
  docs: {
    expose: true,
  },
  sdk: {
    path: ["usage", "consume"],
  },
  idempotency: {
    required: true,
    location: "body",
    field: "idempotencyKey",
  },
}
```

The contract for `apps/api/src/routes/runs/applyRunSyncEventV1.ts` must be:

```ts
{
  audience: "public",
  category: "runtime",
  docs: {
    expose: true,
  },
  sdk: {
    path: ["runs", "consume"],
  },
  idempotency: {
    required: true,
    location: "body",
    field: "idempotencyKey",
  },
}
```

The contract for `apps/api/src/routes/analytics/getIngestionStatusV1.ts` must be:

```ts
{
  audience: "public",
  category: "operations",
  docs: {
    expose: true,
  },
  sdk: {
    path: ["ingestionEvents", "status"],
  },
}
```

The contract for `apps/api/src/routes/events/replayIngestionEventsV1.ts` must be:

```ts
{
  audience: "public",
  category: "operations",
  docs: {
    expose: true,
  },
  sdk: {
    path: ["ingestionEvents", "replay"],
  },
}
```

- [ ] **Step 5: Wrap internal and callback route declarations**

Use this shape for internal routes:

```ts
export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/billing-reservations/flush-for-invoicing",
      operationId: "billingReservations.flushForInvoicing",
      summary: "flush wallet reservation usage before invoicing",
      description:
        "Flushes unflushed consumed usage from active wallet reservations into the ledger for invoicing.",
      method: "post",
      tags: ["billingReservations"],
      hide: true,
      request: {
        body: jsonContentRequired(flushReservationsForInvoicingSchema, "Flush reservation request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          flushReservationsForInvoicingResponseSchema,
          "Flush reservation response"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "internal",
      category: "operations",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)
```

Use this shape for provider callback routes:

```ts
export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/payment-provider-callbacks/{provider}/webhook/{projectId}",
      operationId: "paymentProviderCallbacks.webhook",
      summary: "payment provider webhook",
      description: "Receives payment provider webhook callbacks.",
      method: "post",
      tags: ["paymentProviderCallbacks"],
      request: {
        params: providerWebhookParamsSchema,
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(providerWebhookResponseSchema, "Webhook response"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "callback",
      category: "configuration",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)
```

Provider route schemas already vary by file; keep each file's existing request/response schemas and only change `path`, `operationId`, `tags`, and contract metadata.

- [ ] **Step 6: Export the entitlement window status route**

In `apps/api/src/routes/entitlements/getEntitlementWindowStatusV1.ts`, change:

```ts
const route = createRoute({
```

to:

```ts
export const route = createRoute(
  defineEndpointContract(
```

and close the route declaration with:

```ts
    {
      audience: "internal",
      category: "operations",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)
```

Set that route's `path`, `operationId`, `tags`, and `hide` to:

```ts
path: "/v1/internal/entitlement-windows/status",
operationId: "entitlementWindows.status",
tags: ["entitlementWindows"],
hide: true,
```

- [ ] **Step 7: Remove the public `/v1/wallet` route from SDK generation**

In `apps/api/src/routes/wallet/getWalletV1.ts`, keep the existing `route` registered if the API still needs it operationally, but mark it internal:

```ts
export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/wallet/get",
      operationId: "wallet.internalGet",
      summary: "get wallet internals",
      description: "Internal wallet read used for operational inspection.",
      method: "get",
      tags,
      request: existingWalletGetRequest,
      responses: existingWalletGetResponses,
      hide: true,
    },
    {
      audience: "internal",
      category: "money",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)
```

If the current wallet file does not have named `existingWalletGetRequest` and `existingWalletGetResponses` constants, extract the existing `request` and `responses` object literals into those exact constants before wrapping the route. Keep `walletBalanceRoute` public as `wallet.balance` and `walletCreditBalanceRoute` public as `walletCredits.balance`.

- [ ] **Step 8: Run route tests**

Run:

```bash
rtk pnpm --filter api test src/openapi/endpoint-contract.test.ts src/openapi/public-operation-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run API type-check**

Run:

```bash
rtk pnpm --filter api type-check
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
rtk git add apps/api/src/openapi/public-operation-contracts.test.ts apps/api/src/routes
rtk git commit -m "feat: add endpoint contracts to api routes"
```

Expected: commit succeeds.

### Task 4: Generate SDK Resources From OpenAPI Contracts

**Files:**
- Create: `packages/api/src/result.ts`
- Create: `packages/api/src/operation-types.ts`
- Create: `packages/api/scripts/generate-sdk-resources.mjs`
- Modify: `packages/api/package.json`
- Generate: `packages/api/src/generated/sdk-resources.ts`

- [ ] **Step 1: Extract result types**

Create `packages/api/src/result.ts`:

```ts
import type { ApiError } from "./errors"

export type ApiResult<TResult> =
  | {
      result: TResult
      error?: never
    }
  | {
      result?: never
      error: ApiError
    }

export type Result<TResult> = ApiResult<TResult>
```

- [ ] **Step 2: Add operation type helpers**

Create `packages/api/src/operation-types.ts`:

```ts
import type { operations } from "./openapi"
import type { ApiResult } from "./result"

type EmptyObject = Record<string, never>
type SuccessStatus = 200 | 201 | 202 | 204

type JsonContent<TResponse> = TResponse extends {
  content: {
    "application/json": infer TContent
  }
}
  ? TContent
  : never

type JsonRequestBody<TOperation> = TOperation extends {
  requestBody: {
    content: {
      "application/json": infer TBody
    }
  }
}
  ? TBody
  : EmptyObject

type SuccessResponse<TOperation> = TOperation extends {
  responses: infer TResponses
}
  ? {
      [TStatus in keyof TResponses]: TStatus extends SuccessStatus
        ? JsonContent<TResponses[TStatus]>
        : never
    }[keyof TResponses]
  : never

type OperationParameters<TId extends OperationId> = operations[TId] extends {
  parameters: infer TParameters
}
  ? TParameters
  : EmptyObject

type NonNever<TValue> = [TValue] extends [never] ? EmptyObject : TValue

type OperationPathParams<TId extends OperationId> = OperationParameters<TId> extends {
  path: infer TPath
}
  ? NonNever<TPath>
  : EmptyObject

type OperationQueryParams<TId extends OperationId> = OperationParameters<TId> extends {
  query: infer TQuery
}
  ? NonNever<TQuery>
  : EmptyObject

type MergeInput<TValue> = {
  [TKey in keyof TValue]: TValue[TKey]
}

export type OperationId = keyof operations & string

export type OperationInput<TId extends OperationId> = MergeInput<
  OperationPathParams<TId> & OperationQueryParams<TId> & JsonRequestBody<operations[TId]>
>

export type OperationResponse<TId extends OperationId> = NonNever<SuccessResponse<operations[TId]>>

export type OperationRequester = <TId extends OperationId>(
  operationId: TId,
  input: OperationInput<TId> | undefined
) => Promise<ApiResult<OperationResponse<TId>>>
```

- [ ] **Step 3: Add the generator script**

Create `packages/api/scripts/generate-sdk-resources.mjs`:

```js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const METHODS = ["get", "post", "put", "patch", "delete"]

const [, , openApiPathArg, outputPathArg] = process.argv

if (!openApiPathArg || !outputPathArg) {
  console.error(
    "usage: node scripts/generate-sdk-resources.mjs <openapi.json> <output.ts>"
  )
  process.exit(1)
}

const openApiPath = resolve(process.cwd(), openApiPathArg)
const outputPath = resolve(process.cwd(), outputPathArg)
const document = JSON.parse(readFileSync(openApiPath, "utf8"))

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }

  return value
}

function getPathParams(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
}

function getOperationParameters(pathItem, operation) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].filter(
    (parameter) => typeof parameter === "object" && parameter !== null && !("$ref" in parameter)
  )
}

function hasQueryParams(pathItem, operation) {
  return getOperationParameters(pathItem, operation).some((parameter) => parameter.in === "query")
}

function getSdkPath(operationId, operation) {
  const contract = operation["x-unprice"]

  if (!contract || contract.audience !== "public") {
    return null
  }

  if (contract.sdk === false) {
    return null
  }

  if (!contract.sdk || typeof contract.sdk !== "object") {
    throw new Error(`public operation ${operationId} must define x-unprice.sdk or x-unprice.sdk=false`)
  }

  const path = contract.sdk.path

  if (!Array.isArray(path) || path.length === 0) {
    throw new Error(`public operation ${operationId} must define x-unprice.sdk.path`)
  }

  const joinedPath = path.join(".")

  if (joinedPath !== operationId) {
    throw new Error(`public operation ${operationId} has mismatched sdk path ${joinedPath}`)
  }

  for (const part of path) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(part)) {
      throw new Error(`public operation ${operationId} has non-identifier sdk path part ${part}`)
    }
  }

  return path
}

function collectOperations(openApiDocument) {
  const paths = assertRecord(openApiDocument.paths, "openapi.paths")
  const operations = []

  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = assertRecord(pathItemValue, `path item ${path}`)

    for (const method of METHODS) {
      const operationValue = pathItem[method]

      if (!operationValue) {
        continue
      }

      const operation = assertRecord(operationValue, `${method.toUpperCase()} ${path}`)
      const operationId = operation.operationId

      if (typeof operationId !== "string") {
        throw new Error(`${method.toUpperCase()} ${path} is missing operationId`)
      }

      const sdkPath = getSdkPath(operationId, operation)

      if (!sdkPath) {
        continue
      }

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        sdkPath,
        pathParams: getPathParams(path),
        hasInput:
          getPathParams(path).length > 0 ||
          hasQueryParams(pathItem, operation) ||
          Boolean(operation.requestBody),
      })
    }
  }

  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId))
}

function insertOperation(tree, operation) {
  let cursor = tree

  for (const part of operation.sdkPath.slice(0, -1)) {
    cursor.children ??= new Map()

    if (!cursor.children.has(part)) {
      cursor.children.set(part, {})
    }

    cursor = cursor.children.get(part)
  }

  const leafName = operation.sdkPath.at(-1)

  cursor.children ??= new Map()

  if (cursor.children.has(leafName)) {
    throw new Error(`duplicate sdk path ${operation.sdkPath.join(".")}`)
  }

  cursor.children.set(leafName, { operation })
}

function renderTypeNode(node, indent = "  ") {
  const children = [...(node.children ?? new Map()).entries()]

  return [
    "{",
    ...children.map(([name, child]) => {
      if (child.operation) {
        const id = child.operation.operationId
        const argument = child.operation.hasInput ? `req: OperationInput<"${id}">` : ""

        return `${indent}${name}: (${argument}) => Promise<ApiResult<OperationResponse<"${id}">>>`
      }

      return `${indent}${name}: ${renderTypeNode(child, `${indent}  `)}`
    }),
    `${indent.slice(2)}}`,
  ].join("\n")
}

function renderValueNode(node, indent = "  ") {
  const children = [...(node.children ?? new Map()).entries()]

  return [
    "{",
    ...children.map(([name, child]) => {
      if (child.operation) {
        const id = child.operation.operationId
        const implementation = child.operation.hasInput
          ? `(req) => requester("${id}", req)`
          : `() => requester("${id}", undefined)`

        return `${indent}${name}: ${implementation},`
      }

      return `${indent}${name}: ${renderValueNode(child, `${indent}  `)},`
    }),
    `${indent.slice(2)}}`,
  ].join("\n")
}

const operations = collectOperations(document)
const root = {}

for (const operation of operations) {
  insertOperation(root, operation)
}

const operationsSource = operations
  .map((operation) => {
    const pathParams = operation.pathParams.map((param) => `"${param}"`).join(", ")

    return `  "${operation.operationId}": {
    method: "${operation.method}",
    path: "${operation.path}",
    pathParams: [${pathParams}],
  },`
  })
  .join("\n")

const source = `/* eslint-disable */
/* This file is generated by packages/api/scripts/generate-sdk-resources.mjs. */

import type { OperationInput, OperationRequester, OperationResponse } from "../operation-types"
import type { ApiResult } from "../result"

export const sdkOperations = {
${operationsSource}
} as const

export type SdkOperationId = keyof typeof sdkOperations

export type GeneratedSdkResources = ${renderTypeNode(root)}

export function createGeneratedSdkResources(
  requester: OperationRequester
): GeneratedSdkResources {
  return ${renderValueNode(root)}
}
`

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, source)
console.log(`generated ${operations.length} SDK operations at ${outputPath}`)
```

- [ ] **Step 4: Update package scripts**

Modify `packages/api/package.json` scripts to:

```json
{
  "clean": "rm -rf .turbo node_modules dist",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "generate:openapi": "curl -fsS http://localhost:8787/openapi.json -o ../../apps/docs/openapi.json",
  "generate:types": "openapi-typescript ../../apps/docs/openapi.json -o ./src/openapi.d.ts",
  "generate:resources": "node ./scripts/generate-sdk-resources.mjs ../../apps/docs/openapi.json ./src/generated/sdk-resources.ts",
  "generate": "pnpm generate:openapi && pnpm generate:types && pnpm generate:resources",
  "build:generate": "rm -rf dist && pnpm generate && tsup",
  "build": "rm -rf dist && tsup",
  "dev": "tsup --watch"
}
```

Keep the rest of `package.json` unchanged.

- [ ] **Step 5: Run the generator and verify it initially fails without the API server**

Run:

```bash
rtk pnpm --filter @unprice/api generate
```

Expected: FAIL with a curl connection error if the API dev server is not running.

- [ ] **Step 6: Start the API server in a separate terminal**

Run in a separate terminal and leave it running:

```bash
rtk pnpm --filter api dev
```

Expected: Wrangler dev server prints a local URL on port `8787`.

- [ ] **Step 7: Generate OpenAPI types and SDK resources**

Run:

```bash
rtk pnpm --filter @unprice/api generate
```

Expected:

```text
generated 24 SDK operations at ...
```

Expected file changes:

```text
apps/docs/openapi.json
packages/api/src/openapi.d.ts
packages/api/src/generated/sdk-resources.ts
```

- [ ] **Step 8: Commit**

```bash
rtk git add packages/api/src/result.ts packages/api/src/operation-types.ts packages/api/scripts/generate-sdk-resources.mjs packages/api/package.json packages/api/src/generated/sdk-resources.ts packages/api/src/openapi.d.ts apps/docs/openapi.json
rtk git commit -m "feat: generate sdk resources from openapi contracts"
```

Expected: commit succeeds.

### Task 5: Replace Manual SDK Endpoint Wrappers

**Files:**
- Modify: `packages/api/src/client.ts`
- Modify: `packages/api/src/errors.ts`
- Modify: `packages/api/src/client.test.ts`

- [ ] **Step 1: Simplify error types**

Replace `packages/api/src/errors.ts` with:

```ts
import type { components } from "./openapi"

type OpenApiErrorResponse =
  | components["schemas"]["ErrBadRequest"]
  | components["schemas"]["ErrUnauthorized"]
  | components["schemas"]["ErrForbidden"]
  | components["schemas"]["ErrNotFound"]
  | components["schemas"]["ErrConflict"]
  | components["schemas"]["ErrPreconditionFailed"]
  | components["schemas"]["ErrTooManyRequests"]
  | components["schemas"]["ErrInternalServerError"]

export type ErrorResponse = OpenApiErrorResponse

export type ApiError =
  | OpenApiErrorResponse["error"]
  | {
      code: "FETCH_ERROR"
      message: string
      docs: string
      requestId: string
    }
```

- [ ] **Step 2: Update client imports and class fields**

In `packages/api/src/client.ts`, replace the current imports with:

```ts
import createOpenApiClient, { type Client as OpenApiClient } from "openapi-fetch"
import { version } from "../package.json"
import type { ApiError, ErrorResponse } from "./errors"
import type { OperationInput, OperationRequester, OperationResponse } from "./operation-types"
import type { paths } from "./openapi"
import type { ApiResult, Result } from "./result"
import {
  createGeneratedSdkResources,
  type GeneratedSdkResources,
  sdkOperations,
  type SdkOperationId,
} from "./generated/sdk-resources"
import type { Telemetry } from "./telemetry"
import { getTelemetry } from "./telemetry"

export type { ApiResult, Result }
```

Add these fields inside `export class Unprice`:

```ts
  public readonly access: GeneratedSdkResources["access"]
  public readonly usage: GeneratedSdkResources["usage"]
  public readonly runs: GeneratedSdkResources["runs"]
  public readonly customers: GeneratedSdkResources["customers"]
  public readonly features: GeneratedSdkResources["features"]
  public readonly planVersions: GeneratedSdkResources["planVersions"]
  public readonly subscriptions: GeneratedSdkResources["subscriptions"]
  public readonly paymentMethods: GeneratedSdkResources["paymentMethods"]
  public readonly wallet: GeneratedSdkResources["wallet"]
  public readonly walletCredits: GeneratedSdkResources["walletCredits"]
  public readonly invoices: GeneratedSdkResources["invoices"]
  public readonly analytics: GeneratedSdkResources["analytics"]
  public readonly ingestionEvents: GeneratedSdkResources["ingestionEvents"]
```

- [ ] **Step 3: Assign generated resources in the constructor**

At the end of the `Unprice` constructor, after `this.openapi = createOpenApiClient<paths>(...)`, add:

```ts
    const resources = createGeneratedSdkResources(this.requestOperation)

    this.access = resources.access
    this.usage = resources.usage
    this.runs = resources.runs
    this.customers = resources.customers
    this.features = resources.features
    this.planVersions = resources.planVersions
    this.subscriptions = resources.subscriptions
    this.paymentMethods = resources.paymentMethods
    this.wallet = resources.wallet
    this.walletCredits = resources.walletCredits
    this.invoices = resources.invoices
    this.analytics = resources.analytics
    this.ingestionEvents = resources.ingestionEvents
```

- [ ] **Step 4: Add the generic operation caller**

Keep `isRecord`, `toResult`, retry handling, telemetry, and error mapping. Delete the old `PostBody`, `PostResponse`, `GetResponse`, `GetQuery`, `GetPath`, `WithOptionalFields`, and manual resource getters. Add these methods before the end of the class:

```ts
  private splitInputForOperation(
    operation: (typeof sdkOperations)[SdkOperationId],
    input: unknown
  ): {
    path: Record<string, unknown>
    rest: Record<string, unknown>
  } {
    const source = isRecord(input) ? input : {}
    const pathParamNames = new Set<string>(operation.pathParams)
    const path: Record<string, unknown> = {}
    const rest: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(source)) {
      if (pathParamNames.has(key)) {
        path[key] = value
      } else {
        rest[key] = value
      }
    }

    return { path, rest }
  }

  private requestOperation = <TId extends SdkOperationId>(
    operationId: TId,
    input: OperationInput<TId> | undefined
  ): Promise<ApiResult<OperationResponse<TId>>> => {
    const operation = sdkOperations[operationId]
    const { path, rest } = this.splitInputForOperation(operation, input)
    const pathParams = Object.keys(path).length > 0 ? path : undefined
    const restParams = Object.keys(rest).length > 0 ? rest : undefined

    if (operation.method === "GET") {
      return this.toResult(
        this.openapi.GET(operation.path as never, {
          params: {
            ...(pathParams ? { path: pathParams } : {}),
            ...(restParams ? { query: restParams } : {}),
          },
        } as never) as never
      )
    }

    if (operation.method === "POST") {
      return this.toResult(
        this.openapi.POST(operation.path as never, {
          params: pathParams
            ? {
                path: pathParams,
              }
            : undefined,
          body: restParams,
        } as never) as never
      )
    }

    return this.toResult(
      Promise.resolve({
        error: {
          error: {
            code: "FETCH_ERROR",
            message: `Unsupported SDK operation method ${operation.method}`,
            docs: "https://docs.unprice.dev/api-reference/errors",
            requestId: "N/A",
          },
        },
        response: new Response(null, { status: 500 }),
      })
    )
  }
```

The unsupported-method branch should be unreachable because the generator currently emits public `GET` and `POST` operations only. Keeping the branch makes the switch total without throwing outside `ApiResult`.

- [ ] **Step 5: Write SDK surface tests**

Update the `"exposes generated resource clients for every SDK-exposed public API route"` test in `packages/api/src/client.test.ts` to:

```ts
  it("exposes generated resource clients for every SDK-exposed public API route", () => {
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
    })

    expect(typeof client.access.update).toBe("function")
    expect(typeof client.access.check).toBe("function")
    expect(typeof client.access.entitlements.list).toBe("function")
    expect(typeof client.usage.record).toBe("function")
    expect(typeof client.usage.consume).toBe("function")
    expect(typeof client.runs.start).toBe("function")
    expect(typeof client.runs.consume).toBe("function")
    expect(typeof client.runs.end).toBe("function")
    expect(typeof client.runs.get).toBe("function")
    expect(typeof client.customers.signUp).toBe("function")
    expect(typeof client.features.list).toBe("function")
    expect(typeof client.planVersions.get).toBe("function")
    expect(typeof client.planVersions.list).toBe("function")
    expect(typeof client.paymentMethods.create).toBe("function")
    expect(typeof client.paymentMethods.list).toBe("function")
    expect(typeof client.analytics.charges.explain).toBe("function")
    expect(typeof client.analytics.usage.forecast).toBe("function")
    expect(typeof client.analytics.usage.get).toBe("function")
    expect(typeof client.ingestionEvents.status).toBe("function")
    expect(typeof client.ingestionEvents.replay).toBe("function")
    expect(typeof client.subscriptions.get).toBe("function")
    expect(typeof client.wallet.balance).toBe("function")
    expect(typeof client.walletCredits.balance).toBe("function")
    expect(typeof client.invoices.get).toBe("function")
    expect("entitlements" in client).toBe(false)
    expect("events" in client).toBe(false)
    expect("plans" in client).toBe(false)
    expect("payments" in client).toBe(false)
    expect("billing" in client).toBe(false)
    expect("agents" in client).toBe(false)
    expect("usage" in client.analytics).toBe(true)
  })
```

Update the sync ingestion request test to call the new operation:

```ts
    const { result, error } = await client.usage.consume({
      idempotencyKey: "idem_123",
      eventSlug: "tokens",
      featureSlug: "tokens",
      customerId: "cus_123",
      properties: {},
    })

    expect(error).toBeUndefined()
    expect(result?.allowed).toBe(true)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("https://example.com/v1/usage/consume")
    await expect(requests[0]?.json()).resolves.toMatchObject({
      customerId: "cus_123",
      eventSlug: "tokens",
      featureSlug: "tokens",
    })
```

Update the async ingestion retry test to call:

```ts
    const { result, error } = await client.usage.record({
      idempotencyKey: "idem_123",
      eventSlug: "tokens",
      customerId: "cus_123",
      properties: {},
    })
```

Update the replay test to call:

```ts
    const { result, error } = await client.ingestionEvents.replay({
      canonical_audit_ids: ["audit_1"],
      project_id: "proj_123",
    })
```

and expect:

```ts
    expect(requests[0]?.url).toBe("https://example.com/v1/ingestion-events/replay")
```

Update the wallet credit test to call:

```ts
    const { result, error } = await client.walletCredits.balance({
      customerId: "cus_123",
      projectId: "prj_123",
      walletId: "wcr_123",
    })
```

and expect:

```ts
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.com/v1/wallet/balance?customerId=cus_123&projectId=prj_123",
      "https://example.com/v1/wallet-credits/balance/wcr_123?customerId=cus_123&projectId=prj_123",
    ])
```

Delete the `"posts invoicing reservation flush requests"` test because internal operations no longer generate SDK resources.

- [ ] **Step 6: Run SDK tests and verify the expected failures**

Run:

```bash
rtk pnpm --filter @unprice/api test src/client.test.ts
```

Expected before finishing client edits: FAIL on missing generated resource fields. Expected after client edits: PASS.

- [ ] **Step 7: Run SDK type-check**

Run:

```bash
rtk pnpm --filter @unprice/api typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add packages/api/src/client.ts packages/api/src/errors.ts packages/api/src/client.test.ts
rtk git commit -m "feat: use generated api sdk resources"
```

Expected: commit succeeds.

### Task 6: Add OpenAPI And SDK Drift Gates

**Files:**
- Create: `packages/api/src/openapi-contract.test.ts`

- [ ] **Step 1: Write the drift test**

Create `packages/api/src/openapi-contract.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { sdkOperations } from "./generated/sdk-resources"

type OpenApiOperation = {
  operationId?: string
  "x-unprice"?: {
    audience?: string
    sdk?: false | {
      path?: string[]
    }
  }
}

type OpenApiPathItem = Record<string, unknown>

const METHODS = ["get", "post", "put", "patch", "delete"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readOpenApiDocument(): { paths: Record<string, OpenApiPathItem> } {
  const openApiPath = resolve(__dirname, "../../../apps/docs/openapi.json")
  const parsed = JSON.parse(readFileSync(openApiPath, "utf8")) as unknown

  if (!isRecord(parsed) || !isRecord(parsed.paths)) {
    throw new Error("apps/docs/openapi.json must contain a paths object")
  }

  return {
    paths: parsed.paths as Record<string, OpenApiPathItem>,
  }
}

function getSdkOperationIds(): string[] {
  const document = readOpenApiDocument()
  const operationIds: string[] = []

  for (const pathItem of Object.values(document.paths)) {
    for (const method of METHODS) {
      const operation = pathItem[method] as OpenApiOperation | undefined

      if (!operation?.operationId) {
        continue
      }

      if (operation["x-unprice"]?.audience === "public" && operation["x-unprice"]?.sdk !== false) {
        operationIds.push(operation.operationId)
      }
    }
  }

  return operationIds.sort()
}

describe("OpenAPI SDK contract", () => {
  it("generates one SDK operation for every SDK-exposed public OpenAPI operation", () => {
    expect(Object.keys(sdkOperations).sort()).toEqual(getSdkOperationIds())
  })

  it("does not contain stale removed operation ids", () => {
    const allIds = getSdkOperationIds()

    expect(allIds).not.toContain("realtime.createTicket")
    expect(allIds.some((operationId) => operationId.startsWith("agents."))).toBe(false)
    expect(allIds).not.toContain("events.ingest")
    expect(allIds).not.toContain("events.ingestSync")
    expect(allIds).not.toContain("entitlements.verify")
    expect(allIds).not.toContain("plans.getVersion")
    expect(allIds).not.toContain("payments.methods.create")
    expect(allIds).not.toContain("billing.reservations.flushForInvoicing")
    expect(allIds).not.toContain("wallet.internalGet")
    expect(allIds.some((operationId) => operationId.startsWith("paymentProviderCallbacks."))).toBe(
      false
    )
  })
})
```

- [ ] **Step 2: Run the drift test**

Run:

```bash
rtk pnpm --filter @unprice/api test src/openapi-contract.test.ts
```

Expected: PASS after `packages/api/src/generated/sdk-resources.ts` and `apps/docs/openapi.json` are generated from the migrated API.

- [ ] **Step 3: Run all SDK tests**

Run:

```bash
rtk pnpm --filter @unprice/api test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
rtk git add packages/api/src/openapi-contract.test.ts
rtk git commit -m "test: prevent openapi sdk drift"
```

Expected: commit succeeds.

### Task 7: Update Docs And Tooling SDK Call Sites

**Files:**
- Modify: `apps/docs/concepts/pricing/entitlements.mdx`
- Modify: `apps/docs/concepts/pricing/usage-metering.mdx`
- Modify: `apps/docs/quickstart/onboarding-plan.mdx`
- Modify: `apps/docs/quickstart/onboarding-entitlements.mdx`
- Modify: `apps/docs/libraries/ts/sdk/events/ingest-sync.mdx`
- Modify: `apps/docs/libraries/ts/sdk/events/ingest.mdx`
- Modify: `apps/docs/libraries/ts/sdk/entitlements/verify.mdx`
- Modify: `apps/docs/libraries/ts/sdk/entitlements/get.mdx`
- Modify: `apps/docs/libraries/ts/sdk/plans/get-version.mdx`
- Modify: `apps/docs/libraries/ts/sdk/plans/list-versions.mdx`
- Modify: `apps/docs/libraries/ts/sdk/payments/list-methods.mdx`
- Modify: `apps/docs/libraries/ts/sdk/payments/create-method.mdx`
- Modify: `apps/docs/libraries/ts/sdk/wallet/get.mdx`
- Modify: `apps/docs/libraries/ts/sdk/usage/get.mdx`
- Create: `apps/docs/libraries/ts/sdk/ingestion-events/status.mdx`
- Create: `apps/docs/libraries/ts/sdk/ingestion-events/replay.mdx`
- Modify: `apps/docs/libraries/ts/sdk/overview.mdx`
- Modify: `tooling/tiny-tools/main.ts`
- Modify: `tooling/tiny-tools/plan-signup.ts`
- Modify: `tooling/tiny-tools/plan-usage.ts`
- Modify: `tooling/tiny-tools/plan-wallet.ts`

- [ ] **Step 1: Apply SDK call replacements**

Use this exact replacement matrix:

| Old call | New call |
|---|---|
| `unprice.entitlements.verify(` | `unprice.access.check(` |
| `unprice.entitlements.get(` | `unprice.access.entitlements.list(` |
| `unprice.events.ingestSync(` | `unprice.usage.consume(` |
| `unprice.events.ingest(` | `unprice.usage.record(` |
| `unprice.plans.getVersion(` | `unprice.planVersions.get(` |
| `unprice.plans.listVersions(` | `unprice.planVersions.list(` |
| `unprice.payments.methods.list(` | `unprice.paymentMethods.list(` |
| `unprice.payments.methods.create(` | `unprice.paymentMethods.create(` |
| `unprice.wallet.creditBalance(` | `unprice.walletCredits.balance(` |
| `unprice.wallet.get(` | `unprice.wallet.balance(` |
| `unprice.usage.get(` | `unprice.analytics.usage.get(` |
| `unprice.analytics.explainCharge(` | `unprice.analytics.charges.explain(` |
| `unprice.analytics.forecastUsage(` | `unprice.analytics.usage.forecast(` |
| `unprice.analytics.ingestion.status(` | `unprice.ingestionEvents.status(` |
| `unprice.replayFailedIngestionEvents(` | `unprice.ingestionEvents.replay(` |
| `unprice.events.replayFailedIngestionEvents(` | `unprice.ingestionEvents.replay(` |

- [ ] **Step 2: Rename SDK docs directories**

Rename docs files so the navigation matches product language:

```bash
rtk mkdir -p apps/docs/libraries/ts/sdk/usage apps/docs/libraries/ts/sdk/access apps/docs/libraries/ts/sdk/plan-versions apps/docs/libraries/ts/sdk/payment-methods apps/docs/libraries/ts/sdk/ingestion-events
rtk git mv apps/docs/libraries/ts/sdk/events/ingest.mdx apps/docs/libraries/ts/sdk/usage/record.mdx
rtk git mv apps/docs/libraries/ts/sdk/events/ingest-sync.mdx apps/docs/libraries/ts/sdk/usage/consume.mdx
rtk git mv apps/docs/libraries/ts/sdk/entitlements/verify.mdx apps/docs/libraries/ts/sdk/access/check.mdx
rtk git mv apps/docs/libraries/ts/sdk/entitlements/get.mdx apps/docs/libraries/ts/sdk/access/list-entitlements.mdx
rtk git mv apps/docs/libraries/ts/sdk/plans/get-version.mdx apps/docs/libraries/ts/sdk/plan-versions/get.mdx
rtk git mv apps/docs/libraries/ts/sdk/plans/list-versions.mdx apps/docs/libraries/ts/sdk/plan-versions/list.mdx
rtk git mv apps/docs/libraries/ts/sdk/payments/list-methods.mdx apps/docs/libraries/ts/sdk/payment-methods/list.mdx
rtk git mv apps/docs/libraries/ts/sdk/payments/create-method.mdx apps/docs/libraries/ts/sdk/payment-methods/create.mdx
```

Expected: git records renames. If a destination file already exists, inspect it and merge content before running the `git mv` for that file.

- [ ] **Step 3: Create ingestion-events SDK docs**

Create `apps/docs/libraries/ts/sdk/ingestion-events/status.mdx`:

````mdx
---
title: Ingestion event status
description: Inspect recent ingestion events and failures.
---

```ts
const { result, error } = await unprice.ingestionEvents.status({
  project_id: "proj_123",
  limit: 50,
})

if (error) {
  throw new Error(error.message)
}

console.log(result)
```
````

Create `apps/docs/libraries/ts/sdk/ingestion-events/replay.mdx`:

````mdx
---
title: Replay ingestion events
description: Replay failed ingestion events by canonical audit id.
---

```ts
const { result, error } = await unprice.ingestionEvents.replay({
  project_id: "proj_123",
  canonical_audit_ids: ["audit_123"],
})

if (error) {
  throw new Error(error.message)
}

console.log(result)
```
````

- [ ] **Step 4: Update docs navigation**

Open `apps/docs/docs.json` and replace the old SDK navigation entries for events, entitlements, plans, and payments with this shape:

```json
{
  "group": "TypeScript SDK",
  "pages": [
    "libraries/ts/sdk/overview",
    "libraries/ts/sdk/usage/record",
    "libraries/ts/sdk/usage/consume",
    "libraries/ts/sdk/access/check",
    "libraries/ts/sdk/access/list-entitlements",
    "libraries/ts/sdk/plan-versions/list",
    "libraries/ts/sdk/plan-versions/get",
    "libraries/ts/sdk/payment-methods/list",
    "libraries/ts/sdk/payment-methods/create",
    "libraries/ts/sdk/ingestion-events/status",
    "libraries/ts/sdk/ingestion-events/replay",
    "libraries/ts/sdk/wallet/get",
    "libraries/ts/sdk/usage/get"
  ]
}
```

Preserve unrelated docs groups and ordering around the SDK group.

- [ ] **Step 5: Check for stale SDK names**

Run:

```bash
rtk rg "unprice\\.(entitlements|events|plans|payments|billing|agents|replayFailedIngestionEvents)|unprice\\.usage\\.get" apps/docs tooling packages/api/src -n
```

Expected: no matches.

- [ ] **Step 6: Run package type-checks**

Run:

```bash
rtk pnpm --filter @unprice/api typecheck
rtk pnpm --filter @unprice/tiny-tools typecheck
```

Expected: PASS. If `@unprice/tiny-tools` has no `typecheck` script, run:

```bash
rtk pnpm --filter @unprice/tiny-tools build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/docs tooling/tiny-tools
rtk git commit -m "docs: update sdk examples to product operations"
```

Expected: commit succeeds.

### Task 8: Regenerate And Verify The Full Contract

**Files:**
- Modify: `apps/docs/openapi.json`
- Modify: `packages/api/src/openapi.d.ts`
- Modify: `packages/api/src/generated/sdk-resources.ts`

- [ ] **Step 1: Regenerate the API SDK artifacts**

With the API dev server still running on `localhost:8787`, run:

```bash
rtk pnpm --filter @unprice/api generate
```

Expected:

```text
generated 24 SDK operations at ...
```

- [ ] **Step 2: Verify generated OpenAPI no longer has stale operations**

Run:

```bash
rtk rg "realtime\\.createTicket|agents\\.|events\\.ingest|events\\.ingestSync|entitlements\\.verify|plans\\.getVersion|payments\\.methods|payments\\.providers|billing\\.reservations\\.flushForInvoicing|runs\\.events\\.sync|wallet\\.get|wallet\\.creditBalance|analytics\\.explainCharge|analytics\\.forecastUsage|analytics\\.ingestion\\.status" apps/docs/openapi.json packages/api/src/openapi.d.ts packages/api/src/generated/sdk-resources.ts -n
```

Expected: no matches.

- [ ] **Step 3: Verify expected new operations exist**

Run:

```bash
rtk rg "usage\\.record|usage\\.consume|access\\.check|access\\.entitlements\\.list|planVersions\\.get|paymentMethods\\.create|walletCredits\\.balance|ingestionEvents\\.status|ingestionEvents\\.replay|runs\\.consume" apps/docs/openapi.json packages/api/src/openapi.d.ts packages/api/src/generated/sdk-resources.ts -n
```

Expected: matches in generated OpenAPI JSON, generated OpenAPI TypeScript, and generated SDK resources.

- [ ] **Step 4: Run focused tests**

Run:

```bash
rtk pnpm --filter api test src/openapi/endpoint-contract.test.ts src/openapi/public-operation-contracts.test.ts
rtk pnpm --filter @unprice/api test
```

Expected: PASS.

- [ ] **Step 5: Run focused type-checks**

Run:

```bash
rtk pnpm --filter api type-check
rtk pnpm --filter @unprice/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit generated artifacts**

```bash
rtk git add apps/docs/openapi.json packages/api/src/openapi.d.ts packages/api/src/generated/sdk-resources.ts
rtk git commit -m "chore: regenerate api sdk contracts"
```

Expected: commit succeeds.

### Task 9: Update Durable Repo Memory

**Files:**
- Modify: `lessons.md`

- [ ] **Step 1: Add API SDK contract lessons**

In `lessons.md`, under `## API SDK And Public Contracts`, add:

```markdown
- 2026-06-20: Public Hono routes must use `defineEndpointContract`; for `audience: "public"`,
  SDK-exposed operations must set `sdk.path` and `operationId` must equal
  `sdk.path.join(".")` so OpenAPI, docs, and `@unprice/api` resources generate from one
  product operation. Public routes that should not generate SDK methods must set `sdk: false`.
- 2026-06-20: Internal and provider-callback API routes must set `audience: "internal"` or
  `audience: "callback"` plus `sdk: false` and must not be exposed through generated SDK
  resources.
- 2026-06-20: Run `pnpm --filter @unprice/api generate` with the API dev server running before
  SDK contract work is complete; it updates `apps/docs/openapi.json`, `packages/api/src/openapi.d.ts`,
  and `packages/api/src/generated/sdk-resources.ts` together.
```

- [ ] **Step 2: Check formatting**

Run:

```bash
rtk pnpm biome check --no-errors-on-unmatched lessons.md
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
rtk git add lessons.md
rtk git commit -m "docs: record api sdk contract lessons"
```

Expected: commit succeeds.

### Task 10: Final Verification

**Files:**
- Inspect only unless verification changes generated artifacts.

- [ ] **Step 1: Run the full validation command**

Run:

```bash
rtk pnpm validate
```

Expected: PASS. If `pnpm validate` writes formatting changes, inspect the diff and commit only relevant formatting changes.

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
rtk git status --short
rtk git diff --stat
```

Expected: no unexpected files outside this plan. Existing unrelated user changes should remain untouched.

- [ ] **Step 3: Run the final stale-name scan**

Run:

```bash
rtk rg "unprice\\.(entitlements|events|plans|payments|billing|agents|replayFailedIngestionEvents)|realtime\\.createTicket|events\\.ingest|events\\.ingestSync|entitlements\\.verify|plans\\.getVersion|payments\\.methods|payments\\.providers|billing\\.reservations\\.flushForInvoicing|runs\\.events\\.sync|wallet\\.get|wallet\\.creditBalance|analytics\\.explainCharge|analytics\\.forecastUsage|analytics\\.ingestion\\.status" apps packages tooling -n
```

Expected: no matches, except historical text in old gitignored plan files if the command is expanded beyond `apps packages tooling`.

- [ ] **Step 4: Commit final verification changes**

If verification changed files, run:

```bash
rtk git add apps/api packages/api apps/docs tooling/tiny-tools lessons.md docs/adr/ADR-0003-api-operation-contracts-and-sdk-surface.md
rtk git commit -m "chore: finalize api sdk dx foundation"
```

Expected: commit succeeds only when there are staged changes. If no files changed during verification, skip this commit.

## Self-Review

**Spec coverage:** This plan covers the requested deeper first-principles SDK/API foundation by adding a contract system, endpoint audience taxonomy, route renames, generated SDK resources, docs/OpenAPI synchronization, stale operation drift gates, tooling call-site migration, and durable lessons. It keeps `packages/react` out of scope.

**Placeholder scan:** The plan avoids open-ended implementation steps. Route migration uses a complete canonical operation mapping, exact contract shapes, exact replacement matrix, and exact verification commands.

**Type consistency:** Public operation names in the route mapping, generated SDK namespaces, tests, docs replacements, and stale-name scans use the same canonical names: `usage.record`, `usage.consume`, `access.check`, `access.entitlements.list`, `planVersions.*`, `paymentMethods.*`, `walletCredits.balance`, `analytics.charges.explain`, `analytics.usage.forecast`, and `ingestionEvents.*`.
