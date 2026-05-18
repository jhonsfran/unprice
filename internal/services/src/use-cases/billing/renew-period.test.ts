import type { Customer, Subscription, SubscriptionPhaseExtended } from "@unprice/db/validators"
import { calculateCycleWindow } from "@unprice/db/validators"
import { describe, expect, it, vi } from "vitest"
import type { SubscriptionContext } from "../../subscriptions/types"
import { renewPeriod } from "./renew-period"

// Helpers
const JAN_1_2026 = new Date("2026-01-01T00:00:00Z").getTime()

function makePhase(overrides?: { endAt?: number | null }) {
  return {
    trialEndsAt: null,
    endAt: overrides?.endAt ?? null,
    startAt: JAN_1_2026,
    billingAnchor: JAN_1_2026,
    planVersion: {
      billingConfig: {
        name: "monthly",
        billingInterval: "month" as const,
        billingIntervalCount: 1,
        planType: "recurring" as const,
      },
      plan: { slug: "pro" },
    },
  }
}

function makeSubscription(
  overrides?: Partial<{
    currentCycleStartAt: number
    currentCycleEndAt: number
    renewAt: number
  }>
) {
  return {
    id: "sub_1",
    projectId: "proj_1",
    currentCycleStartAt: overrides?.currentCycleStartAt ?? 0,
    currentCycleEndAt: overrides?.currentCycleEndAt ?? 0,
    renewAt: overrides?.renewAt ?? 0,
  }
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof renewPeriod>[0]["logger"]
}

function makeRepo(returnValue: unknown = { id: "sub_1", projectId: "proj_1" }) {
  return {
    updateSubscription: vi.fn().mockResolvedValue(returnValue),
  } as unknown as Parameters<typeof renewPeriod>[0]["repo"]
}

function makeCustomerService() {
  return {} as unknown as Parameters<typeof renewPeriod>[0]["customerService"]
}

function makeRenewContext(input: {
  subscription?: ReturnType<typeof makeSubscription>
  currentPhase: ReturnType<typeof makePhase> | null
  now: number
}): SubscriptionContext {
  const subscription = input.subscription ?? makeSubscription()

  return {
    subscriptionId: subscription.id,
    projectId: subscription.projectId,
    subscription: subscription as unknown as Subscription,
    customer: { id: "cust_1", projectId: subscription.projectId } as unknown as Customer,
    paymentMethodId: null,
    requiredPaymentMethod: false,
    currentPhase: input.currentPhase as unknown as SubscriptionPhaseExtended | null,
    now: input.now,
  }
}

describe("renewPeriod", () => {
  it("advances cycle window on happy path", async () => {
    const phase = makePhase()
    const now = JAN_1_2026 + 1000 // during Jan cycle

    const current = calculateCycleWindow({
      now,
      trialEndsAt: null,
      effectiveEndDate: null,
      config: {
        name: "monthly",
        interval: "month",
        intervalCount: 1,
        planType: "recurring",
        anchor: JAN_1_2026,
      },
      effectiveStartDate: JAN_1_2026,
    })!

    const next = calculateCycleWindow({
      now: current.end + 1,
      trialEndsAt: null,
      effectiveEndDate: null,
      config: {
        name: "monthly",
        interval: "month",
        intervalCount: 1,
        planType: "recurring",
        anchor: JAN_1_2026,
      },
      effectiveStartDate: JAN_1_2026,
    })!

    const subscription = makeSubscription() // mismatched dates → triggers update
    const repo = makeRepo({
      ...subscription,
      renewAt: next.start,
      currentCycleStartAt: current.start,
      currentCycleEndAt: current.end,
    })

    const result = await renewPeriod({
      context: makeRenewContext({ subscription, currentPhase: phase, now }),
      logger: makeLogger(),
      customerService: makeCustomerService(),
      repo,
    })

    expect(repo.updateSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      projectId: "proj_1",
      data: {
        planSlug: "pro",
        renewAt: next.start,
        currentCycleStartAt: current.start,
        currentCycleEndAt: current.end,
      },
    })
    expect(result.currentCycleStartAt).toBe(current.start)
    expect(result.currentCycleEndAt).toBe(current.end)
  })

  it("returns no-op when subscription already at correct window", async () => {
    const phase = makePhase()
    const now = JAN_1_2026 + 1000

    const current = calculateCycleWindow({
      now,
      trialEndsAt: null,
      effectiveEndDate: null,
      config: {
        name: "monthly",
        interval: "month",
        intervalCount: 1,
        planType: "recurring",
        anchor: JAN_1_2026,
      },
      effectiveStartDate: JAN_1_2026,
    })!

    const next = calculateCycleWindow({
      now: current.end + 1,
      trialEndsAt: null,
      effectiveEndDate: null,
      config: {
        name: "monthly",
        interval: "month",
        intervalCount: 1,
        planType: "recurring",
        anchor: JAN_1_2026,
      },
      effectiveStartDate: JAN_1_2026,
    })!

    const subscription = makeSubscription({
      currentCycleStartAt: current.start,
      currentCycleEndAt: current.end,
      renewAt: next.start,
    })

    const repo = makeRepo()

    const result = await renewPeriod({
      context: makeRenewContext({ subscription, currentPhase: phase, now }),
      logger: makeLogger(),
      customerService: makeCustomerService(),
      repo,
    })

    expect(repo.updateSubscription).not.toHaveBeenCalled()
    expect(result.subscription).toBe(subscription)
    expect(result.renewAt).toBe(next.start)
  })

  it("throws when no active phase", async () => {
    await expect(
      renewPeriod({
        context: makeRenewContext({ currentPhase: null, now: JAN_1_2026 }),
        logger: makeLogger(),
        customerService: makeCustomerService(),
        repo: makeRepo(),
      })
    ).rejects.toThrow("No active phase found")
  })

  it("throws when no current cycle window found", async () => {
    // Use a now before the phase start to get null window
    const phase = makePhase()
    // set startAt far in the future so now is before it
    const brokenPhase = { ...phase, startAt: JAN_1_2026 + 999_999_999_999 }

    await expect(
      renewPeriod({
        context: makeRenewContext({ currentPhase: brokenPhase, now: JAN_1_2026 }),
        logger: makeLogger(),
        customerService: makeCustomerService(),
        repo: makeRepo(),
      })
    ).rejects.toThrow(/cycle window/i)
  })

  it("throws when repo returns null", async () => {
    const phase = makePhase()
    const now = JAN_1_2026 + 1000
    const repo = makeRepo(null)

    await expect(
      renewPeriod({
        context: makeRenewContext({ currentPhase: phase, now }),
        logger: makeLogger(),
        customerService: makeCustomerService(),
        repo,
      })
    ).rejects.toThrow("Subscription not updated")
  })

  it("respects phase endAt in cycle calculation", async () => {
    const FEB_1_2026 = new Date("2026-02-01T00:00:00Z").getTime()
    const phase = makePhase({ endAt: FEB_1_2026 })
    const now = JAN_1_2026 + 1000

    const repo = makeRepo({ id: "sub_1", projectId: "proj_1" })

    const _result = await renewPeriod({
      context: makeRenewContext({ currentPhase: phase, now }),
      logger: makeLogger(),
      customerService: makeCustomerService(),
      repo,
    })

    // The update should have been called with the endAt-constrained window
    expect(repo.updateSubscription).toHaveBeenCalled()
    const updateCall = (repo.updateSubscription as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(updateCall).toBeDefined()
    const callData = updateCall.data
    // currentCycleEndAt should not exceed phase endAt
    expect(callData.currentCycleEndAt).toBeLessThanOrEqual(FEB_1_2026)
  })
})
