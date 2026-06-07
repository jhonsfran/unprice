# Invoicing Closes Reservations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block invoice creation until open wallet reservations for the invoice statement are closed and their final ledger captures exist.

**Architecture:** Add a small reservation-close interface to the billing use case, backed by a public EntitlementWindowDO RPC. The BILL phase calls this before invoice materialization, then keeps using ledger projection as the invoice source of truth.

**Tech Stack:** TypeScript, Vitest, Drizzle, Cloudflare Durable Objects, pgledger.

---

## File Structure

- Modify `internal/services/src/wallet/service.ts`: add the explicit reservation close reason.
- Modify `apps/api/src/ingestion/entitlements/contracts.ts`: define the invoicing close input/result contract.
- Modify `internal/services/src/ingestion/entitlement-window-applier.ts`: expose the optional DO RPC on `EntitlementWindowController`.
- Modify `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`: add the public RPC that validates statement ownership and calls the existing private close path.
- Create `internal/services/src/use-cases/billing/reservation-closer.ts`: pure service-layer helper that resolves statement periods to entitlement windows and calls a provided `EntitlementWindowClient`.
- Modify `internal/services/src/use-cases/billing/bill-period.ts`: require a `reservationCloser` and run it before ledger rating/projection for each statement group.
- Modify `internal/services/src/subscriptions/machine.ts`, `internal/services/src/subscriptions/service.ts`, and `internal/services/src/context.ts`: thread the closer into production invoicing.

### Task 1: Add The DO Invoicing Close Contract

**Files:**
- Modify: `internal/services/src/wallet/service.ts`
- Modify: `apps/api/src/ingestion/entitlements/contracts.ts`
- Modify: `internal/services/src/ingestion/entitlement-window-applier.ts`
- Modify: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`
- Test: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts`

- [ ] **Step 1: Write the failing DO test**

Add a test beside the existing close-reservation tests:

```ts
it("closes a matching reservation for invoicing", async () => {
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
  const result = await durableObject.closeReservationForInvoicing({
    statementKey: "stmt_123",
    billingPeriodIds: ["bp_123"],
  })

  expect(result).toMatchObject({ ok: true, outcome: "success" })
  expect(testState.flushReservation).toHaveBeenCalledWith(
    expect.objectContaining({
      reservationId: "res_invoice",
      flushSeq: 3,
      flushAmount: 3 * 100_000_000,
      final: true,
    })
  )
  expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({ reservationId: null })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter api test apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts -t "closes a matching reservation for invoicing"`

Expected: FAIL because `closeReservationForInvoicing` does not exist.

- [ ] **Step 3: Add the minimal contract and implementation**

Add `invoice_invoicing` to `ReservationCloseReason`:

```ts
export type ReservationCloseReason =
  | "inactivity"
  | "limit_reached"
  | "wallet_empty"
  | "deletion_requested"
  | "period_close"
  | "manual"
  | "invoice_invoicing"
```

Add the input/result types in `contracts.ts`:

```ts
export type CloseReservationForInvoicingInput = {
  statementKey: string
  billingPeriodIds: string[]
}

export type CloseReservationForInvoicingResult = {
  ok: boolean
  outcome:
    | "already_reconciled"
    | "deferred"
    | "no_reservation"
    | "statement_mismatch"
    | "success"
    | "wallet_error"
    | "exception"
  reason?: "pending_wallet_flush" | "recovery_required" | "statement_mismatch"
  errorMessage?: string
}
```

Expose the RPC in `EntitlementWindowController`:

```ts
closeReservationForInvoicing?: (
  input: CloseReservationForInvoicingInput
) => Promise<CloseReservationForInvoicingResult>
```

Add the public method to `EntitlementWindowDO`:

```ts
public async closeReservationForInvoicing(
  input: CloseReservationForInvoicingInput
): Promise<CloseReservationForInvoicingResult> {
  await this.ready
  const window = this.readWalletReservation(this.db)

  if (!window?.reservationId) {
    return { ok: true, outcome: "no_reservation" }
  }

  const ownsStatement =
    window.statementKey === input.statementKey ||
    (window.billingPeriodId !== null && input.billingPeriodIds.includes(window.billingPeriodId))

  if (!ownsStatement) {
    return {
      ok: false,
      outcome: "statement_mismatch",
      reason: "statement_mismatch",
      errorMessage: `Reservation ${window.reservationId} belongs to statement ${window.statementKey ?? "unknown"}`,
    }
  }

  return this.closeReservation({ closeReason: "invoice_invoicing", recoverPendingFinal: true })
}
```

- [ ] **Step 4: Run the DO test**

Run: `pnpm --filter api test apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts -t "closes a matching reservation for invoicing"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/services/src/wallet/service.ts apps/api/src/ingestion/entitlements/contracts.ts internal/services/src/ingestion/entitlement-window-applier.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.test.ts
git commit -m "feat: expose invoicing reservation close"
```

### Task 2: Resolve And Close Reservations Before Billing

**Files:**
- Create: `internal/services/src/use-cases/billing/reservation-closer.ts`
- Modify: `internal/services/src/use-cases/billing/bill-period.ts`
- Test: `internal/services/src/use-cases/billing/bill-period.test.ts`

- [ ] **Step 1: Write the failing bill-period unit test**

Add a test in `bill-period.test.ts`:

```ts
it("blocks invoicing when statement reservations cannot be closed", async () => {
  const ratingService = makeRatingService()
  const ledgerService = makeLedgerService()
  const reservationCloser = {
    closeReservationsForStatement: vi.fn(async () => ({
      err: new Error("reservation close deferred"),
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
      reservationCloser,
    })
  ).rejects.toThrow("reservation close deferred")

  expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
  expect(ledgerService.createTransfer).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @unprice/services test src/use-cases/billing/bill-period.test.ts -t "blocks invoicing"`

Expected: FAIL because `reservationCloser` is not part of `billPeriod`.

- [ ] **Step 3: Add the reservation closer helper**

Create `reservation-closer.ts`:

```ts
import { and, eq, inArray, isNull } from "@unprice/db"
import { billingPeriods, customerEntitlements, entitlementReservations } from "@unprice/db/schema"
import type { Database } from "@unprice/db"
import { Err, Ok, type Result } from "@unprice/error"
import type { EntitlementWindowClient } from "../../ingestion"

export type BillingReservationCloserError = Error

export interface BillingReservationCloser {
  closeReservationsForStatement(input: {
    projectId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, BillingReservationCloserError>>
}

export class EntitlementWindowBillingReservationCloser implements BillingReservationCloser {
  constructor(
    private readonly db: Database,
    private readonly entitlementWindowClient: EntitlementWindowClient
  ) {}

  async closeReservationsForStatement(input: {
    projectId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, BillingReservationCloserError>> {
    const periods = await this.db
      .select({
        id: billingPeriods.id,
        customerId: billingPeriods.customerId,
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

    const subscriptionItemIds = periods.map((period) => period.subscriptionItemId)
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
          inArray(customerEntitlements.subscriptionItemId, subscriptionItemIds)
        )
      )

    if (entitlements.length === 0) return Ok(undefined)

    const activeReservations = await this.db
      .select({
        entitlementId: entitlementReservations.entitlementId,
      })
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

    const activeEntitlementIds = new Set(
      activeReservations.map((reservation) => reservation.entitlementId)
    )
    const billingPeriodIds = periods.map((period) => period.id)

    for (const entitlement of entitlements) {
      if (!activeEntitlementIds.has(entitlement.id)) continue

      const stub = this.entitlementWindowClient.getEntitlementWindowStub({
        customerEntitlementId: entitlement.id,
        customerId: entitlement.customerId,
        projectId: input.projectId,
      })

      if (!stub.closeReservationForInvoicing) {
        return Err(new Error("Entitlement window does not support invoicing reservation close"))
      }

      const result = await stub.closeReservationForInvoicing({
        statementKey: input.statementKey,
        billingPeriodIds,
      })

      if (!result.ok) {
        return Err(new Error(result.errorMessage ?? `Reservation close failed: ${result.outcome}`))
      }
    }

    return Ok(undefined)
  }
}
```

- [ ] **Step 4: Call the closer before invoicing**

Modify `billPeriod` signature and call the closer immediately after loading `billingPeriodsToInvoice` and before rating:

```ts
reservationCloser,
}: {
  context: SubscriptionContext
  logger: Logger
  db: Database
  repo: SubscriptionRepository
  ratingService: RatingService
  ledgerService: LedgerGateway
  reservationCloser: BillingReservationCloser
})
```

```ts
const closeReservations = await reservationCloser.closeReservationsForStatement({
  projectId: periodItemGroup.projectId,
  subscriptionId: periodItemGroup.subscriptionId,
  subscriptionPhaseId: periodItemGroup.subscriptionPhaseId,
  statementKey: periodItemGroup.statementKey,
})

if (closeReservations.err) {
  logger.warn("Blocking invoicing until wallet reservations close", {
    projectId: periodItemGroup.projectId,
    subscriptionId: periodItemGroup.subscriptionId,
    statementKey: periodItemGroup.statementKey,
    error: closeReservations.err.message,
  })
  throw closeReservations.err
}
```

- [ ] **Step 5: Run the unit test**

Run: `pnpm --filter @unprice/services test src/use-cases/billing/bill-period.test.ts -t "blocks invoicing"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/services/src/use-cases/billing/reservation-closer.ts internal/services/src/use-cases/billing/bill-period.ts internal/services/src/use-cases/billing/bill-period.test.ts
git commit -m "feat: block invoicing on open reservations"
```

### Task 3: Wire The Closer Into Production Invoicing

**Files:**
- Modify: `internal/services/src/context.ts`
- Modify: `internal/services/src/subscriptions/service.ts`
- Modify: `internal/services/src/subscriptions/machine.ts`
- Modify: `apps/api/src/middleware/init.ts`
- Test: `internal/services/src/subscriptions/machine.test.ts`

- [ ] **Step 1: Write the failing machine wiring test**

Add a test or extend the invoicing machine test so `billPeriod` receives a reservation closer. The assertion should verify the closer is called before the billing actor completes:

```ts
const reservationCloser = {
  closeReservationsForStatement: vi.fn(async () => Ok(undefined)),
}

const machine = new SubscriptionMachine({
  db,
  repo,
  logger,
  billingService,
  ratingService,
  ledgerService,
  walletService,
  reservationCloser,
})

// trigger the existing active -> invoicing transition
expect(reservationCloser.closeReservationsForStatement).toHaveBeenCalled()
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @unprice/services test src/subscriptions/machine.test.ts -t "active -> invoicing"`

Expected: FAIL because the machine constructor does not accept/pass `reservationCloser`.

- [ ] **Step 3: Thread the dependency**

Add `reservationCloser: BillingReservationCloser` to `SubscriptionService` and `SubscriptionMachine` constructors, then pass it in the invoicing actor:

```ts
input: ({ context }) => ({
  context,
  logger: this.logger,
  db: this.db,
  repo: this.repo,
  ratingService: this.ratingService,
  ledgerService: this.ledgerService,
  reservationCloser: this.reservationCloser,
})
```

In `context.ts`, construct a closer only when an `entitlementWindowClient` exists:

```ts
const reservationCloser = deps.entitlementWindowClient
  ? new EntitlementWindowBillingReservationCloser(deps.db, deps.entitlementWindowClient)
  : createNoopBillingReservationCloser()
```

Add the optional dependency to `ServiceDeps`:

```ts
entitlementWindowClient?: EntitlementWindowClient
```

In `apps/api/src/middleware/init.ts`, create one `CloudflareEntitlementWindowClient` and pass it both to `createServiceContext` and `createIngestionService`.

- [ ] **Step 4: Run the machine test**

Run: `pnpm --filter @unprice/services test src/subscriptions/machine.test.ts -t "active -> invoicing"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/services/src/context.ts internal/services/src/deps.ts internal/services/src/subscriptions/service.ts internal/services/src/subscriptions/machine.ts apps/api/src/middleware/init.ts internal/services/src/subscriptions/machine.test.ts
git commit -m "feat: wire reservation closer into invoicing"
```

### Task 4: Prove Wallet Invoicing Uses Final Captures

**Files:**
- Modify: `internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts`
- Modify: direct `billPeriod` test callers as needed to pass `createNoopBillingReservationCloser()`

- [ ] **Step 1: Write the integration test**

Add a scenario to `pay-in-arrear-capped-wallet.integration.test.ts` where an active reservation has unflushed usage before `billPeriod`. Use a fake closer that calls the same wallet flush helper used by existing wallet tests, then assert invoice totals include the final capture.

```ts
const reservationCloser = {
  closeReservationsForStatement: vi.fn(async () => {
    const flushed = await flushReservationForTest(wallet, {
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_test_invoice",
      flushSeq: 1,
      flushAmount: usageAmount,
      flushQuantity: 1200,
      final: true,
      billingPeriodId: usageBillingPeriodId,
      statementKey,
      featurePlanVersionItemId: usageSubscriptionItemId,
      featureSlug: "events",
    })

    if (flushed.err) return { err: flushed.err }

    return { val: undefined }
  }),
}

const billed = await billPeriod({
  context: await loadSubscriptionContext(),
  logger,
  db,
  repo,
  ratingService: rating,
  ledgerService: ledger,
  reservationCloser,
})

expect(billed.phasesProcessed).toBe(1)
expect(reservationCloser.closeReservationsForStatement).toHaveBeenCalledWith(
  expect.objectContaining({ statementKey })
)
```

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `pnpm --filter @unprice/services test src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts -t "final captures"`

Expected: FAIL before the wiring/fixture adjustments are complete.

- [ ] **Step 3: Update direct callers**

For existing direct `billPeriod` test calls that do not exercise reservation closure, pass:

```ts
reservationCloser: createNoopBillingReservationCloser(),
```

Export this helper from `reservation-closer.ts`:

```ts
export function createNoopBillingReservationCloser(): BillingReservationCloser {
  return {
    closeReservationsForStatement: async () => Ok(undefined),
  }
}
```

- [ ] **Step 4: Run focused billing tests**

Run: `pnpm --filter @unprice/services test src/use-cases/billing/bill-period.test.ts src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Run validation**

Run: `pnpm validate`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/services/src/use-cases/billing/reservation-closer.ts internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts internal/services/src/use-cases/billing/bill-period.test.ts
git commit -m "test: cover reservation close before invoicing"
```

## Self-Review Notes

- Spec coverage: the plan blocks invoicing on open reservations, closes through the DO owner, keeps finalization untouched, and relies on ledger projection after close.
- Placeholder scan: no placeholder markers remain.
- Type consistency: the plan uses `BillingReservationCloser.closeReservationsForStatement`, `closeReservationForInvoicing`, and `invoice_invoicing` consistently across tasks.
