import { logger, schedules } from "@trigger.dev/sdk/v3"
import { Analytics } from "@unprice/analytics"
import { CacheService } from "@unprice/services/cache"
import { createServiceContext } from "@unprice/services/context"
import { NoopMetrics } from "@unprice/services/metrics"
import { expireWalletCredits } from "@unprice/services/use-cases"
import { env } from "../../env"
import { db } from "../db"

type WalletCreditExpirationLogger = Parameters<typeof expireWalletCredits>[0]["logger"]

/**
 * Sweeps `wallet_credits` whose `expires_at` has passed and claws the
 * remaining balance back to the matching platform funding account.
 *
 * Runs every 5 minutes. One transaction per grant so different customers
 * proceed in parallel; the per-customer advisory lock serializes this sweep
 * against concurrent drains/reservations for the same customer without
 * blocking the platform.
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
    const log = logger as unknown as WalletCreditExpirationLogger

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

    const result = await expireWalletCredits(
      {
        db,
        logger: log,
        services: { wallet: services.wallet },
      },
      {
        now,
        limit: 500,
      }
    )

    logger.info("wallet.expire-grants.complete", { ...result })

    return result
  },
})
