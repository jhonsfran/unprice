"use client"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { CustomerActions } from "../../_components/customers/customer-actions"

type Customer = RouterOutputs["customers"]["getSubscriptions"]["customer"]

export function CustomerHeaderActions({
  customer,
}: {
  customer: Customer
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <CustomerActions customer={customer} />
    </div>
  )
}
