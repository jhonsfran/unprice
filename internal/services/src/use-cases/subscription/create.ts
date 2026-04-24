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

  // Phase 7 wallet activation: after the transaction commits, trigger
  // the state machine ACTIVATE event to create pgledger accounts
  // (plan credits + per-meter reservations). Must run AFTER commit
  // so the machine can read the committed subscription data.
  const subscription = result.val
  const activateResult = await deps.services.subscriptions.activateWallet({
    subscriptionId: subscription.id,
    projectId,
    now: Date.now(),
  })

  if (activateResult?.err) {
    deps.logger.error(activateResult.err, {
      subscriptionId: subscription.id,
      projectId,
      context: "wallet activation failed after subscription create",
    })
  }

  return result
}
