import type { RouterOutputs } from "@unprice/trpc/routes"
import HeaderTab from "~/components/layout/header-tab"
import { CustomerActions } from "../../_components/customers/customer-actions"

type Customer = RouterOutputs["customers"]["getSubscriptions"]["customer"]

export function CustomerEconomicHeader({
  customer,
}: {
  customer: Customer
}) {
  return (
    <HeaderTab
      title={customer.email}
      description={customer.description}
      label={customer.active ? "active" : "inactive"}
      id={customer.id}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <CustomerActions customer={customer} />
        </div>
      }
    />
  )
}
