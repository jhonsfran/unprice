import { logger, schedules } from "@trigger.dev/sdk/v3"

import { db } from "../db"
import { finilizeTask } from "../tasks/finilize"

export const finilizingSchedule = schedules.task({
  id: "invoice.finilizing",
  // if dev then every 5 minutes in dev mode
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    // find all invoices that need to be finilized
    const openInvoices = await db.query.invoices.findMany({
      with: {
        customer: true,
      },
      where: (inv, { and, eq, inArray, lte, or, isNull }) =>
        or(
          // for invoices that have not been finilized yet
          and(eq(inv.status, "draft"), lte(inv.dueAt, now)),
          // for invoices that have been finilized but not sent to the payment provider
          and(
            inArray(inv.status, ["unpaid", "waiting"]),
            isNull(inv.invoicePaymentProviderId),
            lte(inv.dueAt, now)
          )
        ),
      orderBy: (inv, { asc }) => asc(inv.dueAt),
      limit: 500,
    })

    logger.info(`Found ${openInvoices.length} open invoices for finilizing`)

    // Surface stuck-draft invoices for ops. Threshold: > 5 prior finalize
    // attempts (provider has been failing repeatedly) OR draft for > 1h past
    // dueAt. The warn line is the alarm hook — operators tail logs for
    // `stale_draft_invoice` and page on it.
    const oneHourMs = 60 * 60 * 1000
    for (const inv of openInvoices) {
      if (inv.status !== "draft") continue
      const meta = (inv.metadata ?? {}) as {
        finalizeAttempts?: number
        lastFinalizeError?: string
      }
      const attempts = meta.finalizeAttempts ?? 0
      const overdueByMs = now - inv.dueAt
      if (attempts > 5 || overdueByMs > oneHourMs) {
        logger.warn("stale_draft_invoice", {
          invoiceId: inv.id,
          projectId: inv.projectId,
          subscriptionId: inv.subscriptionId,
          finalizeAttempts: attempts,
          overdueByMs,
          lastFinalizeError: meta.lastFinalizeError,
        })
      }
    }

    if (openInvoices.length === 0) {
      return {
        invoiceIds: [],
      }
    }

    // trigger handles concurrency
    await finilizeTask.batchTrigger(
      openInvoices.map((i) => ({
        payload: {
          projectId: i.projectId,
          subscriptionId: i.subscriptionId,
          invoiceId: i.id,
          now,
        },
      }))
    )

    return {
      invoiceIds: openInvoices.map((i) => i.id),
    }
  },
})
