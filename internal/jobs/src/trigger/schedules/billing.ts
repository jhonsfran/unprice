import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { billingTask } from "../tasks/billing"

export const billingSchedule = schedules.task({
  id: "invoice.billing",
  // if dev then every 5 minutes in dev mode
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // find all invoices that need to be billed
    const invoices = await db.query.invoices.findMany({
      where: (invoice, ops) =>
        ops.and(
          ops.inArray(invoice.status, ["unpaid", "waiting", "failed"]),
          ops.lte(invoice.dueAt, now)
        ),
    })

    if (invoices.length === 0) {
      return {
        invoiceIds: [],
      }
    }

    // trigger handles concurrency
    await billingTask.batchTrigger(
      invoices.map((i) => ({
        payload: {
          invoiceId: i.id,
          subscriptionId: i.subscriptionId,
          projectId: i.projectId,
          now,
        },
        options: {
          concurrencyKey: `${i.projectId}:${i.subscriptionId}`,
          idempotencyKey: `invoice.billing:${i.projectId}:${i.id}`,
        },
      }))
    )

    logger.info(`Found ${invoices.length} invoices for billing`)

    return {
      invoiceIds: invoices.map((i) => i.id),
    }
  },
})
