import { task } from "@trigger.dev/sdk/v3"
import { createContext } from "./context"

export const invoiceReconcileTask = task({
  id: "invoice.reconcile.task",
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
        api: "jobs.invoice.reconcile",
        now: now.toString(),
      },
    })

    let status = 200

    try {
      const reconciled = await context.services.billing.reconcileInvoiceFromProvider({
        projectId,
        subscriptionId,
        invoiceId,
        now,
      })

      if (reconciled.err) {
        throw reconciled.err
      }

      return {
        changed: reconciled.val.changed,
        providerStatus: reconciled.val.providerStatus,
        status: reconciled.val.status,
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
