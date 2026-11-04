import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { periodTask } from "../tasks/period"

/** How far back a subscription change is still re-synced: two runs, so one missed run is covered. */
const PAYER_BUDGET_RESYNC_WINDOW_MS = 24 * 60 * 60 * 1000

export const periodsSchedule = schedules.task({
  id: "subscription.periods",
  // every 12 hours (UTC timezone)
  // if dev then every 5 minutes in dev mode every 12 hours in prod
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 */12 * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()
    const lookaheadMs = 3 * 24 * 60 * 60 * 1000 // act slightly ahead of term end of cycle 3 days
    const changedSince = now - PAYER_BUDGET_RESYNC_WINDOW_MS

    // Active subscriptions near their cycle end get their next periods. Any subscription changed
    // recently (itself or a phase), canceled ones included, syncs its payer budget again: a change
    // refused on its request path while holds were open (RESERVATIONS_OPEN) lands within one run
    // (ADR-0008 D1).
    const changedPhases = await db.query.subscriptionPhases.findMany({
      columns: { subscriptionId: true },
      where: (phase, ops) => ops.gte(phase.updatedAtM, changedSince),
    })
    const changed = [...new Set(changedPhases.map((phase) => phase.subscriptionId))]
    const subscriptions = await db.query.subscriptions.findMany({
      where: (subscription, ops) =>
        ops.or(
          ops.and(
            ops.eq(subscription.active, true),
            ops.notInArray(subscription.status, ["canceled", "expired"]),
            ops.lte(subscription.currentCycleEndAt, now + lookaheadMs)
          ),
          ops.gte(subscription.updatedAtM, changedSince),
          ...(changed.length > 0 ? [ops.inArray(subscription.id, changed)] : [])
        ),
    })

    logger.info(`Found ${subscriptions.length} subscriptions for creating periods`)

    if (subscriptions.length === 0) {
      return {
        subscriptionIds: [],
      }
    }

    // triggers handle concurrency
    await periodTask.batchTrigger(
      subscriptions.map((s) => ({
        payload: {
          subscriptionId: s.id,
          projectId: s.projectId,
          now,
        },
      }))
    )

    return {
      subscriptionIds: subscriptions.map((p) => p.id),
    }
  },
})
