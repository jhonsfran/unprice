import { logger, schedules } from "@trigger.dev/sdk/v3"
import { and, eq, lte } from "@unprice/db"
import { billingPeriods } from "@unprice/db/schema"
import { billingStatementReadyForInvoicing } from "@unprice/services/billing"
import { LATE_EVENT_GRACE_MS } from "@unprice/services/entitlements"
import { db } from "../db"
import { invoiceTask } from "../tasks/invoice"

export const invoicingSchedule = schedules.task({
  id: "invoice.invoicing",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 1 hour in prod
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    const periodItems = await db
      .select({
        projectId: billingPeriods.projectId,
        subscriptionId: billingPeriods.subscriptionId,
        subscriptionPhaseId: billingPeriods.subscriptionPhaseId,
        statementKey: billingPeriods.statementKey,
      })
      .from(billingPeriods)
      .groupBy(
        billingPeriods.projectId,
        billingPeriods.subscriptionId,
        billingPeriods.subscriptionPhaseId,
        billingPeriods.statementKey
      )
      .where(
        and(
          eq(billingPeriods.status, "pending"),
          lte(billingPeriods.invoiceAt, now),
          billingStatementReadyForInvoicing({ now, lateEventGraceMs: LATE_EVENT_GRACE_MS })
        )
      )
      .limit(500) // limit to 500 period items to avoid overwhelming the system

    const periodItemsWithActiveSubscription = periodItems.filter((s) => s.subscriptionId !== null)

    logger.info(`Found ${periodItemsWithActiveSubscription.length} period items for invoicing`)

    if (periodItemsWithActiveSubscription.length === 0) {
      return {
        subscriptionIds: [],
      }
    }

    // trigger handles concurrency
    await invoiceTask.batchTrigger(
      periodItemsWithActiveSubscription.map((sub) => ({
        payload: {
          subscriptionId: sub.subscriptionId,
          projectId: sub.projectId,
          now,
        },
        options: {
          concurrencyKey: `${sub.projectId}:${sub.subscriptionId}`,
          idempotencyKey: `invoice.create:${sub.projectId}:${sub.subscriptionId}:${sub.statementKey}`,
        },
      }))
    )

    return {
      subscriptionIds: periodItems.map((s) => s.subscriptionId),
    }
  },
})
