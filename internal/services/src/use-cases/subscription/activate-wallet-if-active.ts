import type { Logger } from "@unprice/logs"

import type { ServiceContext } from "../../context"

type ActivateWalletIfActiveDeps = {
  services: Pick<ServiceContext, "subscriptions">
  logger: Logger
}

export async function activateWalletIfSubscriptionIsActive(
  deps: ActivateWalletIfActiveDeps,
  {
    subscriptionId,
    projectId,
    context,
  }: {
    subscriptionId: string
    projectId: string
    context: string
  }
): Promise<boolean> {
  const refreshed = await deps.services.subscriptions.getSubscriptionData({
    subscriptionId,
    projectId,
  })

  if (refreshed?.status !== "active") {
    return false
  }

  const activateResult = await deps.services.subscriptions.activateWallet({
    subscriptionId,
    projectId,
    now: Date.now(),
  })

  if (activateResult?.err) {
    deps.logger.error(activateResult.err, {
      subscriptionId,
      projectId,
      context,
    })
  }
  return activateResult !== null
}
