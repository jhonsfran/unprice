import { task } from "@trigger.dev/sdk/v3"
import { createContext } from "./context"

export const billingTask = task({
  id: "invoice.billing.task",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    {
      subscriptionId,
      projectId,
      now,
      invoiceId,
    }: {
      projectId: string
      now: number
      subscriptionId: string
      invoiceId: string
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
        invoiceId,
        api: "jobs.invoice.billing",
        now: now.toString(),
      },
    })

    let status = 200

    try {
      const billingResult = await context.services.billing.billingInvoice({
        projectId,
        subscriptionId,
        invoiceId,
        now,
      })

      if (billingResult.err) {
        throw billingResult.err
      }

      return {
        status: billingResult.val.status,
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
