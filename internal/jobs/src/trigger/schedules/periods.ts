import { logger, schedules } from "@trigger.dev/sdk/v3"
import { db } from "../db"
import { periodTask } from "../tasks/period"

/** How far back a phase change is still re-synced: two runs, so one missed run is covered. */
const PAYER_BUDGET_RESYNC_WINDOW_MS = 24 * 60 * 60 * 1000

/** Items per `batchTrigger` call: Trigger.dev caps a batch's items, and 500 stays within the cap. */
export const PERIOD_BATCH_SIZE = 500

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

    // Active subscriptions near their cycle end get their next periods.
    const due = await db.query.subscriptions.findMany({
      columns: { id: true, projectId: true },
      where: (subscription, ops) =>
        ops.and(
          ops.eq(subscription.active, true),
          ops.notInArray(subscription.status, ["canceled", "expired"]),
          ops.lte(subscription.currentCycleEndAt, now + lookaheadMs)
        ),
    })

    // A subscription whose phases changed recently (a plan change, a cancel, a phase end: what
    // changes pricing or limits), canceled ones included, syncs its payer budget again, so a change
    // refused on its request path while holds were open (RESERVATIONS_OPEN) lands within one run
    // (ADR-0008 D1). The due ones already sync with their new periods.
    const dueIds = new Set(due.map((subscription) => subscription.id))
    const changedPhases = await db.query.subscriptionPhases.findMany({
      columns: { subscriptionId: true, projectId: true },
      where: (phase, ops) => ops.gte(phase.updatedAtM, now - PAYER_BUDGET_RESYNC_WINDOW_MS),
    })
    const changed = new Map<string, { id: string; projectId: string }>()
    for (const { subscriptionId, projectId } of changedPhases) {
      if (!dueIds.has(subscriptionId))
        changed.set(subscriptionId, { id: subscriptionId, projectId })
    }
    const subscriptions = [...due, ...changed.values()]

    logger.info(
      `Found ${due.length} subscriptions for creating periods and ${changed.size} to re-sync`
    )

    if (subscriptions.length === 0) {
      return {
        subscriptionIds: [],
      }
    }

    // triggers handle concurrency
    for (let start = 0; start < subscriptions.length; start += PERIOD_BATCH_SIZE) {
      await periodTask.batchTrigger(
        subscriptions.slice(start, start + PERIOD_BATCH_SIZE).map((s) => ({
          payload: {
            subscriptionId: s.id,
            projectId: s.projectId,
            now,
          },
        }))
      )
    }

    return {
      subscriptionIds: subscriptions.map((p) => p.id),
    }
  },
})
