import { BadgeCheck, Plus } from "lucide-react"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@unprice/ui/card"
import { Separator } from "@unprice/ui/separator"
import { cn } from "@unprice/ui/utils"

import { PlanVersionDialog } from "../[planSlug]/_components/plan-version-dialog"
import { PlanActions } from "./plan-actions"

export default function PlanHeader(props: {
  workspaceSlug: string
  projectSlug: string
  planVersionId: string
  plan: RouterOutputs["plans"]["getBySlug"]["plan"]
  className?: string
}) {
  const { plan } = props
  return (
    <Card>
      <div className="flex flex-row justify-between">
        <div className="flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle>{plan.slug.toUpperCase()}</CardTitle>
            <CardDescription className="line-clamp-2 h-12 max-w-lg text-balance leading-relaxed">
              {plan.description}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <div className="flex space-x-2">
              <Badge
                className={cn({
                  success: plan.active,
                  danger: !plan.active,
                })}
              >
                <span className="flex h-2 w-2 rounded-full bg-success-solid" />
                <span className="ml-1">{plan.active ? "active" : "inactive"}</span>
              </Badge>

              {plan.defaultPlan && (
                <Badge>
                  <BadgeCheck className="h-3 w-3" />
                  <span className="ml-1">{"default"}</span>
                </Badge>
              )}
            </div>
          </CardFooter>
        </div>

        <div className="flex items-center px-6">
          <div className="button-primary flex items-center space-x-1 rounded-md">
            <div className="sm:col-span-full">
              <PlanVersionDialog
                defaultValues={{
                  planId: plan.id,
                  description: plan.description,
                  title: plan.slug,
                  projectId: plan.projectId,
                  // TODO: use default currency from org settings
                  currency: "USD",
                  paymentProvider: "sandbox",
                  collectionMethod: "charge_automatically",
                  whenToBill: "pay_in_arrear",
                  trialUnits: 0,
                  autoRenew: true,
                  paymentMethodRequired: false,
                  billingConfig: {
                    name: "monthly",
                    billingInterval: "month",
                    billingIntervalCount: 1,
                    billingAnchor: "dayOfCreation",
                    planType: "recurring",
                  },
                  isDefault: plan.defaultPlan ?? false,
                }}
              >
                <Button variant={"custom"}>
                  <Plus className="mr-2 h-4 w-4" /> Version
                </Button>
              </PlanVersionDialog>
            </div>

            <Separator orientation="vertical" className="h-[20px] p-0" />

            <PlanActions plan={plan} />
          </div>
        </div>
      </div>
    </Card>
  )
}
