import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"

import type { ServiceContext } from "../../context"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import { activateWalletIfSubscriptionIsActive } from "./activate-wallet-if-active"

function createDeps({
  status,
  activateResult,
}: {
  status: string | null
  activateResult?: unknown
}) {
  const subscriptions = {
    getSubscriptionData: vi.fn().mockResolvedValue(status ? { status } : null),
    activateWallet: vi.fn().mockResolvedValue(activateResult ?? { val: { status: "active" } }),
  }

  const logger = {
    error: vi.fn(),
  } as unknown as Logger

  return {
    deps: {
      services: { subscriptions } as unknown as Pick<ServiceContext, "subscriptions">,
      logger,
    },
    subscriptions,
    logger,
  }
}

describe("activateWalletIfSubscriptionIsActive", () => {
  it("activates the wallet for active subscriptions", async () => {
    const { deps, subscriptions } = createDeps({ status: "active" })

    await activateWalletIfSubscriptionIsActive(deps, {
      subscriptionId: "sub_123",
      projectId: "proj_123",
      context: "test activation",
    })

    expect(subscriptions.activateWallet).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: expect.any(Number),
    })
  })

  it("does not activate inactive subscriptions", async () => {
    const { deps, subscriptions } = createDeps({ status: "pending_payment" })

    await activateWalletIfSubscriptionIsActive(deps, {
      subscriptionId: "sub_123",
      projectId: "proj_123",
      context: "test activation",
    })

    expect(subscriptions.activateWallet).not.toHaveBeenCalled()
  })

  it("logs activation failures without throwing", async () => {
    const activationError = new UnPriceSubscriptionError({ message: "activation failed" })
    const { deps, logger } = createDeps({
      status: "active",
      activateResult: { err: activationError },
    })

    await activateWalletIfSubscriptionIsActive(deps, {
      subscriptionId: "sub_123",
      projectId: "proj_123",
      context: "test activation",
    })

    expect(logger.error).toHaveBeenCalledWith(activationError, {
      subscriptionId: "sub_123",
      projectId: "proj_123",
      context: "test activation",
    })
  })
})
