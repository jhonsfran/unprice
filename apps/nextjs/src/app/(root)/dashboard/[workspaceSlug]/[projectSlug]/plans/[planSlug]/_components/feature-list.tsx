"use client"

import { useQuery } from "@tanstack/react-query"
import { FileStack, PlusIcon, Search } from "lucide-react"
import { Fragment, use, useState } from "react"

import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { ScrollArea } from "@unprice/ui/scroll-area"

import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useDebounce } from "~/hooks/use-debounce"
import { useTRPC } from "~/trpc/client"
import { FeatureDialog } from "../../_components/feature-dialog"
import { FeaturePlan } from "../../_components/feature-plan"
import { useAttachFeature } from "./use-attach-feature"

type PlanVersion = RouterOutputs["planVersions"]["getById"]["planVersion"]

interface FeatureListProps {
  featuresPromise: Promise<RouterOutputs["features"]["searchBy"]>
  planVersion: PlanVersion
}

/** The library's "+": a feature created while a draft is open is attached to it at once. */
export function CreateFeatureButton({ planVersion }: { planVersion: PlanVersion }) {
  const { attach } = useAttachFeature(planVersion)

  return (
    <FeatureDialog onCreated={attach}>
      <Button variant="default" size="sm" aria-label="Create feature">
        <PlusIcon className="h-3.5 w-3.5" />
      </Button>
    </FeatureDialog>
  )
}

export function FeatureList({ featuresPromise, planVersion }: FeatureListProps) {
  const initialFeatures = use(featuresPromise)
  const [filter, setFilter] = useState("")
  const filterDebounce = useDebounce(filter, 500)
  const trpc = useTRPC()
  const { attach, isPublished, attachedFeatureIds } = useAttachFeature(planVersion)

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

  if (!planVersion) return null

  const searchableFeatures = data.features.filter(
    (feature) => !attachedFeatureIds.includes(feature.id)
  )

  return (
    <Fragment>
      <div className="bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="relative">
          <Search className="absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search features"
            className="pl-8"
            onChange={(e) => {
              setFilter(e.target.value)
            }}
          />
        </div>
      </div>
      {/* the pane owns the height: bounded on mobile, flexes to the
          workbench grid on lg */}
      <ScrollArea
        hideScrollBar
        className="max-h-[45vh] min-h-0 flex-1 pb-4 lg:max-h-none [&_[data-radix-scroll-area-viewport]]:overscroll-contain"
      >
        <div className="flex min-h-[200px] flex-col gap-2 px-4 pt-1">
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
              <EmptyPlaceholder.Description>
                No library features match your search. A feature created here is attached to this
                version.
              </EmptyPlaceholder.Description>
              <EmptyPlaceholder.Action>
                <FeatureDialog
                  defaultValues={{
                    title: filterDebounce,
                    slug: filterDebounce,
                    description: "",
                  }}
                  onCreated={attach}
                >
                  <Button size={"sm"} variant={"default"}>
                    Create feature
                  </Button>
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
                config: {},
                billingConfig: planVersion.billingConfig,
              } as PlanVersionFeatureDragDrop

              return (
                <FeaturePlan
                  key={feature.id}
                  mode={"Feature"}
                  planFeatureVersion={planFeatureVersion}
                  variant={"feature"}
                  disabled={isPublished}
                  onAdd={() => attach(feature)}
                />
              )
            })
          )}
        </div>
      </ScrollArea>
    </Fragment>
  )
}
