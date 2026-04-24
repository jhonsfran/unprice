import { type Database, and, eq, sql } from "@unprice/db"
import { subscriptions } from "@unprice/db/schema"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"

import type { ServiceContext } from "../../context"
import { customerAccountKeys } from "../../ledger"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import type { AdjustSource, DrainLeg, UnPriceWalletError } from "../../wallet"

export type ActivateSubscriptionDeps = {
  services: Pick<ServiceContext, "subscriptions" | "wallet" | "ledger">
  db: Database
  logger: Logger
}

export interface ActivationPlanCredit {
  /** Credit amount in pgledger scale 8. */
  amount: number
  /** Which platform funding source this credit came from. */
  source: Extract<AdjustSource, "plan_included" | "promo" | "trial" | "manual">
  reason?: string
}

export interface ActivationReservationSpec {
  entitlementId: string
  requestedAmount: number
  refillThresholdBps: number
  refillChunkAmount: number
}

export interface ActivateSubscriptionInput {
  subscriptionId: string
  projectId: string
  periodStartAt: Date
  periodEndAt: Date
  idempotencyKey: string
  /**
   * Plan-included credits to issue at activation. Each entry creates a
   * `wallet_grants` row that expires at `periodEndAt` (you use them or
   * lose them). Pass an empty list for plans without included credits.
   */
  planIncludedCredits?: ActivationPlanCredit[]
  /**
   * Flat per-period base fee in pgledger scale 8. Drains from
   * `customer.*.available.purchased` into `customer.*.consumed` with
   * `kind: "subscription"`. Omit or pass 0 for zero-fee plans.
   */
  baseFeeAmount?: number
  /**
   * One entry per metered entitlement that needs a reservation for
   * this billing period. Compute `requestedAmount` per the plan's
   * sizing formula (see plan §"Reservation Sizing"): clamp
   * `price_per_event * 1000` between the min floor and ceiling.
   */
  reservations?: ActivationReservationSpec[]
}

export interface ActivatedReservation {
  entitlementId: string
  reservationId: string
  allocationAmount: number
  drainLegs: DrainLeg[]
}

export interface ActivatedGrant {
  grantId: string
  amount: number
}

export interface ActivateSubscriptionOutput {
  subscriptionId: string
  reservations: ActivatedReservation[]
  grantsIssued: ActivatedGrant[]
  baseFeeCharged: number
}

/**
 * Owns the transition to `active` for a new billing period. Per the
 * plan (§7.12), this is the **only** caller of
 * `walletService.createReservation`.
 *
 * All balance-changing steps execute inside a single `db.transaction`.
 * `WalletService` exposes executor-accepting overloads on `adjust`,
 * `transfer`, and `createReservation`, so the credits, base fee, and
 * reservations all share the outer tx — any step that fails rolls
 * back every ledger entry and every `wallet_grants` /
 * `entitlement_reservations` row written earlier in the activation.
 * The advisory lock is acquired once inside the tx and re-entered as
 * a no-op by each wallet call (session-scoped locks stack freely).
 *
 * Ordering: plan credits → base fee → reservations → markActive.
 * Plan credits come first so they're available to be drained by the
 * reservations that follow (priority drain: granted before purchased).
 */
export async function activateSubscription(
  deps: ActivateSubscriptionDeps,
  input: ActivateSubscriptionInput
): Promise<Result<ActivateSubscriptionOutput, UnPriceSubscriptionError | UnPriceWalletError>> {
  deps.logger.set({
    business: {
      operation: "subscription.activate",
      project_id: input.projectId,
    },
  })

  // 1. Load subscription to resolve customerId, currency, and to
  //    confirm it exists in this project. Pure read — no lock
  //    needed; the authoritative serialization happens under the
  //    customer advisory lock inside the transaction.
  const subscription = await deps.db.query.subscriptions.findFirst({
    with: {
      customer: { columns: { id: true, defaultCurrency: true } },
    },
    where: (sub, { and, eq }) =>
      and(eq(sub.id, input.subscriptionId), eq(sub.projectId, input.projectId)),
  })

  if (!subscription || !subscription.customer) {
    return Err(
      new UnPriceSubscriptionError({
        message: "subscription not found for activation",
        context: { subscriptionId: input.subscriptionId, projectId: input.projectId },
      })
    )
  }

  const customerId = subscription.customer.id
  const currency = subscription.customer.defaultCurrency

  const credits = input.planIncludedCredits ?? []
  const reservations = input.reservations ?? []
  const baseFeeAmount = input.baseFeeAmount ?? 0

  // 2. Pre-flight zero-balance policy. Fails fast for clearly-empty
  //    wallets before we open the tx. The authoritative check happens
  //    atomically inside each ledger transfer where pgledger enforces
  //    non-negativity — this is just an early-exit for the common case.
  const preflightErr = await checkPreflight(deps, {
    customerId,
    baseFeeAmount,
    plannedCredits: credits.reduce((sum, c) => sum + c.amount, 0),
    totalReservationRequested: reservations.reduce((sum, r) => sum + r.requestedAmount, 0),
  })

  if (preflightErr) {
    return Err(preflightErr)
  }

  try {
    return await deps.db.transaction(async (tx) => {
      // Single advisory lock held for the whole activation — the
      // nested wallet calls will try to re-acquire and no-op because
      // Postgres session-scoped advisory locks are re-entrant.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${customerId}`}))`)

      const grantsIssued: ActivatedGrant[] = []
      const reservationsOut: ActivatedReservation[] = []

      // 3. Issue plan-included credits (one wallet_grants row per entry).
      //    Each grant gets a deterministic idempotency suffix so retries
      //    of the same activation converge on the same grant row.
      for (let i = 0; i < credits.length; i++) {
        const credit = credits[i]!
        const { val, err } = await deps.services.wallet.adjust(
          {
            projectId: input.projectId,
            customerId,
            currency,
            signedAmount: credit.amount,
            actorId: "system:subscription-activation",
            reason: credit.reason ?? `Plan activation credit (${credit.source})`,
            source: credit.source,
            idempotencyKey: `activate:${input.idempotencyKey}:credit:${i}`,
            expiresAt: input.periodEndAt,
          },
          tx
        )
        if (err) {
          // Abort the whole tx — rolls back any earlier ledger entries
          // and wallet_grants rows written by this activation.
          throw new ActivationAbortError(err)
        }
        if (val.grantId) {
          grantsIssued.push({ grantId: val.grantId, amount: val.clampedAmount })
        }
      }

      // 4. Charge flat base fee (purchased → consumed). `kind: "subscription"`
      //    and `statement_key` satisfy the invoice projection contract so
      //    the base fee shows up as an invoice line (slice 7.8).
      if (baseFeeAmount > 0) {
        const keys = customerAccountKeys(customerId)
        const statementKey = `subscription:${input.subscriptionId}:${input.periodStartAt.toISOString()}`

        const { err } = await deps.services.wallet.transfer(
          {
            projectId: input.projectId,
            customerId,
            currency,
            fromAccountKey: keys.purchased,
            toAccountKey: keys.consumed,
            amount: baseFeeAmount,
            metadata: {
              flow: "subscription",
              kind: "subscription",
              statement_key: statementKey,
              subscription_id: input.subscriptionId,
              period_start_at: input.periodStartAt.toISOString(),
              period_end_at: input.periodEndAt.toISOString(),
              description: "Base subscription fee",
            },
            idempotencyKey: `activate:${input.idempotencyKey}:base_fee`,
          },
          tx
        )
        if (err) throw new ActivationAbortError(err)
      }

      // 5. Open a reservation per metered entitlement. Drains `granted`
      //    first (the credits we just issued), then `purchased` —
      //    WalletService.createReservation enforces the priority order.
      for (const spec of reservations) {
        const { val, err } = await deps.services.wallet.createReservation(
          {
            projectId: input.projectId,
            customerId,
            currency,
            entitlementId: spec.entitlementId,
            requestedAmount: spec.requestedAmount,
            refillThresholdBps: spec.refillThresholdBps,
            refillChunkAmount: spec.refillChunkAmount,
            periodStartAt: input.periodStartAt,
            periodEndAt: input.periodEndAt,
            idempotencyKey: `activate:${input.idempotencyKey}:reserve:${spec.entitlementId}`,
          },
          tx
        )
        if (err) throw new ActivationAbortError(err)

        // Partial fulfillment means insufficient funds. Zero-balance
        // policy: all-or-nothing. No partial activation.
        if (val.allocationAmount < spec.requestedAmount) {
          deps.logger.error("subscription.activate.partial_reservation", {
            entitlementId: spec.entitlementId,
            requested: spec.requestedAmount,
            allocated: val.allocationAmount,
          })
          throw new ActivationAbortError(
            new UnPriceSubscriptionError({
              message: "Insufficient funds: reservation partially filled",
              context: {
                entitlementId: spec.entitlementId,
                requestedAmount: spec.requestedAmount,
                allocationAmount: val.allocationAmount,
              },
            })
          )
        }

        reservationsOut.push({
          entitlementId: spec.entitlementId,
          reservationId: val.reservationId,
          allocationAmount: val.allocationAmount,
          drainLegs: val.drainLegs,
        })
      }

      // 6. Flip the subscription to active + stamp the billing cycle.
      await tx
        .update(subscriptions)
        .set({
          active: true,
          status: "active",
          currentCycleStartAt: input.periodStartAt.getTime(),
          currentCycleEndAt: input.periodEndAt.getTime(),
        })
        .where(
          and(
            eq(subscriptions.id, input.subscriptionId),
            eq(subscriptions.projectId, input.projectId)
          )
        )

      return Ok({
        subscriptionId: input.subscriptionId,
        reservations: reservationsOut,
        grantsIssued,
        baseFeeCharged: baseFeeAmount,
      })
    })
  } catch (error) {
    if (error instanceof ActivationAbortError) {
      return Err(error.inner)
    }
    deps.logger.error(error, {
      context: "subscription.activate.transaction_failed",
      subscriptionId: input.subscriptionId,
    })
    return Err(
      new UnPriceSubscriptionError({
        message: "subscription activation transaction failed",
        context: {
          subscriptionId: input.subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    )
  }
}

/**
 * Abort carrier for rolling back the activation tx while preserving
 * the typed domain error. Drizzle rolls the tx back when the callback
 * throws; this class makes it possible to unwrap the original
 * `UnPriceSubscriptionError | UnPriceWalletError` in the outer
 * `catch` and return it as a typed `Err(...)`.
 */
class ActivationAbortError extends Error {
  constructor(public readonly inner: UnPriceSubscriptionError | UnPriceWalletError) {
    super(inner.message)
    this.name = "ActivationAbortError"
  }
}

/**
 * Best-effort balance check before opening any ledger transfers. We
 * do not take the advisory lock here — this read can race with
 * concurrent writes. The authoritative non-negativity check happens
 * inside each `WalletService` method's transaction (pgledger enforces
 * non-negative customer balances at the account level). The value of
 * this pre-check is failing fast for clearly-empty wallets before
 * creating `wallet_grants` rows and running retries.
 */
async function checkPreflight(
  deps: ActivateSubscriptionDeps,
  input: {
    customerId: string
    baseFeeAmount: number
    plannedCredits: number
    totalReservationRequested: number
  }
): Promise<UnPriceSubscriptionError | null> {
  const keys = customerAccountKeys(input.customerId)

  const purchasedResult = await deps.services.ledger.getAccountBalance(keys.purchased)
  const grantedResult = await deps.services.ledger.getAccountBalance(keys.granted)

  // Missing accounts mean the customer has never transacted — treat
  // both balances as zero. That's the right answer for the math.
  const purchased = purchasedResult.err ? 0 : toLedgerMinor(purchasedResult.val)
  const granted = grantedResult.err ? 0 : toLedgerMinor(grantedResult.val)

  // Base fee always drains purchased. Reservations drain granted first
  // (including the credits we are about to issue), then purchased.
  const effectiveGranted = granted + input.plannedCredits
  const effectivePurchased = purchased - input.baseFeeAmount

  if (effectivePurchased < 0) {
    return new UnPriceSubscriptionError({
      message: "Insufficient funds: base fee exceeds available purchased balance",
      context: {
        required: input.baseFeeAmount,
        available: purchased,
      },
    })
  }

  if (effectiveGranted + effectivePurchased < input.totalReservationRequested) {
    return new UnPriceSubscriptionError({
      message: "Insufficient funds: total reservation requested exceeds available balance",
      context: {
        required: input.totalReservationRequested,
        availableGranted: effectiveGranted,
        availablePurchased: effectivePurchased,
      },
    })
  }

  return null
}
