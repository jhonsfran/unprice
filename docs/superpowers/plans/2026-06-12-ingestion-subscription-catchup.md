# Ingestion Subscription Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make queued usage ingestion recover when a subscription renewal job has not run before usage arrives for the next billing cycle.

**Architecture:** Keep ingestion entitlement context read-only. Put billing-period materialization and wallet grant issuance inside the subscription lifecycle, then let queued ingestion call the subscription machine for a bounded catch-up under the existing subscription lock. After catch-up, reload entitlement context before Durable Object fanout.

**Tech Stack:** TypeScript, Vitest, pnpm workspace, Cloudflare queue ingestion, XState subscription machine, Drizzle/Postgres services.

---

## Current State

- Ingestion-side billing-period materialization has already been deleted. Do not re-add it to `internal/services/src/ingestion/entitlement-context.ts`.
- `IngestionEntitlement` still needs `subscriptionId` so ingestion can identify which subscription may need catch-up.
- Queue service wiring currently exposes entitlements to ingestion, but not subscriptions.

## File Structure

- Modify `internal/services/src/subscriptions/machine.ts`
  - Add `billingService.generateBillingPeriods` to the `activating` actor.
- Modify `internal/services/src/subscriptions/withLockedMachine.ts`
  - Pass `billingService` into `SubscriptionMachine.create`.
- Modify `internal/services/src/subscriptions/service.ts`
  - Pass the existing `this.billingService` into locked machine runs.
- Modify `internal/services/src/subscriptions/machine.test.ts`
  - Prove activation after renewal materializes billing periods.
- Modify `internal/services/src/ingestion/entitlement-context.ts`
  - Preserve `subscriptionId` on prepared ingestion entitlements.
- Modify `internal/services/src/ingestion/entitlement-context.test.ts`
  - Prove `subscriptionId` is mapped from customer entitlements.
- Create `internal/services/src/ingestion/subscription-catchup.ts`
  - Detect subscription-backed usage messages without a covering billing period and call `renewSubscription`.
- Create `internal/services/src/ingestion/subscription-catchup.test.ts`
  - Prove catch-up renews only when needed and propagates lock/race failures.
- Modify `internal/services/src/ingestion/customer-group-processor.ts`
  - Run catch-up after the first context load and reload context when catch-up changed lifecycle state.
- Modify `internal/services/src/ingestion/customer-group-processor.test.ts`
  - Prove context is reloaded before processing after catch-up.
- Modify `internal/services/src/ingestion/service.ts`
  - Construct the catch-up helper when subscriptions are provided.
- Modify `apps/api/src/ingestion/service.ts`
  - Require `subscriptionService` from API composition and pass it to `IngestionService`.
- Modify `apps/api/src/ingestion/queue.ts`
  - Return `subscriptions` from queue service wiring.
- Modify `apps/api/src/middleware/init.ts`
  - Pass `svcCtx.subscriptions` into `createIngestionService`.
- Modify `apps/api/src/ingestion/service.factory.test.ts`
  - Pass a fake subscription service into the factory test.
- Modify `lessons.md`
  - Add the lifecycle catch-up rule under billing, wallets, and invoices.

## Task 1: Lifecycle Owns Billing-Period Materialization

**Files:**
- Modify: `internal/services/src/subscriptions/machine.test.ts`
- Modify: `internal/services/src/subscriptions/machine.ts`
- Modify: `internal/services/src/subscriptions/withLockedMachine.ts`
- Modify: `internal/services/src/subscriptions/service.ts`

- [ ] **Step 1: Write the failing lifecycle test**

In `internal/services/src/subscriptions/machine.test.ts`, add this import:

```ts
import type { BillingService } from "../billing/service"
```

Update the local `createMachine` helper input:

```ts
  const createMachine = async (input: {
    subscriptionId: string
    projectId: string
    now?: number
    db?: Database
    walletService?: WalletService
    billingService?: Pick<BillingService, "generateBillingPeriods">
  }) =>
    SubscriptionMachine.create({
      subscriptionId: input.subscriptionId,
      projectId: input.projectId,
      analytics: mockAnalytics,
      logger: mockLogger,
      now: input.now ?? Date.now(),
      customer: mockCustomerService,
      ratingService: mockRatingService,
      ledgerService: mockLedgerService,
      walletService: input.walletService,
      billingService:
        input.billingService ??
        ({
          generateBillingPeriods: vi.fn().mockResolvedValue(
            Ok({
              cyclesCreated: 0,
              phasesProcessed: 0,
            })
          ),
        } as Pick<BillingService, "generateBillingPeriods">),
      db: input.db ?? mockDb,
      repo: new DrizzleSubscriptionRepository(input.db ?? mockDb),
    })
```

Add this test near the other renewal tests:

```ts
  it("materializes billing periods when activation runs after renewal", async () => {
    const { sub, now } = buildMockSubscription({
      status: "active",
      autoRenew: true,
      trialEnded: true,
      whenToBill: "pay_in_advance",
    })
    sub.currentCycleEndAt = now - 1_000
    sub.renewAt = now - 1_000
    sub.phases[0]!.currentCycleEndAt = now - 1_000
    sub.phases[0]!.renewAt = now - 1_000
    setupDbMocks(sub)

    const generateBillingPeriods = vi.fn().mockResolvedValue(
      Ok({
        cyclesCreated: 1,
        phasesProcessed: 1,
      })
    )

    const created = await createMachine({
      subscriptionId: sub.id,
      projectId: sub.projectId,
      now,
      billingService: { generateBillingPeriods },
    })
    expect(created.err).toBeUndefined()
    if (created.err) return

    const machine = created.val
    const result = await machine.renew()

    expect(result.err).toBeUndefined()
    expect(generateBillingPeriods).toHaveBeenCalledWith({
      subscriptionId: sub.id,
      projectId: sub.projectId,
      now,
    })

    await machine.shutdown()
  })
```

- [ ] **Step 2: Run the failing lifecycle test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/subscriptions/machine.test.ts -t "materializes billing periods when activation runs after renewal"
```

Expected: FAIL because `SubscriptionMachine.create` does not accept `billingService` yet and the activating actor does not call `generateBillingPeriods`.

- [ ] **Step 3: Add billing service to the machine**

In `internal/services/src/subscriptions/machine.ts`, add this import:

```ts
import type { BillingService } from "../billing/service"
```

Add the private field:

```ts
  private billingService: Pick<BillingService, "generateBillingPeriods">
```

Add `billingService` to the constructor destructuring and parameter type:

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

Add `billingService` to `SubscriptionMachine.create` payload:

```ts
    billingService: Pick<BillingService, "generateBillingPeriods">
```

- [ ] **Step 4: Materialize periods inside activation**

In the `activateSubscription` actor input type in `internal/services/src/subscriptions/machine.ts`, add:

```ts
              billingService: Pick<BillingService, "generateBillingPeriods">
```

Pass the field into the actor input:

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

At the top of the `activateSubscription` actor body, before the `walletService` no-op branch, add:

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

- [ ] **Step 5: Pass billing through locked machine runs**

In `internal/services/src/subscriptions/withLockedMachine.ts`, add:

```ts
import type { BillingService } from "../billing/service"
```

Add the argument type:

```ts
  billingService: Pick<BillingService, "generateBillingPeriods">
```

Destructure it:

```ts
    billingService,
```

Pass it into `SubscriptionMachine.create`:

```ts
      billingService,
```

In `internal/services/src/subscriptions/service.ts`, pass the existing service field into `withLockedMachine`:

```ts
        billingService: this.billingService,
```

- [ ] **Step 6: Run the lifecycle test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/subscriptions/machine.test.ts -t "materializes billing periods when activation runs after renewal"
```

Expected: PASS.

- [ ] **Step 7: Commit lifecycle ownership**

```bash
git add internal/services/src/subscriptions/machine.ts internal/services/src/subscriptions/withLockedMachine.ts internal/services/src/subscriptions/service.ts internal/services/src/subscriptions/machine.test.ts
git commit -m "fix: materialize billing periods during subscription activation"
```

## Task 2: Preserve Subscription Identity In Ingestion Context

**Files:**
- Modify: `internal/services/src/ingestion/entitlement-context.test.ts`
- Modify: `internal/services/src/ingestion/entitlement-context.ts`

- [ ] **Step 1: Write the failing mapper assertion**

In `internal/services/src/ingestion/entitlement-context.test.ts`, update the mapper test setup:

```ts
    const entitlement = createEntitlement({
      subscriptionId: "sub_123",
      subscriptionItemId: "si_123",
      grants: [
        {
          allowanceUnits: null,
          effectiveAt: TEST_NOW - 1_000,
          expiresAt: TEST_NOW + 1_000,
          grantId: "grant_unlimited",
          priority: 20,
        },
      ],
    })
```

Update the expected object in that test:

```ts
      subscriptionId: "sub_123",
      subscriptionItemId: "si_123",
```

- [ ] **Step 2: Run the failing mapper test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/entitlement-context.test.ts -t "maps customer entitlement records into ingestion entitlements"
```

Expected: FAIL because `toIngestionEntitlement` does not expose `subscriptionId`.

- [ ] **Step 3: Add subscription id to prepared entitlements**

In `internal/services/src/ingestion/entitlement-context.ts`, add this optional field to `IngestionEntitlement`:

```ts
  subscriptionId?: string | null
```

In `toIngestionEntitlement`, add:

```ts
    subscriptionId: entitlement.subscriptionId,
```

In `internal/services/src/ingestion/entitlement-context.test.ts`, update the test factory record mapping:

```ts
    subscriptionId: entitlement.subscriptionId ?? null,
    subscriptionItemId: entitlement.subscriptionItemId,
```

- [ ] **Step 4: Run the mapper test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/entitlement-context.test.ts -t "maps customer entitlement records into ingestion entitlements"
```

Expected: PASS.

- [ ] **Step 5: Commit subscription identity mapping**

```bash
git add internal/services/src/ingestion/entitlement-context.ts internal/services/src/ingestion/entitlement-context.test.ts
git commit -m "fix: preserve subscription id in ingestion context"
```

## Task 3: Add Subscription Catch-Up Helper

**Files:**
- Create: `internal/services/src/ingestion/subscription-catchup.ts`
- Create: `internal/services/src/ingestion/subscription-catchup.test.ts`

- [ ] **Step 1: Add the helper tests**

Create `internal/services/src/ingestion/subscription-catchup.test.ts`:

```ts
import type { Subscription } from "@unprice/db/validators"
import { describe, expect, it, vi } from "vitest"
import type { IngestionEntitlement } from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"
import {
  IngestionSubscriptionCatchUp,
  type IngestionSubscriptionCatchUpService,
} from "./subscription-catchup"

const TEST_NOW = Date.UTC(2026, 5, 12, 13, 49, 10)

describe("IngestionSubscriptionCatchUp", () => {
  it("renews a subscription-backed usage entitlement when no billing period covers the event", async () => {
    const renewSubscription = vi.fn().mockResolvedValue({ val: { status: "active" } })
    const getSubscriptionData = vi.fn().mockResolvedValue(
      createSubscription({
        currentCycleEndAt: TEST_NOW - 1_000,
        renewAt: TEST_NOW - 1_000,
      })
    )
    const catchUp = createCatchUp({ getSubscriptionData, renewSubscription })

    const result = await catchUp.catchUpForPreparedGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [createMessage()],
      candidateEntitlements: [
        createEntitlement({
          subscriptionId: "sub_123",
          billingPeriods: [],
        }),
      ],
    })

    expect(result).toEqual({
      changed: true,
      renewedSubscriptionIds: ["sub_123"],
    })
    expect(getSubscriptionData).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
    })
    expect(renewSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: TEST_NOW,
    })
  })

  it("does not load subscriptions when a billing period already covers the event", async () => {
    const getSubscriptionData = vi.fn()
    const renewSubscription = vi.fn()
    const catchUp = createCatchUp({ getSubscriptionData, renewSubscription })

    const result = await catchUp.catchUpForPreparedGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [createMessage()],
      candidateEntitlements: [
        createEntitlement({
          subscriptionId: "sub_123",
          billingPeriods: [
            {
              billingPeriodId: "bp_123",
              cycleStartAt: TEST_NOW - 1_000,
              cycleEndAt: TEST_NOW + 1_000,
              featurePlanVersionItemId: "si_123",
              statementKey: "sub_123:2026-06",
            },
          ],
        }),
      ],
    })

    expect(result).toEqual({
      changed: false,
      renewedSubscriptionIds: [],
    })
    expect(getSubscriptionData).not.toHaveBeenCalled()
    expect(renewSubscription).not.toHaveBeenCalled()
  })

  it("propagates subscription lock failures so the queue message can retry", async () => {
    const catchUp = createCatchUp({
      getSubscriptionData: vi.fn().mockResolvedValue(
        createSubscription({
          currentCycleEndAt: TEST_NOW - 1_000,
          renewAt: TEST_NOW - 1_000,
        })
      ),
      renewSubscription: vi.fn().mockResolvedValue({ err: new Error("SUBSCRIPTION_BUSY") }),
    })

    await expect(
      catchUp.catchUpForPreparedGroup({
        customerId: "cus_123",
        projectId: "proj_123",
        messages: [createMessage()],
        candidateEntitlements: [createEntitlement({ subscriptionId: "sub_123" })],
      })
    ).rejects.toThrow("SUBSCRIPTION_BUSY")
  })
})

function createCatchUp(overrides: {
  getSubscriptionData: ReturnType<typeof vi.fn>
  renewSubscription: ReturnType<typeof vi.fn>
}) {
  return new IngestionSubscriptionCatchUp({
    logger: { info: vi.fn() },
    subscriptions: overrides as unknown as IngestionSubscriptionCatchUpService,
  })
}

function createMessage(overrides: Partial<IngestionQueueMessage> = {}): IngestionQueueMessage {
  return {
    version: 1,
    workspaceId: "ws_123",
    projectId: "proj_123",
    customerId: "cus_123",
    requestId: "req_123",
    receivedAt: TEST_NOW,
    idempotencyKey: "idem_123",
    id: "evt_123",
    slug: "usage.recorded",
    timestamp: TEST_NOW,
    properties: { amount: 1 },
    source: {
      environment: "test",
      apiKeyId: "key_123",
      sourceType: "api_key",
      sourceId: "key_123",
      sourceName: null,
    },
    ...overrides,
  }
}

function createEntitlement(overrides: Partial<IngestionEntitlement> = {}): IngestionEntitlement {
  return {
    billingPeriods: [],
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: TEST_NOW - 1_000,
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

function createSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_123",
    projectId: "proj_123",
    customerId: "cus_123",
    active: true,
    status: "active",
    currentCycleEndAt: TEST_NOW - 1_000,
    renewAt: TEST_NOW - 1_000,
    ...overrides,
  } as Subscription
}
```

- [ ] **Step 2: Run the failing helper tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/subscription-catchup.test.ts
```

Expected: FAIL because `subscription-catchup.ts` does not exist.

- [ ] **Step 3: Create the catch-up helper**

Create `internal/services/src/ingestion/subscription-catchup.ts`:

```ts
import type { Subscription } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import type { SubscriptionService } from "../subscriptions/service"
import type { IngestionCandidateEntitlements, IngestionEntitlement } from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"

export type IngestionSubscriptionCatchUpService = Pick<
  SubscriptionService,
  "getSubscriptionData" | "renewSubscription"
>

export type IngestionSubscriptionCatchUpResult = {
  changed: boolean
  renewedSubscriptionIds: string[]
}

export class IngestionSubscriptionCatchUp {
  private readonly logger: Pick<Logger, "info">
  private readonly maxRenewalsPerSubscription: number
  private readonly subscriptions: IngestionSubscriptionCatchUpService

  constructor(opts: {
    logger: Pick<Logger, "info">
    maxRenewalsPerSubscription?: number
    subscriptions: IngestionSubscriptionCatchUpService
  }) {
    this.logger = opts.logger
    this.maxRenewalsPerSubscription = opts.maxRenewalsPerSubscription ?? 3
    this.subscriptions = opts.subscriptions
  }

  public async catchUpForPreparedGroup(params: {
    candidateEntitlements: IngestionCandidateEntitlements
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionSubscriptionCatchUpResult> {
    if (params.messages.length === 0) {
      return { changed: false, renewedSubscriptionIds: [] }
    }

    const eventAt = latestMessageTimestamp(params.messages)
    const subscriptionIds = collectSubscriptionIdsNeedingCatchUp({
      candidateEntitlements: params.candidateEntitlements,
      eventAt,
      messages: params.messages,
    })

    if (subscriptionIds.length === 0) {
      return { changed: false, renewedSubscriptionIds: [] }
    }

    const renewedSubscriptionIds: string[] = []

    for (const subscriptionId of subscriptionIds) {
      const renewed = await this.catchUpSubscription({
        eventAt,
        projectId: params.projectId,
        subscriptionId,
      })

      if (renewed) {
        renewedSubscriptionIds.push(subscriptionId)
      }
    }

    if (renewedSubscriptionIds.length > 0) {
      this.logger.info("raw ingestion subscription catch-up", {
        projectId: params.projectId,
        customerId: params.customerId,
        renewed_subscription_count: renewedSubscriptionIds.length,
      })
    }

    return {
      changed: renewedSubscriptionIds.length > 0,
      renewedSubscriptionIds,
    }
  }

  private async catchUpSubscription(params: {
    eventAt: number
    projectId: string
    subscriptionId: string
  }): Promise<boolean> {
    let changed = false

    for (let attempt = 0; attempt < this.maxRenewalsPerSubscription; attempt++) {
      const subscription = await this.subscriptions.getSubscriptionData({
        subscriptionId: params.subscriptionId,
        projectId: params.projectId,
      })

      if (!subscriptionNeedsRenewal(subscription, params.eventAt)) {
        return changed
      }

      const result = await this.subscriptions.renewSubscription({
        subscriptionId: params.subscriptionId,
        projectId: params.projectId,
        now: params.eventAt,
      })

      if (result.err) {
        throw result.err
      }

      changed = true
    }

    return changed
  }
}

function collectSubscriptionIdsNeedingCatchUp(params: {
  candidateEntitlements: IngestionCandidateEntitlements
  eventAt: number
  messages: IngestionQueueMessage[]
}): string[] {
  const eventSlugs = new Set(params.messages.map((message) => message.slug))
  const subscriptionIds = new Set<string>()

  for (const entitlement of params.candidateEntitlements) {
    if (!isRelevantUsageEntitlement(entitlement, eventSlugs)) {
      continue
    }

    if (hasBillingPeriodCovering(entitlement, params.eventAt)) {
      continue
    }

    if (typeof entitlement.subscriptionId === "string" && entitlement.subscriptionId.length > 0) {
      subscriptionIds.add(entitlement.subscriptionId)
    }
  }

  return [...subscriptionIds]
}

function isRelevantUsageEntitlement(
  entitlement: IngestionEntitlement,
  eventSlugs: Set<string>
): boolean {
  return (
    entitlement.featureType === "usage" &&
    entitlement.meterConfig !== null &&
    eventSlugs.has(entitlement.meterConfig.eventSlug)
  )
}

function hasBillingPeriodCovering(entitlement: IngestionEntitlement, eventAt: number): boolean {
  return entitlement.billingPeriods.some(
    (period) => period.cycleStartAt <= eventAt && eventAt < period.cycleEndAt
  )
}

function subscriptionNeedsRenewal(subscription: Subscription | null, eventAt: number): boolean {
  if (!subscription?.active) {
    return false
  }

  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return false
  }

  const renewAt = subscription.renewAt ?? subscription.currentCycleEndAt

  return typeof renewAt === "number" && eventAt >= renewAt
}

function latestMessageTimestamp(messages: IngestionQueueMessage[]): number {
  return messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0)
}
```

- [ ] **Step 4: Run the helper tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/subscription-catchup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper**

```bash
git add internal/services/src/ingestion/subscription-catchup.ts internal/services/src/ingestion/subscription-catchup.test.ts
git commit -m "feat: add ingestion subscription catch-up helper"
```

## Task 4: Wire Catch-Up Into Queue Processing

**Files:**
- Modify: `internal/services/src/ingestion/customer-group-processor.test.ts`
- Modify: `internal/services/src/ingestion/customer-group-processor.ts`
- Modify: `internal/services/src/ingestion/service.ts`
- Modify: `apps/api/src/ingestion/service.ts`
- Modify: `apps/api/src/ingestion/queue.ts`
- Modify: `apps/api/src/middleware/init.ts`
- Modify: `apps/api/src/ingestion/service.factory.test.ts`

- [ ] **Step 1: Add the processor reload test**

In `internal/services/src/ingestion/customer-group-processor.test.ts`, add this test:

```ts
  it("reloads prepared context after subscription catch-up changes lifecycle state", async () => {
    const message = createMessage()
    const firstPreparedGroup = {
      candidateEntitlements: [
        {
          customerEntitlementId: "ce_before",
          featureType: "usage",
          meterConfig: { eventSlug: "usage.recorded" },
          billingPeriods: [],
          subscriptionId: "sub_123",
        } as never,
      ],
      messages: [message],
    }
    const secondPreparedGroup = {
      candidateEntitlements: [{ customerEntitlementId: "ce_after" } as never],
      messages: [message],
    }
    const prepareCustomerMessageGroup = vi
      .fn()
      .mockResolvedValueOnce(firstPreparedGroup)
      .mockResolvedValueOnce(secondPreparedGroup)
    const catchUpForPreparedGroup = vi.fn().mockResolvedValue({
      changed: true,
      renewedSubscriptionIds: ["sub_123"],
    })
    const preparedProcess = vi.fn().mockResolvedValue([
      {
        message,
        outcome: { state: "processed" },
      },
    ])

    const processor = createProcessor({
      preparedProcess,
      prepareCustomerMessageGroup,
      subscriptionCatchUp: { catchUpForPreparedGroup },
    })

    await processor.processCustomerGroup({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
    })

    expect(catchUpForPreparedGroup).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      messages: [message],
      candidateEntitlements: firstPreparedGroup.candidateEntitlements,
    })
    expect(prepareCustomerMessageGroup).toHaveBeenCalledTimes(2)
    expect(preparedProcess).toHaveBeenCalledWith({
      candidateEntitlements: secondPreparedGroup.candidateEntitlements,
      customerId: "cus_123",
      messages: [message],
      projectId: "proj_123",
      rejectionReason: undefined,
    })
  })
```

Update the local `createProcessor` helper override type:

```ts
    subscriptionCatchUp?: {
      catchUpForPreparedGroup: ReturnType<typeof vi.fn>
    }
```

Pass it into `new IngestionCustomerGroupProcessor`:

```ts
    subscriptionCatchUp: overrides.subscriptionCatchUp,
```

- [ ] **Step 2: Run the failing processor test**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/customer-group-processor.test.ts -t "reloads prepared context after subscription catch-up changes lifecycle state"
```

Expected: FAIL because `IngestionCustomerGroupProcessor` does not accept or call `subscriptionCatchUp`.

- [ ] **Step 3: Add catch-up to the customer group processor**

In `internal/services/src/ingestion/customer-group-processor.ts`, add this type:

```ts
type SubscriptionCatchUpProcessor = {
  catchUpForPreparedGroup(params: {
    candidateEntitlements: PreparedCustomerMessageGroup["candidateEntitlements"]
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<{ changed: boolean; renewedSubscriptionIds: string[] }>
}
```

Add the private field:

```ts
  private readonly subscriptionCatchUp: SubscriptionCatchUpProcessor | undefined
```

Add the constructor option:

```ts
    subscriptionCatchUp?: SubscriptionCatchUpProcessor
```

Assign it:

```ts
    this.subscriptionCatchUp = opts.subscriptionCatchUp
```

Change the first prepared group assignment in `processCustomerGroup` from `const` to `let`:

```ts
      let preparedGroup = await this.entitlementContext.prepareCustomerMessageGroup({
        customerId,
        messages: freshMessages,
        projectId,
      })
```

After the first customer-not-found return block and before `processFreshPreparedMessages`, add:

```ts
      const catchUpResult = await this.subscriptionCatchUp?.catchUpForPreparedGroup({
        customerId,
        projectId,
        messages: preparedGroup.messages,
        candidateEntitlements: preparedGroup.candidateEntitlements,
      })

      if (catchUpResult?.changed) {
        preparedGroup = await this.entitlementContext.prepareCustomerMessageGroup({
          customerId,
          messages: freshMessages,
          projectId,
        })
      }
```

- [ ] **Step 4: Wire the helper in the services package**

In `internal/services/src/ingestion/service.ts`, add:

```ts
import type { SubscriptionService } from "../subscriptions/service"
import { IngestionSubscriptionCatchUp } from "./subscription-catchup"
```

Add the constructor option:

```ts
    subscriptions?: Pick<SubscriptionService, "getSubscriptionData" | "renewSubscription">
```

Before creating `IngestionCustomerGroupProcessor`, add:

```ts
    const subscriptionCatchUp = opts.subscriptions
      ? new IngestionSubscriptionCatchUp({
          logger: opts.logger,
          subscriptions: opts.subscriptions,
        })
      : undefined
```

Pass it into the processor:

```ts
      subscriptionCatchUp,
```

- [ ] **Step 5: Wire subscriptions in API ingestion composition**

In `apps/api/src/ingestion/service.ts`, add:

```ts
import type { SubscriptionService } from "@unprice/services/subscriptions"
```

Add this field to `CreateIngestionServiceParams`:

```ts
  subscriptionService: Pick<SubscriptionService, "getSubscriptionData" | "renewSubscription">
```

Pass it into `new IngestionService`:

```ts
    subscriptions: params.subscriptionService,
```

In `consumeIngestionBatch`, pass:

```ts
    subscriptionService: services.subscriptions,
```

In `apps/api/src/ingestion/queue.ts`, update the return type:

```ts
}): Pick<ServiceContext, "entitlements" | "subscriptions"> & {
```

Return subscriptions:

```ts
    subscriptions: svcCtx.subscriptions,
```

In `apps/api/src/middleware/init.ts`, pass:

```ts
      subscriptionService: svcCtx.subscriptions,
```

In `apps/api/src/ingestion/service.factory.test.ts`, pass:

```ts
      subscriptionService: {
        getSubscriptionData: vi.fn(),
        renewSubscription: vi.fn(),
      } as never,
```

- [ ] **Step 6: Run the focused wiring tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/ingestion/subscription-catchup.test.ts src/ingestion/customer-group-processor.test.ts src/ingestion/entitlement-context.test.ts
pnpm --filter api test src/ingestion/service.factory.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit queue catch-up wiring**

```bash
git add internal/services/src/ingestion/customer-group-processor.ts internal/services/src/ingestion/customer-group-processor.test.ts internal/services/src/ingestion/service.ts apps/api/src/ingestion/service.ts apps/api/src/ingestion/queue.ts apps/api/src/middleware/init.ts apps/api/src/ingestion/service.factory.test.ts
git commit -m "fix: catch up subscription renewals before usage fanout"
```

## Task 5: Verify And Record The Repo Lesson

**Files:**
- Modify: `lessons.md`

- [ ] **Step 1: Run focused service and API tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/subscriptions/machine.test.ts src/ingestion/entitlement-context.test.ts src/ingestion/subscription-catchup.test.ts src/ingestion/customer-group-processor.test.ts
pnpm --filter api test src/ingestion/service.factory.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full validation**

Run:

```bash
pnpm validate
```

Expected: PASS.

- [ ] **Step 3: Add the lesson**

In `lessons.md`, under the billing, wallets, and invoices section, add:

```md
### 2026-06-12: Queued usage ingestion may catch up subscription renewals, but entitlement context stays read-only.

- Billing-period generation and wallet grant issuance belong to the subscription lifecycle. If queued ingestion sees subscription-backed usage past the funded billing window, call the subscription machine under its existing lock, then reload entitlement context before fanout.
- Do not add billing-period writes to `internal/services/src/ingestion/entitlement-context.ts`; that loader reads/cachees entitlements and billing contexts only.
```

- [ ] **Step 4: Commit verification notes**

```bash
git add lessons.md
git commit -m "docs: record ingestion subscription catch-up rule"
```
