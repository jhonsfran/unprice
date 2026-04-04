import { task } from "@trigger.dev/sdk/v3"
import { createContext } from "./context"

export const invoiceTask = task({
  id: "invoice.create.task",
  retry: {
    maxAttempts: 3,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
    }: {
      subscriptionId: string
      projectId: string
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
        api: "jobs.invoice.create",
        now: now.toString(),
      },
    })

    let status = 200

    try {
      const invoiceResult = await context.services.subscriptions.invoiceSubscription({
        subscriptionId,
        projectId,
        now,
      })

      if (invoiceResult.err) {
        throw invoiceResult.err
      }

      return {
        status: invoiceResult.val.status,
        subscriptionId,
      }
    } catch (error) {
      status = 500
      throw error
    } finally {
      await context.flushLogs(status)
    }
  },
})
