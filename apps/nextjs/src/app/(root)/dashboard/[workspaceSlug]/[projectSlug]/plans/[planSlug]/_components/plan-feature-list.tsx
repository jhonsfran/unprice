"use client"

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { FileStack, Search } from "lucide-react"
import { useEffect, useState } from "react"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Input } from "@unprice/ui/input"
import { Separator } from "@unprice/ui/separator"

import { ScrollArea } from "@unprice/ui/scroll-area"
import { Typography } from "@unprice/ui/typography"
import { useHydrateAtoms } from "jotai/utils"
import { useRouter } from "next/navigation"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import {
  configActivePlanAtom,
  configActivePlanVersionAtom,
  configPlanFeaturesListAtom,
  useActivePlan,
  useActivePlanVersion,
  usePlanFeaturesList,
} from "~/hooks/use-features"
import { DroppableContainer } from "../../_components/droppable"
import { SortableFeature } from "../../_components/sortable-feature"

interface PlanFeatureListProps {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
}

export function PlanFeatureList({ planVersion }: PlanFeatureListProps) {
  const [filter, setFilter] = useState("")
  const router = useRouter()

  if (!planVersion) return null

  const { planFeatures, plan, ...activePlanVersion } = planVersion

  // hydrate atoms with initial data from the server to avoid hydration errors
  useHydrateAtoms([[configPlanFeaturesListAtom, planFeatures]])
  useHydrateAtoms([[configActivePlanVersionAtom, activePlanVersion]])
  useHydrateAtoms([[configActivePlanAtom, plan]])

  const [featuresList, setPlanFeaturesList] = usePlanFeaturesList()
  const [_, setActivePlanVersion] = useActivePlanVersion()
  const [__, setActivePlan] = useActivePlan()

  const filteredFeatures =
    featuresList.filter((feature) =>
      feature.feature.title.toLowerCase().includes(filter.toLowerCase())
    ) ?? featuresList

  useEffect(() => {
    // rehydrate atoms when the planVersion id changes
    setPlanFeaturesList(planFeatures)
    setActivePlanVersion(activePlanVersion)
    setActivePlan(plan)

    // refresh the page when the planVersion id changes
    router.refresh()
  }, [planVersion.id])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[70px] items-center justify-between space-x-1 px-4 py-2">
        <Typography variant="h4">Features on this version</Typography>
      </div>
      <Separator />
      <div className="bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="relative">
          <Search className="absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search feature in plan"
            className="pl-8"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2 p-4 pt-1 lg:min-h-[750px]">
        <DroppableContainer id={"planVersionFeaturesList"}>
          <SortableContext
            items={featuresList.map((feature) => feature.featureId)}
            strategy={verticalListSortingStrategy}
          >
            {filteredFeatures.length === 0 ? (
              <EmptyPlaceholder className="lg:h-[725px]">
                <EmptyPlaceholder.Icon>
                  <FileStack className="h-8 w-8" />
                </EmptyPlaceholder.Icon>
                <EmptyPlaceholder.Title>No features yet</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Pick a feature from the library on the left and click <strong>Add</strong> to
                  attach it to this plan version.
                </EmptyPlaceholder.Description>
              </EmptyPlaceholder>
            ) : (
              <ScrollArea className="w-full lg:h-[700px]" hideScrollBar={true}>
                <div className="space-y-2">
                  {filteredFeatures.map((feature) => (
                    <SortableFeature
                      disabled={activePlanVersion?.status === "published"}
                      key={feature.featureId}
                      mode="FeaturePlan"
                      planFeatureVersion={feature}
                    />
                  ))}
                </div>
              </ScrollArea>
            )}
          </SortableContext>
        </DroppableContainer>
      </div>
    </div>
  )
}
