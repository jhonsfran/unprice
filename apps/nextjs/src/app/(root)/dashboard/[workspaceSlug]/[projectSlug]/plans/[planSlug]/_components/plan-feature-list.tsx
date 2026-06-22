"use client"

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { FileStack, Search } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Input } from "@unprice/ui/input"
import { Separator } from "@unprice/ui/separator"

import { Typography } from "@unprice/ui/typography"
import { useHydrateAtoms } from "jotai/utils"
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

const EMPTY_FEATURES: never[] = []

export function PlanFeatureList({ planVersion }: PlanFeatureListProps) {
  const [filter, setFilter] = useState("")

  // Use stable references for derived values to prevent unnecessary effect re-runs.
  // Track version identity to only re-sync atoms when the version actually changes.
  const versionId = planVersion?.id
  const versionUpdatedAt = planVersion?.updatedAtM
  const planFeatures = planVersion?.planFeatures ?? EMPTY_FEATURES
  const plan = planVersion?.plan ?? null
  const activePlanVersion = useMemo(() => {
    if (!planVersion) return null
    const { planFeatures: _pf, plan: _p, ...rest } = planVersion
    return rest
  }, [planVersion])

  // Hydrate atoms with initial server data — required for SSR consistency.
  useHydrateAtoms([[configPlanFeaturesListAtom, planFeatures]])
  useHydrateAtoms([[configActivePlanVersionAtom, activePlanVersion]])
  useHydrateAtoms([[configActivePlanAtom, plan]])

  const [featuresList, setPlanFeaturesList] = usePlanFeaturesList()
  const [, setActivePlanVersion] = useActivePlanVersion()
  const [, setActivePlan] = useActivePlan()

  // Re-sync atoms when navigating versions or when settings refresh the same version.
  // Uses refs for data values so the effect fires only on identity change.
  const planFeaturesRef = useRef(planFeatures)
  const planRef = useRef(plan)
  const activePlanVersionRef = useRef(activePlanVersion)
  planFeaturesRef.current = planFeatures
  planRef.current = plan
  activePlanVersionRef.current = activePlanVersion

  useEffect(() => {
    if (!planFeaturesRef.current || !activePlanVersionRef.current || !planRef.current) return
    setPlanFeaturesList(planFeaturesRef.current)
    setActivePlanVersion(activePlanVersionRef.current)
    setActivePlan(planRef.current)
  }, [versionId, versionUpdatedAt, setPlanFeaturesList, setActivePlanVersion, setActivePlan])

  if (!planVersion) return null

  const filteredFeatures =
    featuresList.filter((feature) =>
      feature.feature.title.toLowerCase().includes(filter.toLowerCase())
    ) ?? featuresList

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
            placeholder="Search attached features"
            className="pl-8"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4 pt-1">
        <DroppableContainer id={"planVersionFeaturesList"}>
          <SortableContext
            items={featuresList.map((feature) => feature.featureId)}
            strategy={verticalListSortingStrategy}
          >
            {filteredFeatures.length === 0 ? (
              <EmptyPlaceholder className="flex h-full min-h-[480px] flex-1">
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
            )}
          </SortableContext>
        </DroppableContainer>
      </div>
    </div>
  )
}
