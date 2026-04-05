import type { Database } from "@unprice/db"
import type { InsertSubscription, Subscription } from "@unprice/db/validators"
import type { Result, SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import type { UnPriceSubscriptionError } from "../../subscriptions/errors"

type CreateSubscriptionDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions">
  db: Database
  logger: Logger
}

type CreateSubscriptionInput = {
  input: Omit<InsertSubscription, "phases">
  projectId: string
}

export async function createSubscription(
  deps: CreateSubscriptionDeps,
  params: CreateSubscriptionInput
): Promise<Result<Subscription, UnPriceSubscriptionError | SchemaError>> {
  const { input, projectId } = params

  deps.logger.set({
    business: {
      operation: "subscription.create",
      project_id: projectId,
      customer_id: input.customerId,
    },
  })

  return deps.db.transaction(async (tx) => {
    return deps.services.subscriptions.createSubscription({
      input,
      projectId,
      db: tx,
    })
  })
}
