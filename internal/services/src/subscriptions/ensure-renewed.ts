import type { Logger } from "@unprice/logs"
import type { SubscriptionService } from "./service"

/**
 * Minimal service interface for subscription catch-up on sync paths.
 * Uses the same operations as `IngestionSubscriptionCatchUp` but with
 * a simpler entry point that doesn't require prepared entitlement context.
 */
export type SyncCatchUpService = Pick<
  SubscriptionService,
  "activateWallet" | "getSubscriptionData" | "renewSubscription"
>

export type EnsureSubscriptionRenewedResult = {
  renewed: boolean
}

/**
 * Ensures a subscription is current (not past its renewal point) before
 * performing wallet operations. This is the sync-path equivalent of
 * `IngestionSubscriptionCatchUp` used in the async queue path.
 *
 * When the renewal cron hasn't run yet (common in local dev, or during
 * cron lag in production), wallet credits expire at `periodEndAt` but new
 * credits aren't issued until renewal completes. This helper bridges that
 * gap by triggering renewal inline.
 *
 * Call this before any operation that creates wallet reservations:
 * - `startRun` (run budget reservation)
 * - Sync ingestion retry after WALLET_EMPTY
 */
export async function ensureSubscriptionRenewed(
  deps: {
    subscriptions: SyncCatchUpService
    logger: Pick<Logger, "info" | "warn">
  },
  params: {
    subscriptionId: string
    projectId: string
    now?: number
  }
): Promise<EnsureSubscriptionRenewedResult> {
  const now = params.now ?? Date.now()
  const maxAttempts = 3

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const subscription = await deps.subscriptions.getSubscriptionData({
      subscriptionId: params.subscriptionId,
      projectId: params.projectId,
    })

    if (!subscription) {
      return { renewed: false }
    }

    // Handle subscriptions stuck in pending_activation (failed wallet grant)
    if (subscription.status === "pending_activation") {
      const result = await deps.subscriptions.activateWallet({
        subscriptionId: params.subscriptionId,
        projectId: params.projectId,
        now,
      })

      if (result === null || result.err) {
        deps.logger.warn("subscription catch-up: activateWallet failed", {
          subscriptionId: params.subscriptionId,
          projectId: params.projectId,
          error: result?.err?.message ?? "wallet service unavailable",
        })
        return { renewed: false }
      }

      if (result.val.status === "pending_activation") {
        deps.logger.warn("subscription catch-up: still pending_activation after retry", {
          subscriptionId: params.subscriptionId,
          projectId: params.projectId,
        })
        return { renewed: false }
      }

      return { renewed: true }
    }

    // Only active/trialing subscriptions can be renewed
    if (subscription.status !== "active" && subscription.status !== "trialing") {
      return { renewed: false }
    }

    // Check if renewal is needed
    const renewAt = subscription.renewAt ?? subscription.currentCycleEndAt
    if (typeof renewAt !== "number" || now < renewAt) {
      // Subscription is current, no renewal needed
      return { renewed: attempt > 0 }
    }

    // Trigger renewal
    const result = await deps.subscriptions.renewSubscription({
      subscriptionId: params.subscriptionId,
      projectId: params.projectId,
      now,
    })

    if (result.err) {
      deps.logger.warn("subscription catch-up: renewSubscription failed", {
        subscriptionId: params.subscriptionId,
        projectId: params.projectId,
        error: result.err.message,
        attempt,
      })
      return { renewed: attempt > 0 }
    }

    if (result.val.status === "pending_activation") {
      deps.logger.warn("subscription catch-up: ended in pending_activation", {
        subscriptionId: params.subscriptionId,
        projectId: params.projectId,
        attempt,
      })
      // Try to activate on next iteration
      continue
    }

    deps.logger.info("subscription catch-up: renewed successfully", {
      subscriptionId: params.subscriptionId,
      projectId: params.projectId,
      attempt,
      status: result.val.status,
    })

    // Loop continues to check if another renewal is needed (multi-period catch-up)
  }

  return { renewed: true }
}
