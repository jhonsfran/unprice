"use client"

import { calculateFlatPricePlan, getTrialUnitLabel } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { PlanVersionPublish } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/_components/plan-version-actions"
import { PlanVersionFeatureListItem } from "~/components/billing/plan-version-feature-list"

export type PlanVersionPricingCardAction =
  | { kind: "current"; label: "Current plan" }
  | { kind: "select"; label: string; onSelect: () => void }
  | { kind: "disabled"; label: string; reason: string }
  | { kind: "publish"; onPublish?: () => void }

export function PlanVersionPricingCard({
  planVersion,
  action,
  highlight = false,
  className,
}: {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
  action: PlanVersionPricingCardAction
  highlight?: boolean
  className?: string
}) {
  if (!planVersion) return null

  const { err, val } = calculateFlatPricePlan({
    planVersion,
    prorate: 1,
  })

  if (err) {
    return <>Error calculating price</>
  }

  const trialUnits = planVersion.trialUnits ?? 0
  const trialUnitLabel = getTrialUnitLabel({
    billingInterval: planVersion.billingConfig.billingInterval,
    units: trialUnits,
  })
  const billingLabel = planVersion.billingConfig.name

  return (
    <Card
      className={cn("flex w-[300px] flex-col", highlight && "border-primary shadow-sm", className)}
    >
      <CardHeader className="gap-2 pb-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold text-2xl leading-tight">{planVersion.plan.title}</h2>
          {action.kind === "current" && <Badge variant="secondary">{action.label}</Badge>}
        </div>
        {planVersion.description && (
          <CardDescription className="line-clamp-2">{planVersion.description}</CardDescription>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pb-6">
        {!planVersion.plan.enterprisePlan && (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-extrabold text-4xl tracking-tight">{val.displayAmount}</span>
              <span className="text-muted-foreground text-sm">/ {billingLabel}</span>
            </div>
            {trialUnits > 0 && (
              <p className="text-muted-foreground text-xs">
                {trialUnits} {trialUnitLabel} free trial
              </p>
            )}
          </div>
        )}

        <PricingCardAction action={action} planVersionId={planVersion.id} />
      </CardContent>

      <CardFooter className="flex w-full flex-col border-t px-6 py-6">
        <div className="flex w-full flex-col gap-4">
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            What's included
          </p>
          <ul className="flex w-full flex-col gap-3">
            {[...planVersion.planFeatures]
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .filter((feature) => !feature.metadata?.hidden)
              .map((feature) => (
                <li key={feature.id} className="flex w-full flex-col justify-start">
                  <PlanVersionFeatureListItem feature={feature} withCalculator withQuantity />
                </li>
              ))}
          </ul>
        </div>
      </CardFooter>
    </Card>
  )
}

function PricingCardAction({
  action,
  planVersionId,
}: {
  action: PlanVersionPricingCardAction
  planVersionId: string
}) {
  switch (action.kind) {
    case "publish":
      return <PlanVersionPublish planVersionId={planVersionId} onConfirmAction={action.onPublish} />
    case "select":
      return (
        <Button className="w-full" onClick={action.onSelect}>
          {action.label}
        </Button>
      )
    case "disabled":
      return (
        <div className="flex flex-col gap-1">
          <Button className="w-full" disabled>
            {action.label}
          </Button>
          <p className="text-muted-foreground text-xs">{action.reason}</p>
        </div>
      )
    case "current":
      return (
        <Button className="w-full" disabled>
          {action.label}
        </Button>
      )
  }
}
