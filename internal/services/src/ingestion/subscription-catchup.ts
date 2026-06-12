import type { Subscription } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import type { SubscriptionService } from "../subscriptions/service"
import type { IngestionCandidateEntitlements, IngestionEntitlement } from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"

export type IngestionSubscriptionCatchUpService = Pick<
  SubscriptionService,
  "activateWallet" | "getSubscriptionData" | "renewSubscription"
>

export type IngestionSubscriptionCatchUpResult = {
  changed: boolean
  renewedSubscriptionIds: string[]
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
      return { changed: false, renewedSubscriptionIds: [] }
    }

    const eventAt = latestMessageTimestamp(params.messages)
    const subscriptionIds = collectSubscriptionIdsNeedingCatchUp({
      candidateEntitlements: params.candidateEntitlements,
      eventAt,
      messages: params.messages,
    })

    if (subscriptionIds.length === 0) {
      return { changed: false, renewedSubscriptionIds: [] }
    }

    const renewedSubscriptionIds: string[] = []

    for (const subscriptionId of subscriptionIds) {
      const renewed = await this.catchUpSubscription({
        eventAt,
        projectId: params.projectId,
        subscriptionId,
      })

      if (renewed) {
        renewedSubscriptionIds.push(subscriptionId)
      }
    }

    if (renewedSubscriptionIds.length > 0) {
      this.logger.info("raw ingestion subscription catch-up", {
        projectId: params.projectId,
        customerId: params.customerId,
        renewed_subscription_count: renewedSubscriptionIds.length,
      })
    }

    return {
      changed: renewedSubscriptionIds.length > 0,
      renewedSubscriptionIds,
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
  if (!subscription?.active) {
    return false
  }

  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return false
  }

  const renewAt = subscription.renewAt ?? subscription.currentCycleEndAt

  return typeof renewAt === "number" && eventAt >= renewAt
}

function latestMessageTimestamp(messages: IngestionQueueMessage[]): number {
  return messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0)
}
