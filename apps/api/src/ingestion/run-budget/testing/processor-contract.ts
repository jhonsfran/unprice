import { describe, expect, it } from "vitest"
import type {
  ApplyRunSyncEventInput,
  EndRunInput,
  GetRunStatusInput,
  RunBudgetDecision,
  RunBudgetSummary,
  StartRunInput,
} from "../contracts"
import { RUN_BUDGET_TEST_NOW } from "./harness"

export type RunBudgetProcessorContractTarget = {
  startRun(input: StartRunInput): Promise<RunBudgetSummary>
  applySyncEvent(input: ApplyRunSyncEventInput): Promise<RunBudgetDecision>
  endRun(input: EndRunInput): Promise<RunBudgetSummary>
  getRunStatus(input: GetRunStatusInput): Promise<RunBudgetSummary>
  pricingCallCount(): number
}

export type RunBudgetProcessorContractHost = {
  target: RunBudgetProcessorContractTarget
  revive(): Promise<RunBudgetProcessorContractTarget>
}

export type RunBudgetProcessorContractHostFactory = () =>
  | RunBudgetProcessorContractHost
  | Promise<RunBudgetProcessorContractHost>

export function createRunBudgetStartInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    workloadType: "agent",
    workloadId: "agent_1",
    runId: "run_1",
    customerId: "cus_1",
    projectId: "proj_1",
    currency: "USD",
    budgetAmount: 10_000,
    idempotencyKey: "idem_start_1",
    metadata: { contract: true },
    now: RUN_BUDGET_TEST_NOW,
    ...overrides,
  }
}

export function createRunBudgetApplyInput(
  overrides: Partial<ApplyRunSyncEventInput> = {}
): ApplyRunSyncEventInput {
  return {
    runId: "run_1",
    customerId: "cus_1",
    projectId: "proj_1",
    featureSlug: "tokens",
    idempotencyKey: "idem_consume_1",
    event: {
      id: "evt_1",
      slug: "tokens_used",
      timestamp: RUN_BUDGET_TEST_NOW,
      properties: { amount: 5 },
    },
    source: {
      workspaceId: "ws_1",
      environment: "test",
      apiKeyId: "key_1",
      sourceType: "api_key",
      sourceId: "key_1",
      sourceName: null,
    },
    now: RUN_BUDGET_TEST_NOW,
    customerEntitlementId: "ce_test_1",
    entitlement: {
      billingPeriods: [
        {
          billingPeriodId: "bp_1",
          cycleEndAt: RUN_BUDGET_TEST_NOW + 86_400_000,
          cycleStartAt: RUN_BUDGET_TEST_NOW - 86_400_000,
          featurePlanVersionItemId: "item_1",
          statementKey: "stmt_1",
        },
      ],
      creditLinePolicy: "uncapped",
      customerEntitlementId: "ce_test_1",
      customerId: "cus_1",
      effectiveAt: RUN_BUDGET_TEST_NOW - 86_400_000,
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
      featurePlanVersionId: "fpv_1",
      featureSlug: "tokens",
      featureType: "usage",
      meterConfig: {
        eventSlug: "tokens_used",
        eventId: "meter_1",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
      overageStrategy: "none",
      projectId: "proj_1",
      resetConfig: null,
      subscriptionItemId: null,
    },
    grants: [
      {
        allowanceUnits: 1_000,
        cadenceEffectiveAt: RUN_BUDGET_TEST_NOW - 86_400_000,
        cadenceExpiresAt: null,
        currencyCode: "USD",
        effectiveAt: RUN_BUDGET_TEST_NOW - 86_400_000,
        expiresAt: null,
        grantId: "grant_1",
        priority: 0,
        resetConfig: null,
      },
    ],
    ...overrides,
  }
}

export function describeRunBudgetProcessorContract(
  suiteName: string,
  createHost: RunBudgetProcessorContractHostFactory
): void {
  describe(suiteName, () => {
    it("starts, consumes, replays idempotently, and ends a run", async () => {
      const { target } = await createHost()
      await expect(target.startRun(createRunBudgetStartInput())).resolves.toMatchObject({
        runId: "run_1",
        status: "running",
        consumedAmount: 0,
        remainingAmount: 10_000,
      })

      const input = createRunBudgetApplyInput()
      const first = await target.applySyncEvent(input)
      const replay = await target.applySyncEvent(input)
      expect(first).toMatchObject({
        allowed: true,
        state: "processed",
        budget: { consumedAmount: 5_000, remainingAmount: 5_000 },
      })
      expect(replay).toEqual(first)
      expect(target.pricingCallCount()).toBe(1)

      await expect(
        target.endRun({
          runId: "run_1",
          customerId: "cus_1",
          projectId: "proj_1",
          status: "completed",
          endedAt: RUN_BUDGET_TEST_NOW + 1_000,
        })
      ).resolves.toMatchObject({ status: "completed", consumedAmount: 5_000 })
    })

    it("denies spend above the remaining run budget without mutating spend", async () => {
      const { target } = await createHost()
      await target.startRun(createRunBudgetStartInput({ budgetAmount: 4_000 }))
      await expect(target.applySyncEvent(createRunBudgetApplyInput())).resolves.toMatchObject({
        allowed: false,
        state: "rejected",
        rejectionReason: "RUN_BUDGET_EXCEEDED",
        budget: { consumedAmount: 0, remainingAmount: 4_000 },
      })
      await expect(
        target.getRunStatus({ runId: "run_1", customerId: "cus_1", projectId: "proj_1" })
      ).resolves.toMatchObject({ consumedAmount: 0, remainingAmount: 4_000 })
    })

    it("persists run state and replay decisions across host revival", async () => {
      const host = await createHost()
      await host.target.startRun(createRunBudgetStartInput())
      const decision = await host.target.applySyncEvent(createRunBudgetApplyInput())
      const revived = await host.revive()

      await expect(
        revived.getRunStatus({ runId: "run_1", customerId: "cus_1", projectId: "proj_1" })
      ).resolves.toMatchObject({ status: "running", consumedAmount: 5_000 })
      await expect(revived.applySyncEvent(createRunBudgetApplyInput())).resolves.toEqual(decision)
      expect(revived.pricingCallCount()).toBe(1)
    })
  })
}
