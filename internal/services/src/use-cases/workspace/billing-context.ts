import type { PaymentProvider } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { CustomerCache } from "../../cache"
import type { ServiceContext } from "../../context"
import type { UnPriceCustomerError } from "../../customers/errors"

export type WorkspaceBillingContextWorkspace = {
  id: string
  slug: string
  unPriceCustomerId: string | null
}

export type WorkspaceBillingContext = {
  customerId: string
  customer: CustomerCache
  billingProjectId: string
  customerCurrency: NonNullable<CustomerCache["defaultCurrency"]>
}

/**
 * Discriminated resolution of a workspace's billing context. Real customer-service
 * failures propagate as `Err`; the domain preconditions (missing customer id,
 * missing customer, missing currency) come back as `{ ok: false, reason }` so each
 * caller can translate them into its own error class with the codes/kinds it needs.
 */
export type WorkspaceBillingContextResolution =
  | { ok: true; context: WorkspaceBillingContext }
  | { ok: false; reason: "customer_id_missing" | "customer_not_found" | "currency_not_found" }

export async function resolveWorkspaceBillingContext(
  deps: { services: Pick<ServiceContext, "customers"> },
  workspace: WorkspaceBillingContextWorkspace
): Promise<Result<WorkspaceBillingContextResolution, FetchError | UnPriceCustomerError>> {
  const customerId = workspace.unPriceCustomerId

  if (!customerId) {
    return Ok({ ok: false, reason: "customer_id_missing" })
  }

  const customerResult = await deps.services.customers.getCustomerByIdAcrossProjects(customerId, {
    skipCache: true,
  })

  if (customerResult.err) {
    return Err(customerResult.err)
  }

  const customer = customerResult.val

  if (!customer) {
    return Ok({ ok: false, reason: "customer_not_found" })
  }

  const customerCurrency = customer.defaultCurrency ?? customer.project.defaultCurrency

  if (!customerCurrency) {
    return Ok({ ok: false, reason: "currency_not_found" })
  }

  return Ok({
    ok: true,
    context: {
      customerId,
      customer,
      billingProjectId: customer.projectId,
      customerCurrency,
    },
  })
}

export function paymentMethodRequiredReason(paymentProvider: PaymentProvider): string {
  switch (paymentProvider) {
    case "sandbox":
      return "Add a payment method before changing to this plan."
    case "square":
    case "stripe":
      return "Add a default payment method before changing to this plan."
  }
}
