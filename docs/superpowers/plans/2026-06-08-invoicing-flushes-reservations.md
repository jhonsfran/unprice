# Invoicing Flushes Reservations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before BILL creates an invoice, flush invoice-relevant wallet reservation usage into the ledger without exposing Cloudflare Durable Objects to `internal/services`.

**Architecture:** `billPeriod` depends on a small service-layer port, `BillingReservationFlushGateway`. The production implementation calls an authenticated API endpoint through the `@unprice/api` SDK; the API Worker endpoint owns the Cloudflare Durable Object lookup and calls the DO flush RPC.

**Tech Stack:** TypeScript, Vitest, Hono OpenAPI, `@unprice/api` SDK, Cloudflare Durable Objects, pgledger.

---

## File Structure

- Modify `apps/api/src/ingestion/entitlements/contracts.ts`: define DO-level flush input/result.
- Modify `internal/services/src/ingestion/entitlement-window-applier.ts`: expose `flushReservationForInvoicing` only as a DO controller capability.
- Modify `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`: add the non-final flush RPC.
- Create `apps/api/src/routes/billing/flushReservationsForInvoicingV1.ts`: authenticated API endpoint that resolves matching entitlement windows and calls the DO RPC.
- Modify `packages/api/src/client.ts`: add SDK method for the endpoint.
- Create `internal/services/src/use-cases/billing/reservation-flush-gateway.ts`: service-layer port plus SDK-backed implementation.
- Modify `internal/services/src/use-cases/billing/bill-period.ts`: call the gateway before invoice materialization.
- Modify subscription wiring (`deps.ts`, `context.ts`, `subscriptions/service.ts`, `subscriptions/machine.ts`): pass the gateway, not a DO client.

## Boundary Rule

- `internal/services` must not import `CloudflareEntitlementWindowClient`, DO types, Worker env, or `apps/api`.
- The only thing `billPeriod` knows is: “flush reservations for this statement.”
- The API endpoint is the infrastructure adapter. It can import the Cloudflare DO client because it runs in the Worker.
- Vercel callers use the same SDK method and therefore do not need a Durable Object binding.

### Task 1: Add The DO Non-Final Flush RPC

**Files:**
- Modify: `apps/api/src/ingestion/entitlements/contracts.ts`
- Modify: `internal/services/src/ingestion/entitlement-window-applier.ts`
- Modify: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`
- Test: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`

- [ ] **Step 1: Write the failing DO test**

Add a test beside the wallet reservation flush tests:

```ts
it("flushes a matching reservation for invoicing without closing it", async () => {
  const EntitlementWindowDO = await loadEntitlementWindowDO()
  const state = createDurableObjectState()
  const db = createFakeDbState()
  testState.db = db

  db.meterWindowRows.set(DEFAULT_METER_KEY, {
    meterKey: DEFAULT_METER_KEY,
    currency: "USD",
    priceConfig: DEFAULT_PRICE_CONFIG,
    periodEndAt: BASE_NOW + 60_000,
    reservationEndAt: BASE_NOW + 60_000,
    usage: 6,
    updatedAt: BASE_NOW,
    createdAt: BASE_NOW,
    projectId: "proj_123",
    customerId: "cus_123",
    billingPeriodId: "bp_123",
    cycleEndAt: BASE_NOW + 60_000,
    cycleStartAt: BASE_NOW - 60_000,
    featurePlanVersionItemId: "item_123",
    featureSlug: "api_calls",
    statementKey: "stmt_123",
    reservationId: "res_invoice",
    allocationAmount: 10 * 100_000_000,
    consumedAmount: 5 * 100_000_000,
    flushedAmount: 2 * 100_000_000,
    consumedQuantity: 5,
    flushedQuantity: 2,
    refillThresholdBps: 2000,
    refillChunkAmount: 0,
    targetReservationAmount: 10 * 100_000_000,
    spendEwmaAmount: 0,
    lastRateSampledAtMs: null,
    maxEventCostAmount: 100_000_000,
    pendingRefillAmount: 0,
    pendingFlushAmount: null,
    pendingFlushQuantity: null,
    refillInFlight: false,
    flushSeq: 2,
    pendingFlushSeq: null,
    pendingFlushFinal: false,
    lastEventAt: BASE_NOW,
    lastFlushedAt: BASE_NOW - 30_000,
    deletionRequested: false,
    recoveryRequired: false,
  })

  const durableObject = new EntitlementWindowDO(state, createEnv())
  const result = await durableObject.flushReservationForInvoicing({
    statementKey: "stmt_123",
    billingPeriodIds: ["bp_123"],
  })

  expect(result).toMatchObject({ ok: true, outcome: "flushed" })
  expect(testState.flushReservation).toHaveBeenCalledWith(
    expect.objectContaining({
      reservationId: "res_invoice",
      flushSeq: 3,
      flushAmount: 3 * 100_000_000,
      refillChunkAmount: 0,
      final: false,
    })
  )
  expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
    reservationId: "res_invoice",
    flushedAmount: 5 * 100_000_000,
    pendingFlushFinal: false,
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter api test apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts -t "flushes a matching reservation for invoicing"`

Expected: FAIL because `flushReservationForInvoicing` does not exist.

- [ ] **Step 3: Add the DO contract**

Add:

```ts
export type FlushReservationForInvoicingInput = {
  statementKey: string
  billingPeriodIds: string[]
}

export type FlushReservationForInvoicingResult = {
  ok: boolean
  outcome:
    | "deferred"
    | "flushed"
    | "no_reservation"
    | "no_unflushed_usage"
    | "recovery_required"
    | "statement_mismatch"
    | "wallet_error"
  errorMessage?: string
}
```

Expose the optional RPC in `EntitlementWindowController`:

```ts
flushReservationForInvoicing?: (
  input: FlushReservationForInvoicingInput
) => Promise<FlushReservationForInvoicingResult>
```

- [ ] **Step 4: Implement the DO RPC**

Use the existing `requestFlushAndRefill` path with `refillAmount: 0` and `pendingFlushFinal: false`:

```ts
public async flushReservationForInvoicing(
  input: FlushReservationForInvoicingInput
): Promise<FlushReservationForInvoicingResult> {
  await this.ready
  const window = this.readWalletReservation(this.db)

  if (!window?.reservationId) return { ok: true, outcome: "no_reservation" }
  if (window.recoveryRequired) return { ok: false, outcome: "recovery_required" }

  const ownsStatement =
    window.statementKey === input.statementKey ||
    (window.billingPeriodId !== null && input.billingPeriodIds.includes(window.billingPeriodId))

  if (!ownsStatement) {
    return {
      ok: false,
      outcome: "statement_mismatch",
      errorMessage: `Reservation ${window.reservationId} belongs to statement ${window.statementKey ?? "unknown"}`,
    }
  }

  if (this.hasPendingWalletFlush(window)) {
    return { ok: false, outcome: "deferred", errorMessage: "Reservation already has a pending wallet flush" }
  }

  const flushAmount = Math.max(0, window.consumedAmount - window.flushedAmount)
  const flushQuantity = Math.max(0, window.consumedQuantity - window.flushedQuantity)
  if (flushAmount <= 0) return { ok: true, outcome: "no_unflushed_usage" }

  const flushSeq = window.flushSeq + 1
  this.db
    .update(walletReservationTable)
    .set({
      refillInFlight: true,
      pendingFlushSeq: flushSeq,
      pendingFlushFinal: false,
      pendingFlushAmount: flushAmount,
      pendingFlushQuantity: flushQuantity,
      pendingRefillAmount: 0,
    })
    .run()

  await this.requestFlushAndRefill({
    flushSeq,
    flushAmount,
    flushQuantity,
    refillAmount: 0,
    effectiveAt: Date.now(),
  })

  const after = this.readWalletReservation(this.db)
  if (after?.pendingFlushSeq !== null || after?.flushSeq !== flushSeq) {
    return { ok: false, outcome: "wallet_error", errorMessage: "Reservation flush did not complete" }
  }

  return { ok: true, outcome: "flushed" }
}
```

- [ ] **Step 5: Run the DO test**

Run: `pnpm --filter api test apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts -t "flushes a matching reservation for invoicing"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ingestion/entitlements/contracts.ts internal/services/src/ingestion/entitlement-window-applier.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts
git commit -m "feat: expose invoicing reservation flush"
```

### Task 2: Add The API Endpoint That Owns DO Access

**Files:**
- Create: `apps/api/src/routes/billing/flushReservationsForInvoicingV1.ts`
- Modify: the API route registration file that groups routes
- Test: `apps/api/src/routes/billing/flushReservationsForInvoicingV1.test.ts`

- [ ] **Step 1: Write the failing route test**

Create a route test that proves the endpoint resolves the project from API key auth and calls the DO client:

```ts
it("flushes reservation windows for an invoice statement", async () => {
  const response = await app.fetch(
    new Request("http://localhost/v1/billing/reservations/flush-for-invoicing", {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customerId: "cus_123",
        subscriptionId: "sub_123",
        subscriptionPhaseId: "phase_123",
        statementKey: "stmt_123",
      }),
    }),
    env,
    executionCtx
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: true,
    flushed: 1,
    skipped: 0,
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter api test apps/api/src/routes/billing/flushReservationsForInvoicingV1.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the route**

Add `POST /v1/billing/reservations/flush-for-invoicing` with this request shape:

```ts
const requestSchema = z.object({
  customerId: z.string(),
  subscriptionId: z.string(),
  subscriptionPhaseId: z.string(),
  statementKey: z.string(),
})
```

Route behavior:
- Authenticate with `keyAuth(c)`.
- Resolve `projectId` from the API key.
- Query pending `billing_periods` for `(projectId, customerId, subscriptionId, subscriptionPhaseId, statementKey)`.
- Query matching `customer_entitlements` by `subscriptionItemId`.
- Query active `entitlement_reservations` for those entitlements.
- For each active entitlement, call `CloudflareEntitlementWindowClient.getEntitlementWindowStub(...).flushReservationForInvoicing({ statementKey, billingPeriodIds })`.
- Return `200` with:

```ts
{
  ok: true,
  flushed: number,
  skipped: number,
}
```

If any DO result is `ok: false`, return a retriable API error (`409` for `deferred`, `500` for `recovery_required` or `wallet_error`) so BILL aborts and retries later.

- [ ] **Step 4: Run the route test**

Run: `pnpm --filter api test apps/api/src/routes/billing/flushReservationsForInvoicingV1.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/billing/flushReservationsForInvoicingV1.ts apps/api/src/routes/billing/flushReservationsForInvoicingV1.test.ts
git commit -m "feat: add invoicing reservation flush endpoint"
```

### Task 3: Add SDK Method And Service Port

**Files:**
- Modify: `packages/api/src/client.ts`
- Test: `packages/api/src/client.test.ts`
- Create: `internal/services/src/use-cases/billing/reservation-flush-gateway.ts`
- Test: `internal/services/src/use-cases/billing/reservation-flush-gateway.test.ts`

- [ ] **Step 1: Add SDK test**

Add a client test:

```ts
it("posts invoicing reservation flush requests", async () => {
  const requests: Request[] = []
  const client = new Unprice({
    token: "test-token",
    baseUrl: "https://api.test",
    fetch: async (request) => {
      requests.push(request)
      return Response.json({ ok: true, flushed: 1, skipped: 0 })
    },
  })

  const result = await client.billing.reservations.flushForInvoicing({
    customerId: "cus_123",
    subscriptionId: "sub_123",
    subscriptionPhaseId: "phase_123",
    statementKey: "stmt_123",
  })

  expect(result.error).toBeUndefined()
  expect(requests[0]?.url).toBe("https://api.test/v1/billing/reservations/flush-for-invoicing")
})
```

- [ ] **Step 2: Add SDK method**

In `packages/api/src/client.ts`, add:

```ts
public get billing() {
  return {
    reservations: {
      flushForInvoicing: (
        req: PostBody<"/v1/billing/reservations/flush-for-invoicing">
      ): Promise<ApiResult<PostResponse<"/v1/billing/reservations/flush-for-invoicing">>> => {
        return this.toResult(
          this.openapi.POST("/v1/billing/reservations/flush-for-invoicing", {
            body: req,
          })
        )
      },
    },
  }
}
```

- [ ] **Step 3: Create service-layer port**

Create `reservation-flush-gateway.ts`:

```ts
import { Unprice } from "@unprice/api"
import { Err, Ok, type Result } from "@unprice/error"

export interface BillingReservationFlushGateway {
  flushForInvoicing(input: {
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, Error>>
}

export class SdkBillingReservationFlushGateway implements BillingReservationFlushGateway {
  constructor(private readonly client: Unprice) {}

  async flushForInvoicing(input: {
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, Error>> {
    const response = await this.client.billing.reservations.flushForInvoicing(input)
    if (response.error) {
      return Err(new Error(response.error.message))
    }
    return Ok(undefined)
  }
}

export function createNoopBillingReservationFlushGateway(): BillingReservationFlushGateway {
  return {
    flushForInvoicing: async () => Ok(undefined),
  }
}
```

- [ ] **Step 4: Run SDK and gateway tests**

Run: `pnpm --filter @unprice/api test packages/api/src/client.test.ts`

Run: `pnpm --filter @unprice/services test src/use-cases/billing/reservation-flush-gateway.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/client.ts packages/api/src/client.test.ts internal/services/src/use-cases/billing/reservation-flush-gateway.ts internal/services/src/use-cases/billing/reservation-flush-gateway.test.ts
git commit -m "feat: add invoicing reservation flush client"
```

### Task 4: Use The Gateway In BILL

**Files:**
- Modify: `internal/services/src/use-cases/billing/bill-period.ts`
- Test: `internal/services/src/use-cases/billing/bill-period.test.ts`

- [ ] **Step 1: Write the failing billing test**

Add:

```ts
it("blocks invoicing when reservation flush gateway fails", async () => {
  const ratingService = makeRatingService()
  const ledgerService = makeLedgerService()
  const reservationFlushGateway = {
    flushForInvoicing: vi.fn(async () => Err(new Error("reservation flush deferred"))),
  }

  await expect(
    billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db,
      repo: makeRepo(),
      ratingService,
      ledgerService,
      reservationFlushGateway,
    })
  ).rejects.toThrow("reservation flush deferred")

  expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
  expect(ledgerService.createTransfer).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Call the gateway before rating/projection**

Add `reservationFlushGateway: BillingReservationFlushGateway` to `billPeriod` input. After `billingPeriodsToInvoice` is loaded and before rating, call:

```ts
const flush = await reservationFlushGateway.flushForInvoicing({
  customerId: phase.subscription.customerId,
  subscriptionId: periodItemGroup.subscriptionId,
  subscriptionPhaseId: periodItemGroup.subscriptionPhaseId,
  statementKey: periodItemGroup.statementKey,
})

if (flush.err) {
  logger.warn("Blocking invoicing until wallet reservation usage flushes", {
    projectId: periodItemGroup.projectId,
    subscriptionId: periodItemGroup.subscriptionId,
    statementKey: periodItemGroup.statementKey,
    error: flush.err.message,
  })
  throw flush.err
}
```

- [ ] **Step 3: Run billing tests**

Run: `pnpm --filter @unprice/services test src/use-cases/billing/bill-period.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add internal/services/src/use-cases/billing/bill-period.ts internal/services/src/use-cases/billing/bill-period.test.ts
git commit -m "feat: block bill period on reservation flush"
```

### Task 5: Wire Runtime Environments

**Files:**
- Modify: `internal/services/src/deps.ts`
- Modify: `internal/services/src/context.ts`
- Modify: `internal/services/src/subscriptions/service.ts`
- Modify: `internal/services/src/subscriptions/machine.ts`
- Modify: API and tRPC composition roots that call `createServiceContext`

- [ ] **Step 1: Add configuration to service deps**

Add:

```ts
reservationFlushGateway?: BillingReservationFlushGateway
```

Do not add DO clients or Worker env to `ServiceDeps`.

- [ ] **Step 2: Wire production gateway**

Where the runtime has API base URL and service token, construct:

```ts
new SdkBillingReservationFlushGateway(
  new Unprice({
    baseUrl: deps.internalApiBaseUrl,
    token: deps.internalApiToken,
    retry: { attempts: 2 },
  })
)
```

If tests or local composition roots do not provide credentials, use `createNoopBillingReservationFlushGateway()`.

- [ ] **Step 3: Thread into subscription machine**

Pass `reservationFlushGateway` through `SubscriptionService` and `SubscriptionMachine`, then into `billPeriod`.

- [ ] **Step 4: Run focused runtime tests**

Run: `pnpm --filter @unprice/services test src/subscriptions/machine.test.ts src/use-cases/billing/bill-period.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/services/src/deps.ts internal/services/src/context.ts internal/services/src/subscriptions/service.ts internal/services/src/subscriptions/machine.ts
git commit -m "feat: wire reservation flush gateway"
```

### Task 6: Validate End-To-End Behavior

**Files:**
- Modify: `internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts`

- [ ] **Step 1: Assert wallet-backed usage is not re-rated after flush**

In the capped-wallet arrears test, use a fake `reservationFlushGateway` that returns `Ok(undefined)` after seeding wallet capture ledger lines. Assert:

```ts
expect(reservationFlushGateway.flushForInvoicing).toHaveBeenCalledWith(
  expect.objectContaining({ statementKey })
)
expect(rating.rateBillingPeriod).not.toHaveBeenCalledWith(
  expect.objectContaining({ featureSlug: "events" })
)
```

- [ ] **Step 2: Run scenario tests**

Run: `pnpm --filter @unprice/services test src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts`

Expected: PASS.

- [ ] **Step 3: Run validation**

Run: `pnpm validate`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts
git commit -m "test: prove reservation flush feeds invoicing"
```

## Acceptance Criteria

- `internal/services` does not import Cloudflare DO clients, Worker env, or `apps/api`.
- Vercel and Cloudflare callers both use the same SDK-backed flush gateway.
- The API Worker endpoint owns Durable Object lookup and invocation.
- BILL blocks on failed/deferred reservation flush, then retries later.
- Invoicing does not close reservations, clear `reservationId`, or release unused funds.
- Invoice lines continue to come from ledger projection.
- Final invoice finalization remains unchanged.

## Self-Review Notes

- Spec coverage: the plan implements “flush before invoicing, do not close before invoicing,” with infrastructure hidden behind the API endpoint.
- Placeholder scan: no placeholder markers remain.
- Type consistency: the plan consistently uses `flushReservationForInvoicing`, `flush-for-invoicing`, and `BillingReservationFlushGateway`.
