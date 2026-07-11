import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import { vi } from "vitest"
import type {
  RunBudgetPricingInput,
  RunBudgetPricingResult,
  RunBudgetStore,
  RunBudgetWalletOps,
} from "../ports"
import { RunBudgetProcessor } from "../processor"
import { InMemoryRunBudgetStore } from "./in-memory-store"

export const RUN_BUDGET_TEST_NOW = Date.UTC(2026, 2, 19, 12)

export function createRunBudgetMeterFact(
  overrides: Partial<AnalyticsEntitlementMeterFact> = {}
): AnalyticsEntitlementMeterFact {
  return {
    event_id: "evt_1",
    idempotency_key: "idem_event_1:ew",
    workspace_id: "ws_1",
    project_id: "proj_1",
    customer_id: "cus_1",
    environment: "test",
    api_key_id: "key_1",
    source_type: "api_key",
    source_id: "key_1",
    source_name: null,
    customer_entitlement_id: "ce_test_1",
    feature_slug: "tokens",
    period_key: "period_1",
    event_slug: "tokens_used",
    aggregation_method: "sum",
    timestamp: RUN_BUDGET_TEST_NOW,
    created_at: RUN_BUDGET_TEST_NOW,
    delta: 5,
    value_after: 5,
    grant_id: "grant_1",
    feature_plan_version_id: "fpv_1",
    amount: 5_000,
    amount_after: 5_000,
    amount_scale: 8,
    currency: "USD",
    priced_at: RUN_BUDGET_TEST_NOW,
    tier_index: null,
    tier_mode: null,
    pricing_component_count: 1,
    ...overrides,
  }
}

export function createRunBudgetProcessorHarness(
  options: {
    now?: number
    schedulerFailures?: number
    store?: RunBudgetStore
  } = {}
) {
  const state = {
    now: options.now ?? RUN_BUDGET_TEST_NOW,
    alarmAt: null as number | null,
    schedulerFailuresRemaining: options.schedulerFailures ?? 0,
  }
  const store = options.store ?? new InMemoryRunBudgetStore()
  const createReservation = vi.fn(
    async (_input: Parameters<RunBudgetWalletOps["createReservation"]>[0]) => ({
      val: { reservationId: "res_test_123", allocationAmount: 100_000 },
    })
  )
  const captureReservationUsage = vi.fn(
    async (_input: Parameters<RunBudgetWalletOps["captureReservationUsage"]>[0]) => ({
      val: { capturedAmount: 0 },
    })
  )
  const releaseReservation = vi.fn(
    async (_input: Parameters<RunBudgetWalletOps["releaseReservation"]>[0]) => ({
      val: { releasedAmount: 0, restoredGrantedAmount: 0, refundedPurchasedAmount: 0 },
    })
  )
  const wallet = {
    createReservation,
    captureReservationUsage,
    releaseReservation,
  } satisfies RunBudgetWalletOps
  const walletCreate = vi.fn(async () => wallet)
  const pricingApply = vi.fn(
    async (input: RunBudgetPricingInput): Promise<RunBudgetPricingResult> => {
      const fact = createRunBudgetMeterFact()
      if (fact.amount > input.wallet.remainingAmount) {
        return {
          allowed: false,
          deniedReason: "RUN_BUDGET_EXCEEDED",
          message: "Run budget exceeded",
          meterFacts: [],
        }
      }
      return { allowed: true, meterFacts: [fact] }
    }
  )
  const logger = { error: vi.fn() }
  const schedulerSetAlarm = vi.fn(async (at: number) => {
    if (state.schedulerFailuresRemaining > 0) {
      state.schedulerFailuresRemaining--
      throw new Error("scheduler unavailable")
    }
    state.alarmAt = at
  })

  const createProcessor = () =>
    new RunBudgetProcessor({
      clock: { now: () => state.now },
      logger,
      pricing: { apply: pricingApply },
      scheduler: {
        getAlarm: async () => state.alarmAt,
        setAlarm: schedulerSetAlarm,
      },
      store,
      wallet: { create: walletCreate },
    })

  return {
    captureReservationUsage,
    createProcessor,
    createReservation,
    logger,
    pricingApply,
    processor: createProcessor(),
    releaseReservation,
    schedulerSetAlarm,
    state,
    store,
    walletCreate,
  }
}
