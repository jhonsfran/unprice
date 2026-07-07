import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { renewTask } from "../tasks/renew"

export const renewSchedule = schedules.task({
  id: "subscription.renew",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 1 hour in prod
  // cron: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    const activeSubscriptions = await db.query.subscriptions.findMany({
      where: (subscription, ops) =>
        ops.and(
          ops.lte(subscription.renewAt, now),
          ops.eq(subscription.active, true),
          ops.notInArray(subscription.status, ["canceled", "expired"])
        ),
      limit: 200, // limit to 200 subscriptions to avoid overwhelming the system
    })

    logger.info(`Found ${activeSubscriptions.length} subscriptions for renewing`)

    if (activeSubscriptions.length === 0) {
      return {
        subscriptionIds: [],
      }
    }

    // trigger handles concurrency
    await renewTask.batchTrigger(
      activeSubscriptions.map((s) => ({
        payload: {
          subscriptionId: s.id,
          customerId: s.customerId,
          projectId: s.projectId,
          now,
        },
        options: {
          concurrencyKey: `${s.projectId}:${s.id}`,
          idempotencyKey: `subscription.renew:${s.projectId}:${s.id}`,
        },
      }))
    )

    return {
      subscriptionIds: activeSubscriptions.map((p) => p.id),
    }
  },
})
