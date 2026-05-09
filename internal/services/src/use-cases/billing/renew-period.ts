import { calculateCycleWindow } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import type { CustomerService } from "../../customers/service"
import type { SubscriptionRepository } from "../../subscriptions/repository"
import type { SubscriptionContext } from "../../subscriptions/types"

/**
 * RENEW phase. Advances the subscription's cycle window — applies scheduled
 * plan changes, ends trials, auto-renews or ends phases, updates
 * `subscriptions.currentCycleStartAt/EndAt` and `renewAt`. Pure cycle
 * mechanics — does NOT post charges or invoices (BILL phase owns that).
 *
 * Idempotent: a no-op when the subscription is already at the correct
 * window. Replays after the BILL phase to set up the next cycle.
 */
export async function renewPeriod(opts: {
  context: SubscriptionContext
  logger: Logger
  customerService: CustomerService
  repo: SubscriptionRepository
}) {
  const { context, logger, repo } = opts
  const { subscription, currentPhase } = context

  if (!currentPhase) throw new Error("No active phase found")

  const current = calculateCycleWindow({
    now: context.now,
    trialEndsAt: currentPhase.trialEndsAt,
    effectiveEndDate: currentPhase.endAt ?? null,
    config: {
      name: currentPhase.planVersion.billingConfig.name,
      interval: currentPhase.planVersion.billingConfig.billingInterval,
      intervalCount: currentPhase.planVersion.billingConfig.billingIntervalCount,
      planType: currentPhase.planVersion.billingConfig.planType,
      anchor: currentPhase.billingAnchor,
    },
    effectiveStartDate: currentPhase.startAt,
  })

  if (!current) throw new Error("No current cycle window found")

  logger.debug(
    `Current billing window: ${new Date(current.start).toUTCString()} - ${new Date(current.end).toUTCString()}`
  )

  // next window (advance boundary for both modes)
  const next = calculateCycleWindow({
    now: current.end + 1,
    trialEndsAt: currentPhase.trialEndsAt,
    effectiveEndDate: currentPhase.endAt ?? null,
    config: {
      name: currentPhase.planVersion.billingConfig.name,
      interval: currentPhase.planVersion.billingConfig.billingInterval,
      intervalCount: currentPhase.planVersion.billingConfig.billingIntervalCount,
      planType: currentPhase.planVersion.billingConfig.planType,
      anchor: currentPhase.billingAnchor,
    },
    effectiveStartDate: currentPhase.startAt,
  })

  if (!next) throw new Error("No next cycle window found")

  logger.debug(
    `Next billing window: ${new Date(next.start).toUTCString()} - ${new Date(next.end).toUTCString()}`
  )

  // idempotent no-op if already at the correct window
  if (
    subscription.currentCycleStartAt === current.start &&
    subscription.currentCycleEndAt === current.end &&
    subscription.renewAt === next.start
  ) {
    return {
      subscription,
      currentCycleStartAt: current.start,
      currentCycleEndAt: current.end,
      renewAt: next.start,
    }
  }

  try {
    const subscriptionUpdated = await repo.updateSubscription({
      subscriptionId: subscription.id,
      projectId: subscription.projectId,
      data: {
        planSlug: currentPhase.planVersion.plan.slug,
        renewAt: next.start,
        currentCycleStartAt: current.start,
        currentCycleEndAt: current.end,
      },
    })

    if (!subscriptionUpdated) {
      throw new Error("Subscription not updated")
    }

    return {
      subscription: subscriptionUpdated,
      currentCycleStartAt: current.start,
      currentCycleEndAt: current.end,
    }
  } catch (error) {
    logger.error(error, {
      context: "Error while renewing subscription",
      subscriptionId: subscription.id,
    })
    throw error
  }
}
