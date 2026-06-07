# Invoicing Flushes Reservations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before BILL creates an invoice, force any invoice-relevant wallet reservation usage to flush into the ledger without closing or releasing the reservation.

**Architecture:** Add one public EntitlementWindowDO RPC for an invoicing-triggered non-final flush. `billPeriod` calls a small service-layer flusher before rating/projecting invoice lines, then keeps using ledger lines as the invoice source of truth.

**Tech Stack:** TypeScript, Vitest, Drizzle, Cloudflare Durable Objects, pgledger.

---

## File Structure

- Modify `apps/api/src/ingestion/entitlements/contracts.ts`: add the invoicing flush input/result types.
- Modify `internal/services/src/ingestion/entitlement-window-applier.ts`: expose the optional DO RPC on `EntitlementWindowController`.
- Modify `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`: add a public RPC that validates statement ownership and calls the existing non-final flush path with `refillAmount: 0`.
- Create `internal/services/src/use-cases/billing/reservation-flusher.ts`: resolve statement billing periods to entitlement windows and call the DO RPC.
- Modify `internal/services/src/use-cases/billing/bill-period.ts`: call `reservationFlusher.flushReservationsForStatement` before invoice materialization.
- Modify subscription wiring (`context.ts`, `subscriptions/service.ts`, `subscriptions/machine.ts`, API init): thread the flusher into production invoicing.

### Task 1: Add The DO Invoicing Flush RPC

**Files:**
- Modify: `apps/api/src/ingestion/entitlements/contracts.ts`
- Modify: `internal/services/src/ingestion/entitlement-window-applier.ts`
- Modify: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`
- Test: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`

- [ ] **Step 1: Write the failing DO test**

Add a test beside the existing wallet flush/reservation tests:

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

  expect(result).toMatchObject({ ok: true, outcome: "success" })
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

- [ ] **Step 3: Add the RPC contract**

In `contracts.ts`, add:

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

In `EntitlementWindowController`, add:

```ts
flushReservationForInvoicing?: (
  input: FlushReservationForInvoicingInput
) => Promise<FlushReservationForInvoicingResult>
```

- [ ] **Step 4: Implement the RPC using the existing flush path**

Add the public method to `EntitlementWindowDO`:

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

### Task 2: Add The Billing Reservation Flusher

**Files:**
- Create: `internal/services/src/use-cases/billing/reservation-flusher.ts`
- Modify: `internal/services/src/use-cases/billing/bill-period.ts`
- Test: `internal/services/src/use-cases/billing/bill-period.test.ts`

- [ ] **Step 1: Write the failing billing test**

Add this test in `bill-period.test.ts`:

```ts
it("blocks invoicing when statement reservation flush is deferred", async () => {
  const ratingService = makeRatingService()
  const ledgerService = makeLedgerService()
  const reservationFlusher = {
    flushReservationsForStatement: vi.fn(async () => ({
      err: new Error("reservation flush deferred"),
    })),
  }

  await expect(
    billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db,
      repo: makeRepo(),
      ratingService,
      ledgerService,
      reservationFlusher,
    })
  ).rejects.toThrow("reservation flush deferred")

  expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
  expect(ledgerService.createTransfer).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @unprice/services test src/use-cases/billing/bill-period.test.ts -t "blocks invoicing"`

Expected: FAIL because `reservationFlusher` is not wired into `billPeriod`.

- [ ] **Step 3: Create the flusher helper**

Create `reservation-flusher.ts`:

```ts
import { and, eq, inArray, isNull } from "@unprice/db"
import { billingPeriods, customerEntitlements, entitlementReservations } from "@unprice/db/schema"
import type { Database } from "@unprice/db"
import { Err, Ok, type Result } from "@unprice/error"
import type { EntitlementWindowClient } from "../../ingestion"

export interface BillingReservationFlusher {
  flushReservationsForStatement(input: {
    projectId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, Error>>
}

export class EntitlementWindowBillingReservationFlusher implements BillingReservationFlusher {
  constructor(
    private readonly db: Database,
    private readonly entitlementWindowClient: EntitlementWindowClient
  ) {}

  async flushReservationsForStatement(input: {
    projectId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, Error>> {
    const periods = await this.db
      .select({
        id: billingPeriods.id,
        subscriptionItemId: billingPeriods.subscriptionItemId,
      })
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.projectId, input.projectId),
          eq(billingPeriods.subscriptionId, input.subscriptionId),
          eq(billingPeriods.subscriptionPhaseId, input.subscriptionPhaseId),
          eq(billingPeriods.statementKey, input.statementKey),
          eq(billingPeriods.status, "pending")
        )
      )

    if (periods.length === 0) return Ok(undefined)

    const entitlements = await this.db
      .select({
        id: customerEntitlements.id,
        customerId: customerEntitlements.customerId,
      })
      .from(customerEntitlements)
      .where(
        and(
          eq(customerEntitlements.projectId, input.projectId),
          eq(customerEntitlements.subscriptionId, input.subscriptionId),
          eq(customerEntitlements.subscriptionPhaseId, input.subscriptionPhaseId),
          inArray(
            customerEntitlements.subscriptionItemId,
            periods.map((period) => period.subscriptionItemId)
          )
        )
      )

    if (entitlements.length === 0) return Ok(undefined)

    const activeReservations = await this.db
      .select({ entitlementId: entitlementReservations.entitlementId })
      .from(entitlementReservations)
      .where(
        and(
          eq(entitlementReservations.projectId, input.projectId),
          inArray(
            entitlementReservations.entitlementId,
            entitlements.map((entitlement) => entitlement.id)
          ),
          isNull(entitlementReservations.reconciledAt)
        )
      )

    const activeEntitlementIds = new Set(activeReservations.map((row) => row.entitlementId))
    const billingPeriodIds = periods.map((period) => period.id)

    for (const entitlement of entitlements) {
      if (!activeEntitlementIds.has(entitlement.id)) continue

      const stub = this.entitlementWindowClient.getEntitlementWindowStub({
        customerEntitlementId: entitlement.id,
        customerId: entitlement.customerId,
        projectId: input.projectId,
      })

      if (!stub.flushReservationForInvoicing) {
        return Err(new Error("Entitlement window does not support invoicing reservation flush"))
      }

      const result = await stub.flushReservationForInvoicing({
        statementKey: input.statementKey,
        billingPeriodIds,
      })

      if (!result.ok) {
        return Err(new Error(result.errorMessage ?? `Reservation flush failed: ${result.outcome}`))
      }
    }

    return Ok(undefined)
  }
}

export function createNoopBillingReservationFlusher(): BillingReservationFlusher {
  return { flushReservationsForStatement: async () => Ok(undefined) }
}
```

- [ ] **Step 4: Call the flusher in `billPeriod`**

Add `reservationFlusher: BillingReservationFlusher` to `billPeriod` input. After `billingPeriodsToInvoice` is loaded and before any rating/ledger projection, add:

```ts
const flushed = await reservationFlusher.flushReservationsForStatement({
  projectId: periodItemGroup.projectId,
  subscriptionId: periodItemGroup.subscriptionId,
  subscriptionPhaseId: periodItemGroup.subscriptionPhaseId,
  statementKey: periodItemGroup.statementKey,
})

if (flushed.err) {
  logger.warn("Blocking invoicing until wallet reservation usage flushes", {
    projectId: periodItemGroup.projectId,
    subscriptionId: periodItemGroup.subscriptionId,
    statementKey: periodItemGroup.statementKey,
    error: flushed.err.message,
  })
  throw flushed.err
}
```

- [ ] **Step 5: Run the billing test**

Run: `pnpm --filter @unprice/services test src/use-cases/billing/bill-period.test.ts -t "blocks invoicing"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/services/src/use-cases/billing/reservation-flusher.ts internal/services/src/use-cases/billing/bill-period.ts internal/services/src/use-cases/billing/bill-period.test.ts
git commit -m "feat: flush wallet reservations before invoicing"
```

### Task 3: Wire Production Invoicing

**Files:**
- Modify: `internal/services/src/deps.ts`
- Modify: `internal/services/src/context.ts`
- Modify: `internal/services/src/subscriptions/service.ts`
- Modify: `internal/services/src/subscriptions/machine.ts`
- Modify: `apps/api/src/middleware/init.ts`
- Test: existing billing/subscription tests that call `billPeriod`

- [ ] **Step 1: Thread the dependency**

Add `entitlementWindowClient?: EntitlementWindowClient` to `ServiceDeps`. In `context.ts`, create:

```ts
const reservationFlusher = deps.entitlementWindowClient
  ? new EntitlementWindowBillingReservationFlusher(deps.db, deps.entitlementWindowClient)
  : createNoopBillingReservationFlusher()
```

Pass `reservationFlusher` into `SubscriptionService`, then into `SubscriptionMachine`, then into the `billPeriod` actor input:

```ts
reservationFlusher: this.reservationFlusher,
```

- [ ] **Step 2: Wire Cloudflare once in API init**

In `apps/api/src/middleware/init.ts`, construct one `CloudflareEntitlementWindowClient`:

```ts
const entitlementWindowClient = new CloudflareEntitlementWindowClient(c.env)
```

Pass it to both `createServiceContext({ ... entitlementWindowClient })` and `createIngestionService`.

- [ ] **Step 3: Update direct test callers**

For direct `billPeriod` calls in tests that do not test wallet flushing, pass:

```ts
reservationFlusher: createNoopBillingReservationFlusher(),
```

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @unprice/services test src/use-cases/billing/bill-period.test.ts src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/services/src/deps.ts internal/services/src/context.ts internal/services/src/subscriptions/service.ts internal/services/src/subscriptions/machine.ts apps/api/src/middleware/init.ts internal/services/src/use-cases/billing/bill-period.test.ts internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts
git commit -m "feat: wire invoicing reservation flusher"
```

### Task 4: Validate End-To-End Behavior

**Files:**
- Modify: `internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts`

- [ ] **Step 1: Add an integration assertion**

In the capped-wallet arrears test, assert that BILL sees wallet capture ledger lines after the flusher runs and does not re-rate that usage item:

```ts
expect(reservationFlusher.flushReservationsForStatement).toHaveBeenCalledWith(
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

- Invoicing triggers a non-final flush for matching unflushed wallet reservation usage.
- Invoicing blocks when the flush is pending, mismatched, failed, or requires recovery.
- Invoicing does not close the reservation, clear `reservationId`, or release unused funds.
- Invoice lines continue to come from ledger projection.
- Final invoice finalization remains unchanged.

## Self-Review Notes

- Spec coverage: the plan implements “flush before invoicing, do not close before invoicing.”
- Placeholder scan: no placeholder markers remain.
- Type consistency: the plan consistently uses `flushReservationForInvoicing` and `BillingReservationFlusher`.
