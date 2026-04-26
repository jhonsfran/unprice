import { task } from "@trigger.dev/sdk/v3"
import { createContext } from "./context"

/**
 * Retry wallet activation for a subscription parked in `pending_activation`.
 *
 * Activation issues period grants and flips the subscription to `active`.
 * The grant transaction takes a per-customer advisory lock, so concurrent
 * sweeper runs (or an in-flight foreground retry) serialize on the same
 * key. Per-grant idempotency keys ensure that any partial DB state from a
 * prior failure converges on the same `wallet_grants` rows. See HARD-007.
 */
export const activationTask = task({
  id: "subscription.activation.task",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      customerId,
      now,
    }: {
      subscriptionId: string
      projectId: string
      customerId: string
      now: number
    },
    { ctx }
  ) => {
    const context = await createContext({
      taskId: ctx.task.id,
      subscriptionId,
      projectId,
      defaultFields: {
        subscriptionId,
        projectId,
        customerId,
        api: "jobs.subscription.activation.task",
        now: now.toString(),
      },
    })

    let status = 200

    try {
      const activateResult = await context.services.subscriptions.activateWallet({
        subscriptionId,
        projectId,
        now,
      })

      if (activateResult === null) {
        return { status: "skipped", subscriptionId, projectId, now }
      }

      if (activateResult.err) {
        throw activateResult.err
      }

      return {
        status: activateResult.val.status,
        subscriptionId,
        projectId,
        customerId,
        now,
      }
    } catch (error) {
      status = 500
      throw error
    } finally {
      await context.flushLogs(status)
    }
  },
})
