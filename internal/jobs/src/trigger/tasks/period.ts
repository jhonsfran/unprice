import { task } from "@trigger.dev/sdk/v3"
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
      const periodResult = await context.services.billing.generateBillingPeriods({
        subscriptionId,
        projectId,
        now,
        caller: "job",
      })

      if (periodResult.err) {
        throw periodResult.err
      }

      // New periods already synced the payer budget. Otherwise sync it anyway, so a change its
      // request path left to a job (RESERVATIONS_OPEN) lands now; the job waits out open holds.
      if (periodResult.val.cyclesCreated === 0) {
        await context.services.billing.syncSubscriptionPayerBudget({
          subscriptionId,
          projectId,
          caller: "job",
        })
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
