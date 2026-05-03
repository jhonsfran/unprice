"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { FileStack, Search } from "lucide-react"
import { Fragment, use, useState } from "react"

import type { PlanVersionFeatureDragDrop, PlanVersionFeatureInsert } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { ScrollArea } from "@unprice/ui/scroll-area"

import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useDebounce } from "~/hooks/use-debounce"
import { useActiveFeature, usePlanFeaturesList } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { FeatureDialog } from "../../_components/feature-dialog"
import { FeaturePlan } from "../../_components/feature-plan"

interface FeatureListProps {
  featuresPromise: Promise<RouterOutputs["features"]["searchBy"]>
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
}

export function FeatureList({ featuresPromise, planVersion }: FeatureListProps) {
  const initialFeatures = use(featuresPromise)
  const [filter, setFilter] = useState("")
  const filterDebounce = useDebounce(filter, 500)
  const trpc = useTRPC()
  const [planVersionFeatureList, setPlanFeaturesList] = usePlanFeaturesList()
  const [, setActiveFeature] = useActiveFeature()

  const { data, isFetching } = useQuery(
    trpc.features.searchBy.queryOptions(
      {
        search: filterDebounce,
      },
      {
        staleTime: 0,
        initialData: initialFeatures,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      }
    )
  )

  const isPublished = planVersion?.status === "published"

  const createPlanVersionFeature = useMutation(
    trpc.planVersionFeatures.create.mutationOptions({
      onSuccess: ({ planVersionFeature }) => {
        // replace the optimistic entry with the saved one
        setPlanFeaturesList((features) =>
          features.map((f) =>
            f.featureId === planVersionFeature.featureId ? { ...f, ...planVersionFeature } : f
          )
        )
        // hydrate the active feature with the saved id so subsequent edits use update, not create
        setActiveFeature((current) =>
          current && current.featureId === planVersionFeature.featureId
            ? { ...current, ...planVersionFeature }
            : current
        )
        toastAction("saved")
      },
      onError: (error) => {
        // rollback: drop entries that haven't been persisted (no id)
        setPlanFeaturesList((features) => features.filter((f) => Boolean(f.id)))
        setActiveFeature((current) => (current && !current.id ? null : current))
        toastAction("error", error.message)
      },
    })
  )

  if (!planVersion) return null

  const planFeatureIds = planVersionFeatureList.map((feature) => feature.feature.id)
  const searchableFeatures = data.features.filter((feature) => !planFeatureIds.includes(feature.id))

  const handleAdd = (feature: (typeof data.features)[number]) => {
    if (isPublished) {
      toastAction(
        "error",
        "You cannot add features to a published plan version. Please create a new version or duplicate the current one."
      )
      return
    }

    // place new feature at the end
    const lastOrder = planVersionFeatureList[planVersionFeatureList.length - 1]?.order
    const order = typeof lastOrder === "number" ? lastOrder + 1024 : 1024

    const optimistic = {
      planVersionId: planVersion.id,
      featureId: feature.id,
      featureType: "flat" as const,
      feature,
      order,
      config: {
        price: {
          displayAmount: "0.00",
          dinero: {
            amount: 0,
            currency: {
              code: planVersion.currency,
              base: 10,
              exponent: 2,
            },
            scale: 2,
          },
        },
      },
      billingConfig: planVersion.billingConfig,
    } as PlanVersionFeatureDragDrop

    // Optimistic local insert AND auto-expand: the user just declared intent to configure
    // this feature, so we open the inline editor immediately. FeaturePlan scrolls itself into
    // view when it becomes active without an id yet (see useEffect there).
    setPlanFeaturesList((prev) => [...prev, optimistic])
    setActiveFeature(optimistic)

    const payload: PlanVersionFeatureInsert = {
      planVersionId: optimistic.planVersionId,
      featureId: optimistic.featureId,
      featureType: optimistic.featureType,
      config: optimistic.config,
      billingConfig: optimistic.billingConfig,
      resetConfig: optimistic.resetConfig,
      metadata: optimistic.metadata,
      order: optimistic.order,
      defaultQuantity: optimistic.defaultQuantity ?? 1,
      limit: optimistic.limit ?? undefined,
      type: optimistic.type,
      unitOfMeasure: optimistic.unitOfMeasure,
      meterConfig: optimistic.meterConfig ?? undefined,
    }

    createPlanVersionFeature.mutate(payload)
  }

  return (
    <Fragment>
      <div className="bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="relative">
          <Search className="absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search feature"
            className="pl-8"
            onChange={(e) => {
              setFilter(e.target.value)
            }}
          />
        </div>
      </div>
      <ScrollArea className="pb-4 lg:h-[750px]">
        <div className="flex flex-col gap-2 px-4 pt-1 lg:h-[730px]">
          {isFetching && (
            <div className="flex h-full items-center justify-center">
              <LoadingAnimation className="size-6" />
            </div>
          )}
          {!isFetching && searchableFeatures.length === 0 ? (
            <EmptyPlaceholder>
              <EmptyPlaceholder.Icon>
                <FileStack className="h-8 w-8" />
              </EmptyPlaceholder.Icon>
              <EmptyPlaceholder.Title>No features found</EmptyPlaceholder.Title>
              <EmptyPlaceholder.Description>Create feature</EmptyPlaceholder.Description>
              <EmptyPlaceholder.Action>
                <FeatureDialog
                  defaultValues={{
                    title: filterDebounce,
                    slug: filterDebounce,
                    description: "",
                  }}
                >
                  <Button size={"sm"}>Create feature</Button>
                </FeatureDialog>
              </EmptyPlaceholder.Action>
            </EmptyPlaceholder>
          ) : (
            !isFetching &&
            searchableFeatures.map((feature) => {
              const planFeatureVersion = {
                planVersionId: planVersion.id,
                featureId: feature.id,
                featureType: "flat",
                feature: feature,
                order: 1024,
                config: {
                  price: {
                    displayAmount: "0.00",
                    dinero: {
                      amount: 0,
                      currency: {
                        code: planVersion.currency,
                        base: 10,
                        exponent: 2,
                      },
                      scale: 2,
                    },
                  },
                },
                billingConfig: planVersion.billingConfig,
              } as PlanVersionFeatureDragDrop

              return (
                <FeaturePlan
                  key={feature.id}
                  mode={"Feature"}
                  planFeatureVersion={planFeatureVersion}
                  variant={"feature"}
                  disabled={isPublished}
                  onAdd={() => handleAdd(feature)}
                />
              )
            })
          )}
        </div>
      </ScrollArea>
    </Fragment>
  )
}
