"use client"

import { useQuery } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Button } from "@unprice/ui/button"
import { ScrollArea } from "@unprice/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@unprice/ui/sheet"
import { Skeleton } from "@unprice/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { AlertCircle, Settings } from "lucide-react"
import { useMemo, useState } from "react"
import { useTRPC } from "~/trpc/client"
import { FeatureConfigForm } from "../../../plans/[planSlug]/_components/feature-config-form"

type CurrentAccessEntitlement =
  RouterOutputs["customers"]["getCurrentAccess"]["entitlements"][number]

export function EntitlementConfigSheet({
  entitlement,
  planVersionId,
}: {
  entitlement: CurrentAccessEntitlement
  planVersionId: string | null
}) {
  const [isOpen, setIsOpen] = useState(false)
  const trpc = useTRPC()

  const { data, error, isLoading, isFetching } = useQuery(
    trpc.planVersions.getById.queryOptions(
      {
        id: planVersionId ?? "",
      },
      {
        enabled: isOpen && Boolean(planVersionId),
      }
    )
  )

  const planVersion = data?.planVersion ?? null
  const activePlanVersion = useMemo(() => {
    if (!planVersion) {
      return null
    }

    const { planFeatures: _planFeatures, plan: _plan, ...version } = planVersion
    return version
  }, [planVersion])

  const planVersionFeature = useMemo(
    () =>
      planVersion?.planFeatures.find(
        (feature) => feature.feature.slug === entitlement.featureSlug
      ) ?? null,
    [entitlement.featureSlug, planVersion]
  )

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              aria-label={`View configuration for ${entitlement.featureTitle}`}
              className="size-6 text-muted-foreground hover:text-foreground"
              disabled={!planVersionId}
              size="xs"
              type="button"
              variant="ghost"
            >
              <Settings className="size-3.5" />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">
          {planVersionId ? "View configuration" : "No active plan version"}
        </TooltipContent>
      </Tooltip>

      <SheetContent className="w-full overflow-hidden p-0 md:w-1/2 lg:w-[760px]">
        <ScrollArea className="w-full" style={{ height: "100dvh", maxHeight: "100dvh" }}>
          <div className="p-6">
            <SheetHeader className="pr-6">
              <SheetTitle>{entitlement.featureTitle}</SheetTitle>
              <SheetDescription className="break-all font-mono">
                {entitlement.featureSlug}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 pb-6">
              {isLoading || isFetching ? (
                <EntitlementConfigSkeleton />
              ) : error ? (
                <EntitlementConfigMessage
                  title="Configuration unavailable"
                  description={error.message}
                />
              ) : planVersion && planVersionFeature && activePlanVersion ? (
                <div className="flex flex-col gap-4">
                  {activePlanVersion.status === "published" && (
                    <Alert variant="success" className="rounded-md py-3">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle className="text-sm">Published plan version</AlertTitle>
                      <AlertDescription className="font-extralight text-xs">
                        This entitlement is locked because the plan version is published. You can
                        inspect the configuration here; changing it requires a new version.
                      </AlertDescription>
                    </Alert>
                  )}
                  <FeatureConfigForm
                    className="pb-6"
                    defaultValues={planVersionFeature}
                    planVersion={activePlanVersion}
                    planFeatures={planVersion.planFeatures}
                    setDialogOpen={setIsOpen}
                  />
                </div>
              ) : (
                <EntitlementConfigMessage
                  title="Feature configuration not found"
                  description="The active plan version no longer contains a feature matching this entitlement."
                />
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function EntitlementConfigSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

function EntitlementConfigMessage({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-4 py-6">
      <p className="font-medium text-sm">{title}</p>
      <p className="mt-1 text-muted-foreground text-sm">{description}</p>
    </div>
  )
}
