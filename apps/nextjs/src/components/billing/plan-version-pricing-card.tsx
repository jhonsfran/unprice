"use client"

import { calculateFlatPricePlan, getTrialUnitLabel } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@unprice/ui/card"
import { Separator } from "@unprice/ui/separator"
import { cn } from "@unprice/ui/utils"
import { PlanVersionFeatureListItem } from "~/components/billing/plan-version-feature-list"

export type PlanVersionPricingCardAction =
  | { kind: "current"; label: "Current plan" }
  | {
      kind: "select"
      label: string
      onSelect: () => void
      selected?: boolean
    }
  | { kind: "disabled"; label: string; reason: string }
  | { kind: "publish"; onPublish?: () => void }

export function PlanVersionPricingCard({
  planVersion,
  action,
  highlight = false,
  className,
  renderAction,
}: {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
  action: PlanVersionPricingCardAction
  highlight?: boolean
  className?: string
  renderAction?: (action: PlanVersionPricingCardAction) => React.ReactNode
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
  const actionElement = renderAction?.(action) ?? <PricingCardAction action={action} />
  const visibleFeatures = [...planVersion.planFeatures]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((feature) => !feature.metadata?.hidden)
  const isInteractive = action.kind === "select" || action.kind === "publish"
  const isSelected = action.kind === "select" && action.selected
  const isEmphasized = highlight || isSelected

  return (
    <Card
      className={cn(
        "group flex h-full w-[300px] flex-col overflow-hidden border-border bg-card transition-[background-color,border-color,box-shadow] duration-200",
        isInteractive && "hover:border-primary-borderHover hover:bg-background-bgSubtle",
        isEmphasized && "border-primary-border shadow-sm",
        className
      )}
    >
      <CardHeader className="gap-5 p-6 pb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle className="truncate font-semibold text-2xl leading-tight">
              {planVersion.plan.title}
            </CardTitle>
            {planVersion.description && (
              <CardDescription className="line-clamp-2 text-sm leading-5">
                {planVersion.description}
              </CardDescription>
            )}
          </div>
          <PricingCardStateBadge action={action} />
        </div>

        {!planVersion.plan.enterprisePlan && (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="font-extrabold text-4xl text-background-textContrast tracking-tight">
                {val.displayAmount}
              </span>
              <span className="font-medium text-muted-foreground text-sm">/ {billingLabel}</span>
            </div>
            {trialUnits > 0 && (
              <p className="text-muted-foreground text-xs">
                {trialUnits} {trialUnitLabel} free trial
              </p>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-6 pb-6">{actionElement}</CardContent>

      <Separator />

      <CardFooter className="flex w-full flex-col px-6 py-6">
        <div className="flex w-full flex-col gap-4">
          <p className="font-semibold text-background-text text-xs">Included in this plan</p>
          <ul className="flex w-full flex-col gap-3">
            {visibleFeatures.map((feature) => (
              <li key={feature.id} className="flex w-full flex-col justify-start">
                <PlanVersionFeatureListItem
                  feature={feature}
                  withCalculator
                  withQuantity
                  className="font-medium text-background-text"
                />
              </li>
            ))}
          </ul>
        </div>
      </CardFooter>
    </Card>
  )
}

function PricingCardStateBadge({ action }: { action: PlanVersionPricingCardAction }) {
  if (action.kind === "current") {
    return <Badge variant="secondary">{action.label}</Badge>
  }

  if (action.kind === "select" && action.selected) {
    return <Badge variant="primary">Selected</Badge>
  }

  if (action.kind === "disabled") {
    return <Badge variant="secondary">Unavailable</Badge>
  }

  return null
}

function PricingCardAction({ action }: { action: PlanVersionPricingCardAction }) {
  switch (action.kind) {
    case "publish":
      return (
        <Button className="w-full" disabled>
          Publish
        </Button>
      )
    case "select":
      return (
        <Button className="w-full" onClick={action.onSelect}>
          {action.label}
        </Button>
      )
    case "disabled":
      return (
        <div className="flex flex-col gap-2">
          <Button className="w-full" variant="outline" disabled>
            {action.label}
          </Button>
          <p className="text-muted-foreground text-xs">{action.reason}</p>
        </div>
      )
    case "current":
      return (
        <Button className="w-full disabled:opacity-100" variant="outline" disabled>
          {action.label}
        </Button>
      )
  }
}
