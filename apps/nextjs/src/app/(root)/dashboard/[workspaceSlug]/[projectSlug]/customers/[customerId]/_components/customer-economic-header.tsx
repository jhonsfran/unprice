import type { RouterOutputs } from "@unprice/trpc/routes"
import HeaderTab from "~/components/layout/header-tab"
import { CustomerHeaderActions } from "./customer-header-actions"

type Customer = RouterOutputs["customers"]["getSubscriptions"]["customer"]

export function CustomerEconomicHeader({
  customer,
}: {
  customer: Customer
}) {
  const activeSubscriptions = customer.subscriptions.filter(
    (subscription) => subscription.active
  ).length
  const invoiceCount = customer.invoices.length
  const descriptionParts = [
    customer.description,
    `${activeSubscriptions} active ${activeSubscriptions === 1 ? "subscription" : "subscriptions"}`,
    `${invoiceCount} ${invoiceCount === 1 ? "invoice" : "invoices"}`,
  ].filter(Boolean)

  return (
    <HeaderTab
      title={customer.email}
      description={descriptionParts.join(" - ")}
      label={customer.active ? "active" : "inactive"}
      id={customer.id}
      action={<CustomerHeaderActions customer={customer} />}
    />
  )
}
