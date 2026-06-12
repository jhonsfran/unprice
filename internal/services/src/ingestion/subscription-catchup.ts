import type { Subscription } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import type { SubscriptionService } from "../subscriptions/service"
import type { IngestionCandidateEntitlements, IngestionEntitlement } from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"

export type IngestionSubscriptionCatchUpService = Pick<
  SubscriptionService,
  "activateWallet" | "getSubscriptionData" | "materializeBillingPeriods" | "renewSubscription"
>

export type IngestionSubscriptionCatchUpResult = {
  changed: boolean
  caughtUpSubscriptionIds: string[]
}

export class IngestionSubscriptionCatchUp {
  private readonly logger: Pick<Logger, "info">
  private readonly maxRenewalsPerSubscription: number
  private readonly subscriptions: IngestionSubscriptionCatchUpService

  constructor(opts: {
    logger: Pick<Logger, "info">
    maxRenewalsPerSubscription?: number
    subscriptions: IngestionSubscriptionCatchUpService
  }) {
    this.logger = opts.logger
    this.maxRenewalsPerSubscription = opts.maxRenewalsPerSubscription ?? 3
    this.subscriptions = opts.subscriptions
  }

  public async catchUpForPreparedGroup(params: {
    candidateEntitlements: IngestionCandidateEntitlements
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionSubscriptionCatchUpResult> {
    if (params.messages.length === 0) {
      return { changed: false, caughtUpSubscriptionIds: [] }
    }

    const eventAt = latestMessageTimestamp(params.messages)
    const subscriptionIds = collectSubscriptionIdsNeedingCatchUp({
      candidateEntitlements: params.candidateEntitlements,
      eventAt,
      messages: params.messages,
    })

    if (subscriptionIds.length === 0) {
      return { changed: false, caughtUpSubscriptionIds: [] }
    }

    const caughtUpSubscriptionIds: string[] = []

    for (const subscriptionId of subscriptionIds) {
      const caughtUp = await this.catchUpSubscription({
        eventAt,
        projectId: params.projectId,
        subscriptionId,
      })

      if (caughtUp) {
        caughtUpSubscriptionIds.push(subscriptionId)
      }
    }

    if (caughtUpSubscriptionIds.length > 0) {
      this.logger.info("raw ingestion subscription catch-up", {
        projectId: params.projectId,
        customerId: params.customerId,
        caught_up_subscription_count: caughtUpSubscriptionIds.length,
      })
    }

    return {
      changed: caughtUpSubscriptionIds.length > 0,
      caughtUpSubscriptionIds,
    }
  }

  private async catchUpSubscription(params: {
    eventAt: number
    projectId: string
    subscriptionId: string
  }): Promise<boolean> {
    let changed = false

    for (let attempt = 0; attempt < this.maxRenewalsPerSubscription; attempt++) {
      const subscription = await this.subscriptions.getSubscriptionData({
        subscriptionId: params.subscriptionId,
        projectId: params.projectId,
      })

      if (subscription?.status === "pending_activation") {
        const result = await this.subscriptions.activateWallet({
          subscriptionId: params.subscriptionId,
          projectId: params.projectId,
          now: params.eventAt,
        })

        if (result === null) {
          throw new Error(
            `Subscription catch-up cannot activate ${params.subscriptionId}; wallet service is unavailable`
          )
        }

        if (result.err) {
          throw result.err
        }

        if (result.val.status === "pending_activation") {
          throw new Error(
            `Subscription catch-up did not return active status for ${params.subscriptionId}; got pending_activation`
          )
        }

        return true
      }

      if (!subscriptionNeedsRenewal(subscription, params.eventAt)) {
        if (subscriptionCanMaterializeBillingPeriods(subscription)) {
          const result = await this.subscriptions.materializeBillingPeriods({
            subscriptionId: params.subscriptionId,
            projectId: params.projectId,
            now: params.eventAt,
          })

          if (result.err) {
            throw result.err
          }

          return true
        }

        return changed
      }

      const result = await this.subscriptions.renewSubscription({
        subscriptionId: params.subscriptionId,
        projectId: params.projectId,
        now: params.eventAt,
      })

      if (result.err) {
        throw result.err
      }

      if (result.val.status === "pending_activation") {
        throw new Error(
          `Subscription catch-up did not return active status for ${params.subscriptionId}; got pending_activation`
        )
      }

      changed = true
    }

    return changed
  }
}

function collectSubscriptionIdsNeedingCatchUp(params: {
  candidateEntitlements: IngestionCandidateEntitlements
  eventAt: number
  messages: IngestionQueueMessage[]
}): string[] {
  const eventSlugs = new Set(params.messages.map((message) => message.slug))
  const subscriptionIds = new Set<string>()

  for (const entitlement of params.candidateEntitlements) {
    if (!isRelevantUsageEntitlement(entitlement, eventSlugs)) {
      continue
    }

    if (hasBillingPeriodCovering(entitlement, params.eventAt)) {
      continue
    }

    if (typeof entitlement.subscriptionId === "string" && entitlement.subscriptionId.length > 0) {
      subscriptionIds.add(entitlement.subscriptionId)
    }
  }

  return [...subscriptionIds]
}

function isRelevantUsageEntitlement(
  entitlement: IngestionEntitlement,
  eventSlugs: Set<string>
): boolean {
  return (
    entitlement.featureType === "usage" &&
    entitlement.meterConfig !== null &&
    eventSlugs.has(entitlement.meterConfig.eventSlug)
  )
}

function hasBillingPeriodCovering(entitlement: IngestionEntitlement, eventAt: number): boolean {
  return entitlement.billingPeriods.some(
    (period) => period.cycleStartAt <= eventAt && eventAt < period.cycleEndAt
  )
}

function subscriptionNeedsRenewal(subscription: Subscription | null, eventAt: number): boolean {
  if (!subscriptionCanMaterializeBillingPeriods(subscription)) {
    return false
  }

  const renewAt = subscription.renewAt ?? subscription.currentCycleEndAt

  return typeof renewAt === "number" && eventAt >= renewAt
}

function subscriptionCanMaterializeBillingPeriods(
  subscription: Subscription | null
): subscription is Subscription {
  if (!subscription?.active) {
    return false
  }

  return subscription.status === "active" || subscription.status === "trialing"
}

function latestMessageTimestamp(messages: IngestionQueueMessage[]): number {
  return messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0)
}
