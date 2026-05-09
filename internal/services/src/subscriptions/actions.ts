import type { Subscription } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"

import type { SubscriptionRepository } from "./repository"
import type { SubscriptionContext, SubscriptionEvent } from "./types"

/**
 * Action: Log state transition
 */
export const logTransition = ({
  context,
  event,
  logger,
}: {
  context: SubscriptionContext
  event: SubscriptionEvent
  logger: Logger
}): void => {
  if (!context.currentPhase) {
    logger.debug(`Subscription ${context.subscriptionId} has no current phase`, {
      subscriptionId: context.subscriptionId,
      customerId: context.customer.id,
      projectId: context.projectId,
      now: context.now,
      event: JSON.stringify(event),
    })
  }

  if (context.error) {
    logger.debug(`Subscription ${context.subscriptionId} error: ${context.error.message}`, {
      subscriptionId: context.subscriptionId,
      customerId: context.customer.id,
      currentPhaseId: context.currentPhase?.id,
      projectId: context.projectId,
      now: context.now,
      event: JSON.stringify(event),
    })
  }

  logger.debug(
    `Subscription ${context.subscriptionId} ${context.subscription.status} state transition: ${event.type}`
  )
}

/**
 * Action: Send notification to customer
 */
export default ({
  context,
  event,
  logger,
}: {
  context: SubscriptionContext
  event: SubscriptionEvent
  logger: Logger
}): void => {
  logger.debug(
    `Notifying customer about subscription ${context.subscriptionId} event: ${event.type}`
  )
}

/**
 * Action: Update metadata for subscription
 */
export const updateSubscription = async ({
  context,
  subscription,
  repo,
}: {
  context: SubscriptionContext
  subscription: Partial<Subscription>
  repo: SubscriptionRepository
}): Promise<void> => {
  const { subscriptionId, projectId } = context

  await repo.updateSubscription({
    subscriptionId,
    projectId,
    data: subscription,
  })
}
