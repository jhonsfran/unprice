"use client"

import { FileStack } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"

import type { RouterOutputs } from "@unprice/trpc/routes"
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
import { AddFeatureCommand } from "./add-feature-command"
import { FeatureSheet } from "./feature-sheet"
import { FeatureTable } from "./feature-table"

interface PlanFeatureListProps {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
}

const EMPTY_FEATURES: never[] = []

/** The editor's middle pane: the attached features as a table, with the palette and the sheet. */
export function PlanFeatureList({ planVersion }: PlanFeatureListProps) {
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

  const isPublished = planVersion.status === "published"

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[70px] items-center justify-between gap-3 px-4 py-2">
        <Typography variant="h4">Features</Typography>
        {!isPublished && <AddFeatureCommand planVersion={planVersion} />}
      </div>
      <Separator />
      <div
        data-feature-scroll
        className="hide-scrollbar flex max-h-[60vh] min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:max-h-none"
      >
        {featuresList.length === 0 ? (
          <EmptyPlaceholder className="m-4 flex min-h-[480px] flex-1">
            <EmptyPlaceholder.Icon>
              <FileStack className="h-8 w-8" />
            </EmptyPlaceholder.Icon>
            <EmptyPlaceholder.Title>No features yet</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {isPublished
                ? "This version was published without features."
                : "Add a feature to start. Its kind, limit, included units and price are set in the table; the meter, tiers and cadences open in a sheet."}
            </EmptyPlaceholder.Description>
          </EmptyPlaceholder>
        ) : (
          <FeatureTable />
        )}
      </div>
      <FeatureSheet />
    </div>
  )
}
