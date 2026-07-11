"use client"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Code } from "lucide-react"
import { useSelectedLayoutSegments } from "next/navigation"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { CustomerActions } from "../../_components/customers/customer-actions"

type Customer = RouterOutputs["customers"]["getSubscriptions"]["customer"]

export function CustomerHeaderActions({
  customer,
}: {
  customer: Customer
}) {
  const segments = useSelectedLayoutSegments().filter((segment) => !segment.startsWith("("))
  const isRunsTab = segments[0] === "runs"

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {isRunsTab && (
        <CodeApiSheet defaultMethod="startBudgetedRun" exampleParams={{ customerId: customer.id }}>
          <Button variant="link">
            <Code className="mr-2 h-4 w-4" />
            API
          </Button>
        </CodeApiSheet>
      )}
      <CustomerActions customer={customer} />
    </div>
  )
}
