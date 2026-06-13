import type { Database } from "@unprice/db"
import type {
  InsertSubscription,
  InsertSubscriptionPhase,
  PaymentProvider,
  Subscription,
} from "@unprice/db/validators"
import { Err, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import { checkPaymentProviderAvailability } from "../payment-provider/availability"
import { activateWalletIfSubscriptionIsActive } from "./activate-wallet-if-active"

type CreateSubscriptionDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions" | "billing">
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

  const paymentProviders = new Set<PaymentProvider>()

  for (const phase of phases) {
    if (phase.paymentProvider) {
      paymentProviders.add(phase.paymentProvider)
      continue
    }

    const version = await deps.db.query.versions.findFirst({
      columns: {
        paymentProvider: true,
      },
      where: (fields, operators) =>
        operators.and(
          operators.eq(fields.id, phase.planVersionId),
          operators.eq(fields.projectId, projectId)
        ),
    })

    if (!version) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Version not found. Please check the planVersionId",
        })
      )
    }

    paymentProviders.add(version.paymentProvider)
  }

  for (const paymentProvider of paymentProviders) {
    const availability = await checkPaymentProviderAvailability(deps, {
      projectId,
      paymentProvider,
    })

    if (availability.err) {
      return Err(
        new UnPriceSubscriptionError({
          message: availability.err.message,
        })
      )
    }

    if (!availability.val.available) {
      return Err(
        new UnPriceSubscriptionError({
          message: availability.val.message,
          context: {
            paymentProvider,
            reason: availability.val.reason,
          },
        })
      )
    }
  }

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

  const billingPeriodsResult = await deps.services.billing.generateBillingPeriods({
    subscriptionId: result.val.id,
    projectId,
    now: Date.now(),
  })

  if (billingPeriodsResult.err) {
    return Err(new UnPriceSubscriptionError({ message: billingPeriodsResult.err.message }))
  }

  // Sub-create is a pure DB write up to here. Wallet activation only fires
  // for subscriptions that landed directly in `active`. Capped phases may
  // need a period `credit_line` grant; uncapped phases carry their policy to
  // the entitlement DO instead. Grants run through the state machine's
  // `activating` state so the same code path serves create and renewal.
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
