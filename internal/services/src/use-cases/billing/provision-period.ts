import { type Database, and, eq, sql } from "@unprice/db"
import { subscriptions } from "@unprice/db/schema"
import type { WalletCreditSource } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"

import type { ServiceContext } from "../../context"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import { toErrorContext } from "../../utils/log-context"
import type { UnPriceWalletError } from "../../wallet"

export type ActivateSubscriptionDeps = {
  services: Pick<ServiceContext, "subscriptions" | "wallet" | "ledger">
  db: Database
  logger: Logger
}

/**
 * One additive grant to issue at activation. Each entry creates one
 * `wallet_credits` row (`adjust(signedAmount > 0, expiresAt = periodEndAt)`).
 *
 * Sources:
 * - `plan_included` — flat plan-included credit baked into the plan version
 * - `trial` — trial credits issued when the subscription enters `trialing`
 * - `credit_line` — postpaid spending cap for `pay_in_arrear` plans;
 *    issued at activation and at each renewal, expires at periodEndAt.
 *    The DO drains it like any other granted balance, and period-end
 *    invoicing charges the consumed amount against the customer's saved
 *    payment method (success → reissue, failure → past_due, no reissue).
 * - `promo` / `manual` — admin-driven, included for completeness; not
 *    typically derived from the plan.
 */
export interface ActivationGrant {
  /** Credit amount in pgledger scale 8. Must be > 0. */
  amount: number
  source: WalletCreditSource
  reason?: string
}

export interface ActivateSubscriptionInput {
  subscriptionId: string
  projectId: string
  periodStartAt: Date
  periodEndAt: Date
  idempotencyKey: string
  /**
   * Additive wallet grants to issue at activation. Each entry creates one
   * `wallet_credits` row that expires at `periodEndAt`. This is the only
   * money movement activation owns — base fees and usage are settled by
   * the invoicing flow at period boundaries; usage reservations are
   * created lazily by the EntitlementWindowDO on first priced event.
   */
  grants?: ActivationGrant[]
}

export interface IssuedGrant {
  grantId: string
  amount: number
  source: ActivationGrant["source"]
}

export interface ActivateSubscriptionOutput {
  subscriptionId: string
  grantsIssued: IssuedGrant[]
}

/**
 * Issues additive wallet grants for a billing period and flips the
 * subscription to `active`.
 *
 * Reservations are created lazily by the EntitlementWindowDO on first
 * priced usage event — they're not opened here. Base fees settle through
 * the invoicing flow at period boundaries — also not transferred here.
 *
 * Single transaction, single advisory lock per customer. Any grant
 * failing aborts the tx (no partial activation). Idempotency suffix
 * `:grant:{i}` keeps retries convergent on the same `wallet_credits` row.
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
  const grants = (input.grants ?? []).filter((g) => g.amount > 0)

  const seedResult = await deps.services.wallet.ensureCustomerAccounts({
    projectId: input.projectId,
    customerId,
    currency,
  })
  if (seedResult.err) return Err(seedResult.err)

  try {
    return await deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${customerId}`}))`)

      const grantsIssued: IssuedGrant[] = []

      for (let i = 0; i < grants.length; i++) {
        const grant = grants[i]!
        const { val, err } = await deps.services.wallet.adjust(
          {
            projectId: input.projectId,
            customerId,
            currency,
            signedAmount: grant.amount,
            actorId: "system:subscription-activation",
            reason: grant.reason ?? `Plan activation grant (${grant.source})`,
            source: grant.source,
            idempotencyKey: `activate:${input.idempotencyKey}:grant:${i}`,
            expiresAt: input.periodEndAt,
          },
          tx
        )
        if (err) {
          throw new ActivationAbortError(err)
        }
        if (val.grantId) {
          grantsIssued.push({
            grantId: val.grantId,
            amount: val.clampedAmount,
            source: grant.source,
          })
        }
      }

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
        grantsIssued,
      })
    })
  } catch (error) {
    if (error instanceof ActivationAbortError) {
      return Err(error.inner)
    }
    deps.logger.error("subscription.activate.transaction_failed", {
      error: toErrorContext(error),
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

class ActivationAbortError extends Error {
  constructor(public readonly inner: UnPriceSubscriptionError | UnPriceWalletError) {
    super(inner.message)
    this.name = "ActivationAbortError"
  }
}
