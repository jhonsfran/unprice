import type { Database } from "@unprice/db"
import type {
  InsertSubscription,
  InsertSubscriptionPhase,
  Subscription,
} from "@unprice/db/validators"
import { Err, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import type { UnPriceSubscriptionError } from "../../subscriptions/errors"

type CreateSubscriptionDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions">
  db: Database
  logger: Logger
}

type CreateSubscriptionInput = {
  input: InsertSubscription
  projectId: string
}

export async function createSubscription(
  deps: CreateSubscriptionDeps,
  params: CreateSubscriptionInput
): Promise<Result<Subscription, UnPriceSubscriptionError | SchemaError>> {
  const { input, projectId } = params
  const { phases, ...subscriptionInput } = input

  deps.logger.set({
    business: {
      operation: "subscription.create",
      project_id: projectId,
      customer_id: input.customerId,
    },
  })

  const result = await deps.db.transaction(async (tx) => {
    const { err, val: subscription } = await deps.services.subscriptions.createSubscription({
      input: subscriptionInput,
      projectId,
      db: tx,
    })

    if (err) {
      return Err(err)
    }

    const now = Date.now()

    for (const phase of phases) {
      const { err: phaseErr } = await deps.services.subscriptions.createPhase({
        input: {
          ...phase,
          subscriptionId: subscription.id,
        } as InsertSubscriptionPhase,
        projectId,
        db: tx,
        now,
      })

      if (phaseErr) {
        return Err(phaseErr)
      }
    }

    return Ok(subscription)
  })

  if (result.err) {
    return result
  }

  // Sub-create is a pure DB write up to here. Wallet activation only fires
  // for subscriptions that landed directly in `active` — pay_in_arrear plans
  // (which need their period credit_line grant) and free / no-payment-method
  // plans (no-op grants but cheap to call). Grants run through the state
  // machine's `activating` state so the same code path serves create and
  // renewal.
  //
  // - `trialing`        → trial grant is issued at trialing entry; no
  //                        ACTIVATE event needed.
  // - `pending_payment` → payment provider webhook fires PAYMENT_SUCCESS
  //                        on first paid invoice/topup; that transition
  //                        runs through `activating` and issues grants.
  //
  // Reservations are never opened here — EntitlementWindowDO opens them
  // lazily on first priced usage event.
  const subscription = result.val
  const refreshed = await deps.services.subscriptions.getSubscriptionData({
    subscriptionId: subscription.id,
    projectId,
  })

  if (refreshed?.status === "active" && deps.services.subscriptions.activateWallet) {
    const activateResult = await deps.services.subscriptions.activateWallet({
      subscriptionId: subscription.id,
      projectId,
      now: Date.now(),
    })

    if (activateResult?.err) {
      // Activation failures are non-fatal at sub-create — the customer can
      // still see the subscription, and a retry (manual or via the next
      // billing tick) re-attempts the grants. Reservations don't depend on
      // grants existing yet (the DO will open one against `purchased` if
      // it's funded, or deny with WALLET_EMPTY if it isn't).
      deps.logger.error(activateResult.err, {
        subscriptionId: subscription.id,
        projectId,
        context: "wallet activation failed after subscription create",
      })
    }
  }

  return result
}
