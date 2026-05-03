import { calculateFlatPricePlan } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { PlanVersionPublish } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/_components/plan-version-actions"
import { PricingItem } from "~/components/forms/pricing-item"

export function PricingCard({
  planVersion,
  onPublish,
  className,
  showPublish = true,
}: {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
  onPublish?: () => void
  className?: string
  /** Render the Publish CTA when the version is a draft. Set false when Publish lives elsewhere (e.g., the page header). */
  showPublish?: boolean
}) {
  if (!planVersion) return null

  const { err, val } = calculateFlatPricePlan({
    planVersion,
    prorate: 1,
  })

  if (err) {
    return <>Error calculating price</>
  }

  const isPublished = planVersion.status === "published"
  const trialUnits = planVersion.trialUnits ?? 0
  const trialUnitLabel = planVersion.billingConfig.billingInterval
  const billingLabel = planVersion.billingConfig.name

  return (
    <Card className={cn("flex w-[300px] flex-col", className)}>
      <CardHeader className="space-y-2 pb-4">
        <Typography variant="h2" className="leading-tight">
          {planVersion.plan.title}
        </Typography>
        {planVersion.description && (
          <CardDescription className="line-clamp-2">{planVersion.description}</CardDescription>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pb-6">
        {!planVersion.plan.enterprisePlan && (
          <div className="space-y-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-extrabold text-4xl tracking-tight">{val.displayAmount}</span>
              <span className="text-muted-foreground text-sm">/ {billingLabel}</span>
            </div>
            {trialUnits > 0 && (
              <p className="text-muted-foreground text-xs">
                {trialUnits}-{trialUnitLabel} free trial
              </p>
            )}
          </div>
        )}

        {showPublish && !isPublished ? (
          <PlanVersionPublish planVersionId={planVersion.id} onConfirmAction={onPublish} />
        ) : (
          <Button className="w-full">Get Started</Button>
        )}
      </CardContent>

      <CardFooter className="flex w-full flex-col border-t px-6 py-6">
        <div className="w-full space-y-4">
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            What's included
          </p>
          <ul className="flex w-full flex-col space-y-3">
            {[...planVersion.planFeatures]
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .filter((f) => !f.metadata?.hidden)
              .map((feature) => {
                return (
                  <li key={feature.id} className="flex w-full flex-col justify-start">
                    <PricingItem feature={feature} withCalculator withQuantity />
                  </li>
                )
              })}
          </ul>
        </div>
      </CardFooter>
    </Card>
  )
}

export function PricingCardSkeleton() {
  return (
    <Card className="mx-auto max-w-[300px]">
      <CardHeader>
        <Typography variant="h3">
          <Skeleton className="h-[36px]" />
        </Typography>
      </CardHeader>

      <CardContent>
        <CardDescription className="animate-pulse rounded-md bg-accent">&nbsp;</CardDescription>
        <div className="mt-8 flex items-baseline space-x-2">
          <span className="font-extrabold text-5xl">$0</span>
          <span className="">month</span>
        </div>
        <Button className="mt-8 w-full">Get Started</Button>
      </CardContent>
      <CardFooter className="border-t px-6 py-6">
        <div className="space-y-6">
          <div className="space-y-2">
            <Typography variant="h4">Features Included</Typography>
            <ul className="space-y-6 px-2">
              {[1, 2, 3, 4, 5].map((e) => {
                return (
                  <li key={e} className="flex flex-col items-center">
                    <Skeleton className="h-[20px] w-full" />
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      </CardFooter>
    </Card>
  )
}
