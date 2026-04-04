import { task } from "@trigger.dev/sdk/v3"
import { createContext } from "./context"

export const renewTask = task({
  id: "subscription.renew.task",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
      customerId,
    }: {
      subscriptionId: string
      projectId: string
      now: number
      customerId: string
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
        api: "jobs.subscription.renew.task",
        now: now.toString(),
      },
    })

    let status = 200

    try {
      const renewResult = await context.services.subscriptions.renewSubscription({
        subscriptionId,
        projectId,
        now,
      })

      if (renewResult.err) {
        throw renewResult.err
      }

      return {
        status: renewResult.val.status,
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
