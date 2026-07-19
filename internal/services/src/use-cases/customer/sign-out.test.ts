import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"

import type { ServiceContext } from "../../context"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import { signOutCustomer } from "./sign-out"

function createDeps({
  activeSubscriptions,
  cancelResults,
}: {
  activeSubscriptions: Array<{ id: string }>
  cancelResults?: Record<string, unknown>
}) {
  const subscriptions = {
    listActiveSubscriptions: vi.fn().mockResolvedValue(activeSubscriptions),
    cancelSubscription: vi.fn(({ subscriptionId }: { subscriptionId: string }) => {
      return Promise.resolve(cancelResults?.[subscriptionId] ?? Ok({ id: subscriptionId }))
    }),
  }

  const customers = {
    deactivate: vi.fn().mockResolvedValue(Ok({ success: true })),
  }

  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger

  return {
    deps: {
      services: { subscriptions, customers } as unknown as Pick<
        ServiceContext,
        "subscriptions" | "customers"
      >,
      logger,
    },
    subscriptions,
    customers,
    logger,
  }
}

describe("signOutCustomer", () => {
  it("cancels every active subscription then deactivates the customer", async () => {
    const { deps, subscriptions, customers } = createDeps({
      activeSubscriptions: [{ id: "sub_1" }, { id: "sub_2" }],
    })

    const result = await signOutCustomer(deps, {
      customerId: "cus_1",
      projectId: "proj_1",
      now: 1_700_000_000_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ success: true })
    expect(subscriptions.cancelSubscription).toHaveBeenCalledTimes(2)
    expect(subscriptions.cancelSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: 1_700_000_000_000,
    })
    expect(customers.deactivate).toHaveBeenCalledWith({
      customerId: "cus_1",
      projectId: "proj_1",
    })
  })

  it("deactivates the customer when there are no active subscriptions", async () => {
    const { deps, subscriptions, customers } = createDeps({ activeSubscriptions: [] })

    const result = await signOutCustomer(deps, {
      customerId: "cus_1",
      projectId: "proj_1",
      now: 1_700_000_000_000,
    })

    expect(result.err).toBeUndefined()
    expect(subscriptions.cancelSubscription).not.toHaveBeenCalled()
    expect(customers.deactivate).toHaveBeenCalledTimes(1)
  })

  it("skips subscriptions a concurrent cancel already deactivated", async () => {
    const { deps, customers, logger } = createDeps({
      activeSubscriptions: [{ id: "sub_1" }, { id: "sub_2" }],
      cancelResults: {
        sub_1: Err(
          new UnPriceSubscriptionError({
            code: "SUBSCRIPTION_NOT_ACTIVE",
            message: "Subscription is not active",
          })
        ),
      },
    })

    const result = await signOutCustomer(deps, {
      customerId: "cus_1",
      projectId: "proj_1",
      now: 1_700_000_000_000,
    })

    expect(result.err).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(customers.deactivate).toHaveBeenCalledTimes(1)
  })

  it("returns the error and keeps the customer active when a cancel fails", async () => {
    const cancelError = new UnPriceSubscriptionError({
      code: "SUBSCRIPTION_OPERATION_FAILED",
      message: "phase update failed",
    })
    const { deps, customers, logger } = createDeps({
      activeSubscriptions: [{ id: "sub_1" }, { id: "sub_2" }],
      cancelResults: { sub_1: Err(cancelError) },
    })

    const result = await signOutCustomer(deps, {
      customerId: "cus_1",
      projectId: "proj_1",
      now: 1_700_000_000_000,
    })

    expect(result.err).toBe(cancelError)
    expect(customers.deactivate).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(cancelError, {
      customerId: "cus_1",
      projectId: "proj_1",
      subscriptionId: "sub_1",
      context: "signOutCustomer cancel subscription",
    })
  })
})
