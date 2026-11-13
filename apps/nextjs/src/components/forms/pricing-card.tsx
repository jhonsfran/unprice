"use client"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { Typography } from "@unprice/ui/typography"
import { PlanVersionPricingCard } from "~/components/billing/plan-version-pricing-card"
import { PlanVersionPublish } from "~/components/pricing/plan-version-publish"
import { useVersionPricing } from "~/components/pricing/use-version-pricing"

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
  const { rows } = useVersionPricing(planVersion?.id, planVersion?.currency)
  if (!planVersion) return null

  return (
    <PlanVersionPricingCard
      planVersion={planVersion}
      className={className}
      priceRows={rows}
      action={
        showPublish && planVersion.status !== "published"
          ? { kind: "publish", onPublish }
          : { kind: "select", label: "Get Started", onSelect: () => undefined }
      }
      renderAction={(action) => {
        if (action.kind === "publish") {
          return (
            <PlanVersionPublish
              planVersionId={planVersion.id}
              currency={planVersion.currency}
              features={planVersion.planFeatures}
              onConfirmAction={action.onPublish}
            />
          )
        }

        // dashboard preview: the CTA is part of the artifact, not a live
        // action — keep the page's single solid primary elsewhere
        return (
          <Button className="w-full disabled:opacity-100" variant="outline" disabled>
            Get Started
          </Button>
        )
      }}
    />
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
