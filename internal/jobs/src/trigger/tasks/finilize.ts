import { task } from "@trigger.dev/sdk/v3"
import { BillingService } from "@unprice/services/billing"
import { createContext } from "./context"

export const finilizeTask = task({
  id: "invoice.finilize.task",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    {
      projectId,
      now,
      subscriptionId,
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
        api: "jobs.invoice.finilize",
        now: now.toString(),
        invoiceId,
      },
    })

    let status = 200

    try {
      const billingService = new BillingService(context)
      const finalizeInvoiceResult = await billingService.finalizeInvoice({
        projectId,
        subscriptionId,
        invoiceId,
        now,
      })

      if (finalizeInvoiceResult.err) {
        throw finalizeInvoiceResult.err
      }

      return {
        status: finalizeInvoiceResult.val.status,
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
