import { task } from "@trigger.dev/sdk/v3"
import { BillingService } from "@unprice/services/billing"
import { createContext } from "./context"

export const periodTask = task({
  id: "subscription.period.task",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      projectId,
      now,
      subscriptionId,
    }: {
      projectId: string
      now: number
      subscriptionId: string
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
        api: "jobs.subscription.period.task",
        now: now.toString(),
      },
    })

    let status = 200

    try {
      const billingService = new BillingService(context)

      const periodResult = await billingService.generateBillingPeriods({
        subscriptionId,
        projectId,
        now,
      })

      if (periodResult.err) {
        throw periodResult.err
      }

      return {
        cyclesCreated: periodResult.val.cyclesCreated,
        phasesProcessed: periodResult.val.phasesProcessed,
        subscriptionId,
        projectId,
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
