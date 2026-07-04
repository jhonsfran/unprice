"use client"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { Typography } from "@unprice/ui/typography"
import { PlanVersionPublish } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/_components/plan-version-actions"
import { PlanVersionPricingCard } from "~/components/billing/plan-version-pricing-card"

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

  return (
    <PlanVersionPricingCard
      planVersion={planVersion}
      className={className}
      action={
        showPublish && planVersion.status !== "published"
          ? { kind: "publish", onPublish }
          : { kind: "select", label: "Get Started", onSelect: () => undefined }
      }
      renderAction={(action) => {
        if (action.kind === "publish") {
          return (
            <PlanVersionPublish planVersionId={planVersion.id} onConfirmAction={action.onPublish} />
          )
        }

        return undefined
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
