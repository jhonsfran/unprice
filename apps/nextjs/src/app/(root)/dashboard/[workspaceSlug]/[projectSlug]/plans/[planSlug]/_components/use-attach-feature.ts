"use client"

import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"

import type { PlanVersionFeatureDragDrop, PlanVersionFeatureInsert } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"

import { useActiveFeature, usePlanFeaturesList } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

type PlanVersion = RouterOutputs["planVersions"]["getById"]["planVersion"]
type LibraryFeature = RouterOutputs["features"]["searchBy"]["features"][number]

/**
 * Attaches a library feature to the open version: an optimistic entry at the end of the list,
 * its editor expanded at once, and the saved feature swapped in when the server answers.
 */
export function useAttachFeature(planVersion: PlanVersion) {
  const trpc = useTRPC()
  const router = useRouter()
  const [planVersionFeatureList, setPlanFeaturesList] = usePlanFeaturesList()
  const [, setActiveFeature] = useActiveFeature()
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
        // the rail's preview and the header's publish count read the server's feature list
        router.refresh()
      },
      onError: () => {
        // rollback: drop entries that haven't been persisted (no id)
        setPlanFeaturesList((features) => features.filter((f) => Boolean(f.id)))
        setActiveFeature((current) => (current && !current.id ? null : current))
      },
    })
  )

  const attach = (feature: LibraryFeature) => {
    if (!planVersion) return
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
      config: {},
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

  return {
    attach,
    isPublished,
    attachedFeatureIds: planVersionFeatureList.map((f) => f.feature.id),
  }
}
