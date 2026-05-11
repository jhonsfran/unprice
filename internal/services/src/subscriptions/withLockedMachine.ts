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

export class LockLostError extends Error {
  readonly name = "LockLostError"
  constructor(subscriptionId: string) {
    super(`Subscription lock lost for ${subscriptionId}`)
  }
}

/**
 * Shared lock → machine → run → shutdown → release lifecycle.
 * Keeps the lock alive while the machine operation is in flight so a slow
 * billing/payment provider call cannot expire ownership under the active worker.
 *
 * If the heartbeat detects that the lock has been taken over by another worker,
 * it sets an internal flag. Callers can use `assertLockHeld()` before committing
 * critical state to abort early instead of racing with the new owner.
 */
export async function withLockedMachine<T>(args: {
  subscriptionId: string
  projectId: string
  now: number
  lock?: boolean
  ttlMs?: number
  lockHeartbeatIntervalMs?: number
  lockNow?: () => number
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
  run: (m: SubscriptionMachine, assertLockHeld: () => void) => Promise<T>
}): Promise<T> {
  const {
    subscriptionId,
    projectId,
    now,
    run,
    lock: shouldLock = true,
    ttlMs = 60_000,
    lockHeartbeatIntervalMs,
    lockNow = Date.now,
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
    shouldLock && !dryRun ? new SubscriptionLock({ db, projectId, subscriptionId }) : null
  let stopLockHeartbeat = () => {}
  let lockLost = false

  const assertLockHeld = () => {
    if (lockLost) {
      throw new LockLostError(subscriptionId)
    }
  }

  if (lock) {
    const acquired = await lock.acquire({
      ttlMs,
      now: lockNow(),
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

    stopLockHeartbeat = startLockHeartbeat({
      heartbeatIntervalMs: lockHeartbeatIntervalMs,
      lock,
      lockNow,
      logger,
      projectId,
      setLockContext,
      subscriptionId,
      ttlMs,
      onLockLost: () => {
        lockLost = true
      },
    })
  }

  let machine: SubscriptionMachine | null = null

  try {
    const { err, val } = await SubscriptionMachine.create({
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
      throw err
    }

    machine = val
    return await run(machine, assertLockHeld)
  } finally {
    try {
      if (machine) {
        await machine.shutdown()
      }
    } finally {
      stopLockHeartbeat()
      if (lock) await lock.release()
    }
  }
}

function startLockHeartbeat(args: {
  heartbeatIntervalMs?: number
  lock: SubscriptionLock
  lockNow: () => number
  logger: Logger
  projectId: string
  setLockContext?: (context: {
    type?: "metric" | "normal" | "wide_event"
    resource?: string
    action?: string
    acquired?: boolean
    ttl_ms?: number
  }) => void
  subscriptionId: string
  ttlMs: number
  onLockLost: () => void
}): () => void {
  const intervalMs = Math.max(1, args.heartbeatIntervalMs ?? Math.floor(args.ttlMs / 2))
  let stopped = false
  let extending = false
  const timer = setInterval(() => {
    if (stopped || extending) return

    extending = true
    void args.lock
      .extend({ ttlMs: args.ttlMs, now: args.lockNow() })
      .then((extended) => {
        args.setLockContext?.({
          type: "normal",
          resource: "subscription",
          action: "extend",
          acquired: extended,
          ttl_ms: args.ttlMs,
        })

        if (!extended) {
          args.onLockLost()
          args.logger.warn("subscription lock heartbeat returned false; lock may have been lost", {
            subscriptionId: args.subscriptionId,
            projectId: args.projectId,
            ttlMs: args.ttlMs,
          })
        }
      })
      .catch((error: unknown) => {
        args.onLockLost()
        args.logger.error(error instanceof Error ? error : new Error(String(error)), {
          subscriptionId: args.subscriptionId,
          projectId: args.projectId,
          ttlMs: args.ttlMs,
          context: "subscription lock heartbeat failed",
        })
      })
      .finally(() => {
        extending = false
      })
  }, intervalMs)

  const nodeTimer = timer as { unref?: () => void }
  nodeTimer.unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
