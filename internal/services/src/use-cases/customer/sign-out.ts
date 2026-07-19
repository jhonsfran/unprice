import type { FetchError, Result } from "@unprice/error"
import { Err } from "@unprice/error"
import type { Logger } from "@unprice/logs"

import type { ServiceContext } from "../../context"
import type { UnPriceSubscriptionError } from "../../subscriptions/errors"

type SignOutCustomerDeps = {
  services: Pick<ServiceContext, "subscriptions" | "customers">
  logger: Logger
}

/**
 * Sign out a customer: cancel every active subscription through the canonical
 * cancelSubscription path (closes phases, syncs entitlements, expires grants),
 * then deactivate the customer row. Deactivation only runs after every
 * cancellation succeeded so a failure never strands a disabled customer with
 * live subscriptions.
 */
export async function signOutCustomer(
  deps: SignOutCustomerDeps,
  {
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }
): Promise<Result<{ success: boolean }, UnPriceSubscriptionError | FetchError>> {
  const { subscriptions, customers } = deps.services

  const activeSubscriptions = await subscriptions.listActiveSubscriptions({
    customerId,
    projectId,
  })

  for (const subscription of activeSubscriptions) {
    const cancelResult = await subscriptions.cancelSubscription({
      subscriptionId: subscription.id,
      projectId,
      now,
    })

    if (cancelResult.err) {
      // A concurrent cancellation already got this one — the goal
      // (no active subscription) holds, keep going.
      if (cancelResult.err.code === "SUBSCRIPTION_NOT_ACTIVE") {
        deps.logger.warn("signOutCustomer skipping already-inactive subscription", {
          customerId,
          projectId,
          subscriptionId: subscription.id,
        })
        continue
      }

      deps.logger.error(cancelResult.err, {
        customerId,
        projectId,
        subscriptionId: subscription.id,
        context: "signOutCustomer cancel subscription",
      })

      return Err(cancelResult.err)
    }
  }

  return customers.deactivate({ customerId, projectId })
}
