import type { Logger } from "@unprice/logs"
import type { CustomerService } from "../customers/service"
import { billPeriod } from "../use-cases/billing/bill-period"
import { renewPeriod } from "../use-cases/billing/renew-period"
import type { SubscriptionRepository } from "./repository"
import type { SubscriptionContext } from "./types"

/**
 * XState machine actor adapters. The machine state names map 1:1 to BSS
 * pipeline phases:
 *
 *   loading      → context bootstrap (loadSubscription)
 *   renewing     → RENEW phase  → use-cases/billing/renew-period.ts
 *   invoicing    → BILL phase   → use-cases/billing/bill-period.ts
 *   activating   → PROVISION    → use-cases/billing/provision-period.ts
 *
 * Each actor below is a thin shell that delegates to the canonical phase
 * use case so the actor's responsibility stays "translate the machine event
 * to a use-case call" and the use case stays testable in isolation.
 */

export async function loadSubscription(payload: {
  context: SubscriptionContext
  logger: Logger
  repo: SubscriptionRepository
  customerService: CustomerService
}): Promise<SubscriptionContext> {
  const { context, logger, repo, customerService } = payload
  const { subscriptionId, projectId, now } = context

  const result = await repo.findSubscriptionForMachine({
    subscriptionId,
    projectId,
    now,
  })

  if (!result) {
    throw new Error(`Subscription with ID ${subscriptionId} not found`)
  }

  const { phases, customer, subscription } = result

  // phase can be undefined if the subscription is paused or ended but still the machine can be in active state
  //  for instance the subscription was pasued there is no current phase but there is an option to resume and
  // subscribe to a new phase
  const currentPhase = phases[0]

  // check the payment method as well
  const { val, err: validatePaymentMethodErr } = await customerService.validatePaymentMethod({
    customerId: customer.id,
    projectId: projectId,
    paymentProvider: currentPhase?.paymentProvider,
    requiredPaymentMethod: currentPhase?.planVersion.paymentMethodRequired,
  })

  if (validatePaymentMethodErr) {
    logger.error(`Error validating payment method: ${validatePaymentMethodErr.message}`)
    throw validatePaymentMethodErr
  }

  const { paymentMethodId, requiredPaymentMethod } = val

  let resultPhase = null

  if (currentPhase) {
    const { items, planVersion, ...phase } = currentPhase
    resultPhase = {
      ...phase,
      items: items ?? [],
      planVersion: planVersion ?? null,
    }
  }

  return {
    now,
    subscriptionId: subscription.id,
    projectId: subscription.projectId,
    customer,
    currentPhase: resultPhase,
    subscription,
    paymentMethodId,
    requiredPaymentMethod,
  }
}

/** RENEW phase actor. Thin shell over `renewPeriod` use case. */
export const renewSubscription = renewPeriod

/** BILL phase actor. Thin shell over `billPeriod` use case. */
export const invoiceSubscription = billPeriod
