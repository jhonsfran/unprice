import { logger, schedules } from "@trigger.dev/sdk/v3"

import { db } from "../db"
import { activationTask } from "../tasks/activation"

/**
 * Sweeper for subscriptions parked in `pending_activation`.
 *
 * Wallet activation can fail at create or renew time (DB blip, ledger
 * gateway hiccup, etc.). The state machine moves the subscription to
 * `pending_activation` so ingestion is denied until grants are issued.
 * This sweeper rescans every 5 minutes (1 hour in prod) and re-fires
 * activation through the same `activateWallet` path; grant idempotency
 * keys keep retries convergent.
 *
 * Operator alarm: subscriptions parked > 1h emit a `stale_pending_activation`
 * warn line; ops tail logs and page on it.
 */
export const activationSchedule = schedules.task({
  id: "subscription.activation",
  cron: {
    timezone: "UTC",
    pattern: process.env.NODE_ENV === "development" ? "*/5 * * * *" : "0 * * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp.getTime()

    const stuck = await db.query.subscriptions.findMany({
      where: (subscription, { eq }) => eq(subscription.status, "pending_activation"),
      limit: 200,
    })

    logger.info(`Found ${stuck.length} subscriptions in pending_activation`)

    const oneHourMs = 60 * 60 * 1000
    for (const sub of stuck) {
      const stuckForMs = now - (sub.updatedAtM ?? sub.createdAtM ?? now)
      if (stuckForMs > oneHourMs) {
        logger.warn("stale_pending_activation", {
          subscriptionId: sub.id,
          projectId: sub.projectId,
          customerId: sub.customerId,
          stuckForMs,
        })
      }
    }

    if (stuck.length === 0) {
      return { subscriptionIds: [] }
    }

    await activationTask.batchTrigger(
      stuck.map((s) => ({
        payload: {
          subscriptionId: s.id,
          projectId: s.projectId,
          customerId: s.customerId,
          now,
        },
      }))
    )

    return {
      subscriptionIds: stuck.map((s) => s.id),
    }
  },
})
