import { logger, schedules } from "@trigger.dev/sdk/v3"
import { Analytics } from "@unprice/analytics"
import { and, eq, gt, isNull, lte, sql } from "@unprice/db"
import { customers, walletCredits } from "@unprice/db/schema"
import { createStandaloneRequestLogger } from "@unprice/observability"
import { CacheService } from "@unprice/services/cache"
import { createServiceContext } from "@unprice/services/context"
import { NoopMetrics } from "@unprice/services/metrics"
import { env } from "../../env"
import { db } from "../db"

/**
 * Sweeps `wallet_credits` whose `expires_at` has passed and claws the
 * remaining balance back to the matching platform funding account.
 *
 * Per plan slice 7.11 §6: every 5 minutes. One transaction per grant so
 * different customers proceed in parallel; the per-customer advisory
 * lock serializes this sweep against concurrent drains/reservations for
 * the same customer without blocking the platform.
 *
 * Safe to re-run: the idempotency key `expire:<grantId>` converges
 * replays on the same ledger transfer, and the in-lock re-read ensures
 * an already-expired or fully-drained grant is skipped.
 */
export const walletCreditExpirationSchedule = schedules.task({
  id: "wallet.expire-grants",
  cron: {
    timezone: "UTC",
    pattern: "*/5 * * * *",
  },
  run: async (payload) => {
    const now = payload.timestamp

    const { logger: log } = createStandaloneRequestLogger(
      {
        method: "POST",
        path: "/trigger/schedules/wallet.expire-grants",
        requestId: `wallet-expire-${now.getTime()}`,
      },
      {}
    )

    const cache = new CacheService({ waitUntil: () => {} }, new NoopMetrics(), false)
    cache.init([])

    const analytics = new Analytics({
      emit: true,
      tinybirdToken: env.TINYBIRD_TOKEN,
      tinybirdUrl: env.TINYBIRD_URL,
      logger: log,
    })

    const services = createServiceContext({
      db,
      logger: log,
      analytics,
      waitUntil: () => {},
      cache: cache.getCache(),
      metrics: new NoopMetrics(),
    })

    const expiredGrants = await db.query.walletCredits.findMany({
      where: and(
        isNull(walletCredits.expiredAt),
        isNull(walletCredits.voidedAt),
        gt(walletCredits.remainingAmount, 0),
        lte(walletCredits.expiresAt, now)
      ),
      limit: 500,
    })

    if (expiredGrants.length === 0) {
      return { expiredCount: 0, skippedCount: 0 }
    }

    logger.info(`Found ${expiredGrants.length} grants to expire`)

    let expiredCount = 0
    let skippedCount = 0

    for (const grant of expiredGrants) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${grant.customerId}`}))`
          )

          // Re-read under the lock — another flow may have drained the
          // grant between the outer query and here. If already expired,
          // already voided, or fully consumed, skip.
          const current = await tx.query.walletCredits.findFirst({
            where: and(eq(walletCredits.id, grant.id), eq(walletCredits.projectId, grant.projectId)),
          })

          if (!current) {
            skippedCount += 1
            return
          }
          if (current.expiredAt || current.voidedAt || current.remainingAmount === 0) {
            // If remaining is 0 but expiredAt isn't stamped (drain raced
            // the sweep), mark it expired so the state machine advances.
            if (current.remainingAmount === 0 && !current.expiredAt && !current.voidedAt) {
              await tx
                .update(walletCredits)
                .set({ expiredAt: now })
                .where(
                  and(
                    eq(walletCredits.id, current.id),
                    eq(walletCredits.projectId, current.projectId)
                  )
                )
            }
            skippedCount += 1
            return
          }

          // Resolve currency from the customer row. Phase 7 is
          // single-currency per customer (see plan §Non-Goals —
          // "One account per currency"), so `customers.default_currency`
          // is the authoritative source. `wallet_credits` does not store
          // currency; reading it here avoids hardcoding USD and respects
          // EUR customers.
          const customer = await tx.query.customers.findFirst({
            columns: { defaultCurrency: true },
            where: and(
              eq(customers.id, current.customerId),
              eq(customers.projectId, current.projectId)
            ),
          })

          if (!customer) {
            // Customer row gone — cannot safely move money. Skip and
            // surface for the nightly reconciliation sweep to flag.
            log.error("wallet.expire_grant.customer_missing", {
              grantId: current.id,
              customerId: current.customerId,
              projectId: current.projectId,
            })
            skippedCount += 1
            return
          }

          const clawbackAmount = current.remainingAmount

          const result = await services.wallet.expireGrant(tx, {
            customerId: current.customerId,
            projectId: current.projectId,
            currency: customer.defaultCurrency,
            grantId: current.id,
            amount: clawbackAmount,
            source: current.source,
            idempotencyKey: `expire:${current.id}`,
          })

          if (result.err) {
            throw result.err
          }

          await tx
            .update(walletCredits)
            .set({
              remainingAmount: 0,
              expiredAt: now,
            })
            .where(
              and(eq(walletCredits.id, current.id), eq(walletCredits.projectId, current.projectId))
            )

          expiredCount += 1
        })
      } catch (error) {
        // Per-grant failures don't fail the sweep — they'll retry on the
        // next tick. Log with the grant id for forensic follow-up.
        log.error("wallet.expire_grant_failed", {
          error: error instanceof Error ? error.message : String(error),
          grantId: grant.id,
          customerId: grant.customerId,
          projectId: grant.projectId,
        })
        skippedCount += 1
      }
    }

    await log.flush()

    return { expiredCount, skippedCount }
  },
})
