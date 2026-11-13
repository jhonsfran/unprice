import { BILLING_CONFIG } from "@unprice/db/utils"
import type { CollectionMethod, WhenToBill } from "@unprice/db/validators"

/** What each stored billing enum says to a person; the stored values never change. */

export const COLLECTION_METHOD_LABEL: Record<CollectionMethod, string> = {
  charge_automatically: "Charge the saved payment method",
  send_invoice: "Send an invoice",
}

export const COLLECTION_METHOD_NOTE: Record<CollectionMethod, string> = {
  charge_automatically: "The saved payment method is charged when an invoice is due.",
  send_invoice: "The customer receives the invoice and pays it by its due date.",
}

export const WHEN_TO_BILL_LABEL: Record<WhenToBill, string> = {
  pay_in_arrear: "At the end of the period",
  pay_in_advance: "At the start of the period",
}

export const WHEN_TO_BILL_NOTE: Record<WhenToBill, string> = {
  pay_in_arrear: "Each period is invoiced once it ends, usage included.",
  pay_in_advance: "Each period is invoiced when it starts.",
}

export function billingAnchorLabel(
  anchor: number | "dayOfCreation",
  billingInterval: string | undefined
): string {
  if (anchor === "dayOfCreation") return "The day the subscription starts"
  if (billingInterval === "year") return `Month ${anchor} of the year`
  return `Day ${anchor} of the month`
}

/** The billing cadences a version can pick; the minute cadences exist for testing and never ship. */
export function billingIntervalOptions(): { value: string; label: string; description: string }[] {
  const production = process.env.NODE_ENV === "production"
  const options: { value: string; label: string; description: string }[] = []
  for (const [key, config] of Object.entries(BILLING_CONFIG)) {
    // yearly and onetime stay off until the billing engine supports them
    if (key === "yearly" || key === "onetime") continue
    if (config.dev && production) continue
    options.push({
      value: key,
      label: config.dev ? `${config.label} (testing)` : config.label,
      description: config.description,
    })
  }
  return options
}
