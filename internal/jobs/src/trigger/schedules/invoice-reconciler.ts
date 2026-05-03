import { and, inArray, isNotNull, lte, or, isNull } from "@unprice/db"
import { invoices as invoicesTable } from "@unprice/db/schema"
import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { invoiceReconcileTask } from "../tasks/invoice-reconcile"

const RECONCILE_GRACE_MS = 5 * 60 * 1000

export const invoiceReconcilerSchedule = schedules.task({
  id: "invoice.reconciler",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "*/10 * * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()
    const readyAt = now - RECONCILE_GRACE_MS

    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(
        and(
          inArray(invoicesTable.status, ["unpaid", "waiting"]),
          isNotNull(invoicesTable.invoicePaymentProviderId),
          lte(invoicesTable.dueAt, now),
          or(isNull(invoicesTable.issueDate), lte(invoicesTable.issueDate, readyAt))
        )
      )
      .limit(500)

    if (invoices.length === 0) {
      return {
        invoiceIds: [],
      }
    }

    await invoiceReconcileTask.batchTrigger(
      invoices.map((invoice) => ({
        payload: {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscriptionId,
          projectId: invoice.projectId,
          now,
        },
      }))
    )

    logger.info(`Found ${invoices.length} invoices for provider reconciliation`)

    return {
      invoiceIds: invoices.map((invoice) => invoice.id),
    }
  },
})
