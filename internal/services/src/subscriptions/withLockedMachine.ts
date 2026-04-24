import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import type { CustomerService } from "../customers/service"
import type { LedgerGateway } from "../ledger"
import type { RatingService } from "../rating/service"
import type { WalletService } from "../wallet"
import { SubscriptionMachine } from "./machine"
import type { SubscriptionRepository } from "./repository"
import { SubscriptionLock } from "./subscriptionLock"

/**
 * Shared lock → machine → run → shutdown → release lifecycle.
 * No heartbeat — 60s TTL + staleTakeoverMs (120s) covers all operations.
 */
export async function withLockedMachine<T>(args: {
  subscriptionId: string
  projectId: string
  now: number
  lock?: boolean
  ttlMs?: number
  db: Database
  repo: SubscriptionRepository
  dryRun?: boolean
  logger: Logger
  analytics: Analytics
  customer: CustomerService
  ratingService: RatingService
  ledgerService: LedgerGateway
  walletService?: WalletService
  setLockContext?: (context: {
    type?: "metric" | "normal" | "wide_event"
    resource?: string
    action?: string
    acquired?: boolean
    ttl_ms?: number
  }) => void
  run: (m: SubscriptionMachine) => Promise<T>
}): Promise<T> {
  const {
    subscriptionId,
    projectId,
    now,
    run,
    lock: shouldLock = true,
    ttlMs = 60_000,
    db,
    repo,
    dryRun = false,
    logger,
    analytics,
    customer,
    ratingService,
    ledgerService,
    walletService,
    setLockContext,
  } = args

  const lock =
    shouldLock && !dryRun
      ? new SubscriptionLock({ db, projectId, subscriptionId })
      : null

  if (lock) {
    const acquired = await lock.acquire({
      ttlMs,
      now,
      staleTakeoverMs: 120_000,
      ownerStaleMs: ttlMs,
    })

    setLockContext?.({
      type: "normal",
      resource: "subscription",
      action: "acquire",
      acquired,
      ttl_ms: ttlMs,
    })

    if (!acquired) {
      logger.warn("subscription lock acquire returned false; lock may be held", {
        subscriptionId,
        projectId,
        ttlMs,
      })
      throw new Error("SUBSCRIPTION_BUSY")
    }
  }

  const { err, val: machine } = await SubscriptionMachine.create({
    now,
    subscriptionId,
    projectId,
    logger,
    analytics,
    customer,
    ratingService,
    ledgerService,
    walletService,
    db,
    repo,
    dryRun,
  })

  if (err) {
    if (lock) await lock.release()
    throw err
  }

  try {
    return await run(machine)
  } finally {
    await machine.shutdown()
    if (lock) await lock.release()
  }
}
