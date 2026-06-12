# Ingestion Subscription Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make async usage ingestion recover from delayed subscription renewals by invoking the canonical subscription lifecycle before Durable Object fanout.

**Architecture:** Ingestion should detect that a subscription-backed usage event is beyond the subscription's funded cycle, call the subscription machine to catch up under the existing subscription lock, then reload entitlement/billing context. Billing-period generation and wallet grant issuance belong to the subscription lifecycle, not the ingestion context loader.

**Tech Stack:** TypeScript, Vitest, pnpm workspace, Cloudflare queue ingestion, XState subscription machine, Drizzle/Postgres services.

---

## File Structure

- Modify `internal/services/src/subscriptions/machine.ts`
  - Wire `BillingService` into the `activating` actor and call `generateBillingPeriods` from the lifecycle owner.
- Modify `internal/services/src/subscriptions/service.ts`
  - Pass `billingService` into `withLockedMachine` / `SubscriptionMachine.create`.
- Modify `internal/services/src/subscriptions/machine.test.ts`
  - Prove activation/renewal materializes billing periods and still issues wallet grants.
- Create `internal/services/src/ingestion/subscription-catchup.ts`
  - Small ingestion helper that finds stale subscription ids from prepared usage entitlements and calls `subscriptions.renewSubscription`.
- Create `internal/services/src/ingestion/subscription-catchup.test.ts`
  - Unit tests for stale detection, bounded renewal, and no-op behavior.
- Modify `internal/services/src/ingestion/customer-group-processor.ts`
  - Run catch-up after the first read-only context load and reload context if catch-up changed lifecycle state.
- Modify `internal/services/src/ingestion/service.ts`
  - Wire the catch-up helper with `services.subscriptions`.
- Modify `apps/api/src/ingestion/service.ts`, `apps/api/src/ingestion/queue.ts`, `apps/api/src/middleware/init.ts`
  - Replace billing-only wiring with subscription lifecycle wiring.
- Modify `internal/services/src/ingestion/entitlement-context.ts`
  - Remove `materializeBillingPeriods` and `BillingService` dependency; context loading stays read-only.
- Modify `internal/services/src/ingestion/entitlement-context.test.ts`
  - Replace materialization tests with read-only billing-context tests.
- Modify `internal/services/src/ingestion/sync-processor.ts`
  - Remove `materializeBillingPeriods: true`; sync verify/report behavior remains read-only unless explicitly changed later.
- Modify `lessons.md`
  - Replace the temporary ingestion materialization lesson with the lifecycle catch-up rule.

## Task 1: Move Billing-Period Materialization Into Subscription Lifecycle

**Files:**
- Modify: `internal/services/src/subscriptions/machine.ts`
- Modify: `internal/services/src/subscriptions/service.ts`
- Test: `internal/services/src/subscriptions/machine.test.ts`

- [ ] **Step 1: Write the failing lifecycle test**

Add a test in `internal/services/src/subscriptions/machine.test.ts` proving the `activating` actor generates billing periods during renewal/activation. Use the existing machine test fixtures and add this assertion shape:

```ts
it("materializes billing periods during activation after renewal", async () => {
  const generateBillingPeriods = vi.fn().mockResolvedValue(
    Ok({
      cyclesCreated: 1,
      phasesProcessed: 1,
    })
  )

  const machine = createMachine({
    billingService: {
      generateBillingPeriods,
    },
    now: Date.UTC(2026, 5, 12, 13, 49, 10),
    subscription: createSubscription({
      id: "sub_usage",
      status: "active",
      active: true,
      currentCycleStartAt: Date.UTC(2026, 5, 12, 9, 30, 12),
      currentCycleEndAt: Date.UTC(2026, 5, 12, 9, 45, 12),
      renewAt: Date.UTC(2026, 5, 12, 9, 30, 12),
    }),
    phase: createPhase({
      creditLinePolicy: "capped",
      creditLineAmount: 10_000_000_000,
    }),
  })

  const result = await machine.renew()

  expect(result.err).toBeUndefined()
  expect(generateBillingPeriods).toHaveBeenCalledWith({
    projectId: "proj_123",
    subscriptionId: "sub_usage",
    now: Date.UTC(2026, 5, 12, 13, 49, 10),
  })
})
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/subscriptions/machine.test.ts -t "materializes billing periods during activation after renewal"
```

Expected: FAIL because `billingService` is not wired into `SubscriptionMachine` and `generateBillingPeriods` is not called by activation.

- [ ] **Step 3: Wire billing into the machine**

In `internal/services/src/subscriptions/machine.ts`, import `BillingService`:

```ts
import type { BillingService } from "../billing/service"
```

Add the private field and constructor parameter:

```ts
private billingService: Pick<BillingService, "generateBillingPeriods">
```

```ts
billingService,
```

```ts
billingService: Pick<BillingService, "generateBillingPeriods">
```

Assign it in the constructor:

```ts
this.billingService = billingService
```

Pass it into the `activateSubscription` actor input:

```ts
input: ({ context }) => ({
  context,
  db: this.db,
  walletService: this.walletService,
  ledgerService: this.ledgerService,
  billingService: this.billingService,
  logger: this.logger,
}),
```

Extend the actor input type:

```ts
billingService: Pick<BillingService, "generateBillingPeriods">
```

- [ ] **Step 4: Generate billing periods inside activation**

In the `activateSubscription` actor in `internal/services/src/subscriptions/machine.ts`, after the `activateSubscription(deps, ...)` call succeeds, add:

```ts
const periodsResult = await input.billingService.generateBillingPeriods({
  subscriptionId: input.context.subscriptionId,
  projectId: input.context.projectId,
  now: input.context.now,
})

if (periodsResult.err) {
  throw periodsResult.err
}
```

Keep the returned actor payload unchanged:

```ts
return {
  skipped: false as const,
  grantsIssued: result.val.grantsIssued,
}
```

- [ ] **Step 5: Pass billing from SubscriptionService**

In `internal/services/src/subscriptions/service.ts`, update the `withLockedMachine` call in `withSubscriptionMachine`:

```ts
return await withLockedMachine({
  ...args,
  db: this.db,
  repo: this.repo,
  logger: this.logger,
  analytics: this.analytics,
  customer: this.customerService,
  ratingService: this.ratingService,
  ledgerService: this.ledgerService,
  walletService: this.walletService,
  billingService: this.billingService,
  reservationFlushGateway: this.reservationFlushGateway,
  setLockContext: (ctx: Parameters<typeof this.setLockContext>[0]) =>
    this.setLockContext(ctx),
})
```

Update `withLockedMachine` / `SubscriptionMachine.create` types in `internal/services/src/subscriptions/machine.ts` to require:

```ts
billingService: Pick<BillingService, "generateBillingPeriods">
```

- [ ] **Step 6: Run the lifecycle test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/subscriptions/machine.test.ts -t "materializes billing periods during activation after renewal"
```

Expected: PASS.

- [ ] **Step 7: Commit lifecycle ownership**

```bash
git add internal/services/src/subscriptions/machine.ts internal/services/src/subscriptions/service.ts internal/services/src/subscriptions/machine.test.ts
git commit -m "fix: materialize billing periods during subscription activation"
```

## Task 2: Add Ingestion Subscription Catch-Up Helper

**Files:**
- Create: `internal/services/src/ingestion/subscription-catchup.ts`
- Create: `internal/services/src/ingestion/subscription-catchup.test.ts`

- [ ] **Step 1: Write stale-subscription tests**

Create `internal/services/src/ingestion/subscription-catchup.test.ts`:

```ts
import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import { IngestionSubscriptionCatchup } from "./subscription-catchup"

const EVENT_TIME = Date.UTC(2026, 5, 12, 13, 49, 10)

describe("IngestionSubscriptionCatchup", () => {
  it("renews stale subscription-backed usage entitlements once", async () => {
    const renewSubscription = vi.fn().mockResolvedValue(Ok({ status: "active" }))
    const getSubscriptionData = vi.fn().mockResolvedValue({
      id: "sub_123",
      projectId: "proj_123",
      currentCycleEndAt: EVENT_TIME - 1,
      status: "active",
      active: true,
    })
    const catchup = new IngestionSubscriptionCatchup({
      subscriptions: {
        getSubscriptionData,
        renewSubscription,
      },
    })

    const result = await catchup.catchUp({
      entitlements: [
        createUsageEntitlement({
          subscriptionId: "sub_123",
        }),
      ],
      projectId: "proj_123",
      timestamp: EVENT_TIME,
    })

    expect(result).toEqual({ didCatchUp: true, subscriptionIds: ["sub_123"] })
    expect(renewSubscription).toHaveBeenCalledWith({
      projectId: "proj_123",
      subscriptionId: "sub_123",
      now: EVENT_TIME,
    })
  })

  it("does not renew subscriptions that already cover the event timestamp", async () => {
    const renewSubscription = vi.fn()
    const getSubscriptionData = vi.fn().mockResolvedValue({
      id: "sub_123",
      projectId: "proj_123",
      currentCycleEndAt: EVENT_TIME + 60_000,
      status: "active",
      active: true,
    })
    const catchup = new IngestionSubscriptionCatchup({
      subscriptions: {
        getSubscriptionData,
        renewSubscription,
      },
    })

    const result = await catchup.catchUp({
      entitlements: [
        createUsageEntitlement({
          subscriptionId: "sub_123",
        }),
      ],
      projectId: "proj_123",
      timestamp: EVENT_TIME,
    })

    expect(result).toEqual({ didCatchUp: false, subscriptionIds: [] })
    expect(renewSubscription).not.toHaveBeenCalled()
  })

  it("ignores non-usage and customer-level entitlements", async () => {
    const renewSubscription = vi.fn()
    const getSubscriptionData = vi.fn()
    const catchup = new IngestionSubscriptionCatchup({
      subscriptions: {
        getSubscriptionData,
        renewSubscription,
      },
    })

    const result = await catchup.catchUp({
      entitlements: [
        createUsageEntitlement({
          featureType: "feature",
          subscriptionId: "sub_123",
        }),
        createUsageEntitlement({
          subscriptionId: null,
        }),
      ],
      projectId: "proj_123",
      timestamp: EVENT_TIME,
    })

    expect(result).toEqual({ didCatchUp: false, subscriptionIds: [] })
    expect(getSubscriptionData).not.toHaveBeenCalled()
    expect(renewSubscription).not.toHaveBeenCalled()
  })
})

function createUsageEntitlement(
  overrides: Partial<IngestionEntitlement> = {}
): IngestionEntitlement {
  return {
    billingPeriods: [],
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: EVENT_TIME - 1_000,
    expiresAt: null,
    featureConfig: {
      usageMode: "unit",
      price: {
        dinero: {
          amount: 1,
          currency: { code: "USD", base: 10, exponent: 2 },
          scale: 2,
        },
        displayAmount: "0.01",
      },
    },
    featurePlanVersionId: "fpv_123",
    featureSlug: "api_calls",
    featureType: "usage",
    grants: [],
    meterConfig: {
      eventId: "evt_usage",
      eventSlug: "usage.recorded",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    subscriptionId: "sub_123",
    subscriptionItemId: "si_123",
    ...overrides,
  }
}
```

- [ ] **Step 2: Run the failing helper tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/subscription-catchup.test.ts
```

Expected: FAIL because `subscription-catchup.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `internal/services/src/ingestion/subscription-catchup.ts`:

```ts
import type { Subscription } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import type { ServiceContext } from "../context"
import type { UnPriceSubscriptionError } from "../subscriptions/errors"
import type { IngestionCandidateEntitlements, IngestionEntitlement } from "./entitlement-context"

type SubscriptionCatchupService = Pick<
  ServiceContext["subscriptions"],
  "getSubscriptionData" | "renewSubscription"
>

export type IngestionSubscriptionCatchupResult = {
  didCatchUp: boolean
  subscriptionIds: string[]
}

export class IngestionSubscriptionCatchup {
  private readonly subscriptions: SubscriptionCatchupService

  constructor(opts: { subscriptions: SubscriptionCatchupService }) {
    this.subscriptions = opts.subscriptions
  }

  public async catchUp(params: {
    entitlements: IngestionCandidateEntitlements
    projectId: string
    timestamp: number
  }): Promise<IngestionSubscriptionCatchupResult> {
    const subscriptionIds = resolveUsageSubscriptionIds(params.entitlements)
    const caughtUp: string[] = []

    for (const subscriptionId of subscriptionIds) {
      const subscription = await this.subscriptions.getSubscriptionData({
        subscriptionId,
        projectId: params.projectId,
      })

      if (!shouldRenewForUsage(subscription, params.timestamp)) {
        continue
      }

      const result = await this.subscriptions.renewSubscription({
        subscriptionId,
        projectId: params.projectId,
        now: params.timestamp,
      })

      if (result.err) {
        throw result.err
      }

      caughtUp.push(subscriptionId)
    }

    return {
      didCatchUp: caughtUp.length > 0,
      subscriptionIds: caughtUp,
    }
  }
}

function resolveUsageSubscriptionIds(entitlements: IngestionCandidateEntitlements): string[] {
  return [
    ...new Set(
      entitlements
        .filter(isSubscriptionBackedUsageEntitlement)
        .map((entitlement) => entitlement.subscriptionId)
    ),
  ]
}

function isSubscriptionBackedUsageEntitlement(
  entitlement: IngestionEntitlement
): entitlement is IngestionEntitlement & { subscriptionId: string } {
  return entitlement.featureType === "usage" && typeof entitlement.subscriptionId === "string"
}

function shouldRenewForUsage(
  subscription: Subscription | null,
  timestamp: number
): subscription is Subscription {
  return Boolean(
    subscription &&
      subscription.active &&
      subscription.status === "active" &&
      subscription.currentCycleEndAt <= timestamp
  )
}
```

Remove unused imports if TypeScript reports them after implementation.

- [ ] **Step 4: Run the helper tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/subscription-catchup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper**

```bash
git add internal/services/src/ingestion/subscription-catchup.ts internal/services/src/ingestion/subscription-catchup.test.ts
git commit -m "feat: add ingestion subscription catchup"
```

## Task 3: Use Catch-Up Before EntitlementWindowDO Fanout

**Files:**
- Modify: `internal/services/src/ingestion/customer-group-processor.ts`
- Modify: `internal/services/src/ingestion/customer-group-processor.test.ts`
- Modify: `internal/services/src/ingestion/service.ts`
- Modify: `apps/api/src/ingestion/service.ts`
- Modify: `apps/api/src/ingestion/queue.ts`
- Modify: `apps/api/src/middleware/init.ts`

- [ ] **Step 1: Write the customer-group processor test**

Add this test to `internal/services/src/ingestion/customer-group-processor.test.ts`:

```ts
it("catches up stale subscriptions and reloads prepared context before fanout", async () => {
  const freshMessage = createMessage({ timestamp: TEST_NOW })
  const catchUp = vi.fn().mockResolvedValue({
    didCatchUp: true,
    subscriptionIds: ["sub_123"],
  })
  const prepareCustomerMessageGroup = vi
    .fn()
    .mockResolvedValueOnce({
      candidateEntitlements: [{ customerEntitlementId: "ce_stale", subscriptionId: "sub_123" }],
      messages: [freshMessage],
    })
    .mockResolvedValueOnce({
      candidateEntitlements: [{ customerEntitlementId: "ce_fresh", subscriptionId: "sub_123" }],
      messages: [freshMessage],
    })
  const preparedProcess = vi.fn().mockResolvedValue([
    {
      message: freshMessage,
      outcome: { state: "processed" },
    },
  ])
  const processor = createProcessor({
    preparedProcess,
    prepareCustomerMessageGroup,
    subscriptionCatchup: { catchUp },
  })

  await processor.processCustomerGroup({
    customerId: "cus_123",
    projectId: "proj_123",
    messages: [freshMessage],
  })

  expect(catchUp).toHaveBeenCalledWith({
    entitlements: [{ customerEntitlementId: "ce_stale", subscriptionId: "sub_123" }],
    projectId: "proj_123",
    timestamp: TEST_NOW,
  })
  expect(prepareCustomerMessageGroup).toHaveBeenCalledTimes(2)
  expect(preparedProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      candidateEntitlements: [{ customerEntitlementId: "ce_fresh", subscriptionId: "sub_123" }],
    })
  )
})
```

Update the `createProcessor` helper type to accept:

```ts
subscriptionCatchup?: {
  catchUp: ReturnType<typeof vi.fn>
}
```

- [ ] **Step 2: Run the failing processor test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/customer-group-processor.test.ts -t "catches up stale subscriptions"
```

Expected: FAIL because `IngestionCustomerGroupProcessor` does not accept or call `subscriptionCatchup`.

- [ ] **Step 3: Add catch-up to the processor**

In `internal/services/src/ingestion/customer-group-processor.ts`, add:

```ts
type SubscriptionCatchup = {
  catchUp(params: {
    entitlements: PreparedCustomerMessageGroup["candidateEntitlements"]
    projectId: string
    timestamp: number
  }): Promise<{ didCatchUp: boolean; subscriptionIds: string[] }>
}
```

Add a field:

```ts
private readonly subscriptionCatchup: SubscriptionCatchup | null
```

Add it to constructor opts:

```ts
subscriptionCatchup?: SubscriptionCatchup
```

Assign it:

```ts
this.subscriptionCatchup = opts.subscriptionCatchup ?? null
```

Replace the single `preparedGroup` load in `processCustomerGroup` with:

```ts
let preparedGroup = await this.entitlementContext.prepareCustomerMessageGroup({
  customerId,
  messages: freshMessages,
  projectId,
})

const latestFreshMessage = freshMessages.at(-1)
if (this.subscriptionCatchup && latestFreshMessage) {
  const catchup = await this.subscriptionCatchup.catchUp({
    entitlements: preparedGroup.candidateEntitlements,
    projectId,
    timestamp: latestFreshMessage.timestamp,
  })

  if (catchup.didCatchUp) {
    preparedGroup = await this.entitlementContext.prepareCustomerMessageGroup({
      customerId,
      messages: freshMessages,
      projectId,
    })
  }
}
```

- [ ] **Step 4: Wire the helper in IngestionService**

In `internal/services/src/ingestion/service.ts`, import:

```ts
import type { SubscriptionService } from "../subscriptions/service"
import { IngestionSubscriptionCatchup } from "./subscription-catchup"
```

Change constructor opts from billing-only to subscription lifecycle:

```ts
subscriptions?: Pick<SubscriptionService, "getSubscriptionData" | "renewSubscription">
```

Construct:

```ts
const subscriptionCatchup = opts.subscriptions
  ? new IngestionSubscriptionCatchup({ subscriptions: opts.subscriptions })
  : null
```

Pass it into `IngestionCustomerGroupProcessor`:

```ts
this.customerGroupProcessor = new IngestionCustomerGroupProcessor({
  entitlementContext,
  logger: opts.logger,
  messageOutcomes,
  preparedMessageProcessor,
  reportingDispatcher,
  subscriptionCatchup: subscriptionCatchup ?? undefined,
})
```

- [ ] **Step 5: Update API ingestion wiring**

In `apps/api/src/ingestion/service.ts`, `apps/api/src/ingestion/queue.ts`, and `apps/api/src/middleware/init.ts`, replace the `billingService` / `svcCtx.billing` ingestion option with:

```ts
subscriptions: svcCtx.subscriptions,
```

Keep existing `db`, `cache`, `entitlementService`, `entitlementWindowClient`, `reportingClient`, `logger`, and `now` wiring unchanged.

- [ ] **Step 6: Run processor and service tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/customer-group-processor.test.ts src/ingestion/subscription-catchup.test.ts
pnpm --filter @unprice/services exec vitest run src/ingestion/service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit ingestion catch-up wiring**

```bash
git add internal/services/src/ingestion/customer-group-processor.ts internal/services/src/ingestion/customer-group-processor.test.ts internal/services/src/ingestion/service.ts apps/api/src/ingestion/service.ts apps/api/src/ingestion/queue.ts apps/api/src/middleware/init.ts
git commit -m "fix: catch up subscriptions before usage fanout"
```

## Task 4: Remove Ingestion Billing-Only Materialization

**Files:**
- Modify: `internal/services/src/ingestion/entitlement-context.ts`
- Modify: `internal/services/src/ingestion/entitlement-context.test.ts`
- Modify: `internal/services/src/ingestion/sync-processor.ts`
- Modify: `lessons.md`

- [ ] **Step 1: Replace entitlement-context tests**

In `internal/services/src/ingestion/entitlement-context.test.ts`, delete the test named:

```ts
it("materializes missing billing period context for subscription-backed usage ingestion", async () => {
```

Keep the read-only test and rename it to:

```ts
it("leaves missing billing period context empty for read-only context loads", async () => {
```

The assertion stays:

```ts
expect(result.candidateEntitlements[0]?.billingPeriods).toEqual([])
```

- [ ] **Step 2: Run the focused context test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/entitlement-context.test.ts -t "leaves missing billing period context empty"
```

Expected: PASS before implementation, because this confirms the desired read-only behavior is already observable.

- [ ] **Step 3: Remove materialization code**

In `internal/services/src/ingestion/entitlement-context.ts`, remove these imports:

```ts
import type { BillingService } from "../billing/service"
```

Remove `materializeBillingPeriods?: boolean` from `CustomerGrantContextReader` and `prepareCustomerGrantContext` params.

Remove:

```ts
type BillingPeriodMaterializer = Pick<BillingService, "generateBillingPeriods">
private readonly billingService: BillingPeriodMaterializer | null
```

Remove `billingService` from the constructor opts and assignment.

In `prepareCustomerMessageGroup`, call:

```ts
const preparedContext = await this.prepareCustomerGrantContext({
  customerId,
  projectId,
  ...contextWindow,
})
```

In `withFreshBillingPeriodContexts`, replace the body with:

```ts
const billingPeriodsByItemId = await this.loadBillingPeriodContexts({
  customerId: params.customerId,
  entitlements: context.candidateEntitlements,
  endAt: params.endAt,
  projectId: params.projectId,
  startAt: params.startAt,
})

return this.attachBillingPeriodContexts(context, billingPeriodsByItemId)
```

Delete:

```ts
resolveSubscriptionsMissingBillingPeriodCoverage
materializeBillingPeriods
hasBillingPeriodCoveringTimestamp
```

Only delete `hasBillingPeriodCoveringTimestamp` if no remaining code uses it.

- [ ] **Step 4: Remove sync materialization flag**

In `internal/services/src/ingestion/sync-processor.ts`, replace:

```ts
materializeBillingPeriods: true,
```

with no property. The call should pass only:

```ts
customerId: message.customerId,
projectId: message.projectId,
startAt: message.timestamp,
endAt: message.timestamp,
```

- [ ] **Step 5: Update the lesson**

In `lessons.md`, replace the existing `2026-06-12` ingestion billing lesson with:

```md
- 2026-06-12: Subscription-backed usage ingestion should call the subscription lifecycle catch-up path before DO fanout when the event timestamp is beyond the subscription cycle; billing-period materialization and capped credit-line grants belong inside the subscription machine, while verify/context loads stay read-only.
```

- [ ] **Step 6: Run context tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/entitlement-context.test.ts src/ingestion/sync-processor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the removal**

```bash
git add internal/services/src/ingestion/entitlement-context.ts internal/services/src/ingestion/entitlement-context.test.ts internal/services/src/ingestion/sync-processor.ts lessons.md
git commit -m "refactor: keep ingestion context loads read only"
```

## Task 5: Final Verification

**Files:**
- Verify: `internal/services/src/ingestion/**`
- Verify: `internal/services/src/subscriptions/**`
- Verify: `apps/api/src/ingestion/**`

- [ ] **Step 1: Run targeted service tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/entitlement-context.test.ts src/ingestion/customer-group-processor.test.ts src/ingestion/subscription-catchup.test.ts src/ingestion/service.test.ts src/subscriptions/machine.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typechecks**

Run:

```bash
pnpm --filter @unprice/services typecheck
pnpm --filter api type-check
```

Expected: PASS.

- [ ] **Step 3: Run API ingestion factory tests**

Run:

```bash
pnpm --filter api test src/ingestion/service.factory.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run repository validation**

Run:

```bash
pnpm validate
```

Expected: PASS.

- [ ] **Step 5: Commit verification-only fixes**

If verification required small test or type fixes, commit them:

```bash
git add internal/services/src apps/api/src lessons.md
git commit -m "test: verify ingestion subscription catchup"
```

Skip this commit when there are no additional changes after Task 4.

## Self-Review

Spec coverage:
- Replace billing-period materialization in ingestion: Task 4.
- Use canonical subscription machine catch-up before usage fanout: Tasks 1-3.
- Avoid DO-owned renewal or wallet logic: Task 3 keeps catch-up in services before DO fanout.
- Keep verify/context loads read-only: Task 4.
- Check performance/latency risk: catch-up runs only when a subscription cycle is stale and only in queue processing.

Placeholder scan:
- No task contains open-ended implementation text without code or exact commands.

Type consistency:
- `IngestionSubscriptionCatchup.catchUp` returns `{ didCatchUp, subscriptionIds }` in every task.
- Ingestion wiring consistently uses `subscriptions`, not `billingService`.
- Lifecycle materialization consistently uses `billingService.generateBillingPeriods`.
