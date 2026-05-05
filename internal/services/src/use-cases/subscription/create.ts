import type { Database } from "@unprice/db"
import type {
  InsertSubscription,
  InsertSubscriptionPhase,
  Subscription,
} from "@unprice/db/validators"
import { Err, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import { activateWalletIfSubscriptionIsActive } from "./activate-wallet-if-active"

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

  let transactionError: UnPriceSubscriptionError | SchemaError | undefined

  const result = await deps.db
    .transaction(async (tx) => {
      const { err, val: subscription } = await deps.services.subscriptions.createSubscription({
        input: subscriptionInput,
        projectId,
        db: tx,
      })

      if (err) {
        transactionError = err
        throw err
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
          transactionError = phaseErr
          throw phaseErr
        }
      }

      return subscription
    })
    .then((subscription) => Ok(subscription))
    .catch((error) =>
      Err(
        transactionError ??
          new UnPriceSubscriptionError({
            message: error instanceof Error ? error.message : String(error),
          })
      )
    )

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
  // The activating XState actor parks failed activations in
  // `pending_activation`; the machine subscriber has already persisted that
  // status to the DB before we return here. The bouncer / ACL layer denies
  // ingestion while in that state, and the activation sweeper retries grant
  // issuance until it succeeds.
  await activateWalletIfSubscriptionIsActive(deps, {
    subscriptionId: subscription.id,
    projectId,
    context: "wallet activation failed; subscription parked in pending_activation",
  })

  return result
}
