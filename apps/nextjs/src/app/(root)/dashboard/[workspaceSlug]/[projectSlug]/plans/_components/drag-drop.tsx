"use client"

import type { DragEndEvent, DragOverEvent, DragStartEvent, DropAnimation } from "@dnd-kit/core"
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { arrayMove } from "@dnd-kit/sortable"
import { useRouter } from "next/navigation"
import { startTransition, useState } from "react"
import { createPortal } from "react-dom"

import { useMutation } from "@tanstack/react-query"
import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { useActiveFeature, useActivePlanVersion, usePlanFeaturesList } from "~/hooks/use-features"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { FeaturePlan } from "./feature-plan"

const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: "0.5",
      },
    },
  }),
}

export default function DragDrop({ children }: { children: React.ReactNode }) {
  const [clonedFeatures, setClonedFeatures] = useState<PlanVersionFeatureDragDrop[] | null>(null)
  const router = useRouter()
  const [activeFeature, setActiveFeature] = useActiveFeature()
  const [planFeaturesList, setPlanFeaturesList] = usePlanFeaturesList()
  const [activePlanVersion] = useActivePlanVersion()
  const isPublished = activePlanVersion?.status === "published"
  const trpc = useTRPC()

  const updatePlanVersionFeatures = useMutation(
    trpc.planVersionFeatures.update.mutationOptions({
      onSuccess: () => {
        router.refresh()
      },
    })
  )

  // Persist the new order for an already-saved feature.
  // Library items are added via click-to-add (see feature-list.tsx), not drag, so this only handles reorder.
  function persistOrder(planFeatureVersion: PlanVersionFeatureDragDrop) {
    if (!planFeatureVersion.id) return

    startTransition(() => {
      const activeIndex = planFeaturesList.findIndex(
        (t) => t.featureId === planFeatureVersion.featureId
      )
      const previousIndex = planFeaturesList[activeIndex - 1]
      const nextIndex = planFeaturesList[activeIndex + 1]

      // average neighbours' orders so we don't have to renumber the whole list
      let nextOrder: number
      if (!previousIndex && nextIndex) {
        nextOrder = nextIndex.order / 2
      } else if (previousIndex && !nextIndex) {
        nextOrder = previousIndex.order + 1024
      } else if (previousIndex && nextIndex) {
        nextOrder = (previousIndex.order + nextIndex.order) / 2
      } else {
        nextOrder = 1024
      }

      const previousOrders = clonedFeatures?.filter((f) => f.id).map((t) => t.order) ?? []
      const currentOrders = planFeaturesList.filter((f) => f.id).map((t) => t.order) ?? []

      // no-op if order didn't actually change
      if (previousOrders.toString() === currentOrders.toString()) {
        return
      }

      void updatePlanVersionFeatures.mutateAsync({
        id: planFeatureVersion.id,
        planVersionId: planFeatureVersion.planVersionId,
        order: nextOrder,
      })
    })
  }

  // sensors are how we control when the drag and drop activates
  // there are interactive controls inside the feature card (buttons), so we delay
  // drag activation until the user moves a small distance
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    })
  )

  const onDragEnd = (event: DragEndEvent) => {
    const { active } = event
    const activeData = active.data.current

    if (isPublished) {
      return
    }

    if (!activeData) return

    const planFeatureVersion = activeData.planFeatureVersion as PlanVersionFeatureDragDrop

    persistOrder(planFeatureVersion)

    setClonedFeatures(null)
  }

  const onDragCancel = () => {
    if (clonedFeatures) {
      setPlanFeaturesList(clonedFeatures)
    }

    setClonedFeatures(null)
  }

  const onDragStart = (event: DragStartEvent) => {
    if (isPublished) {
      toastAction(
        "error",
        "You cannot reorder features in a published plan version. Please create a new version or duplicate the current one."
      )
      return
    }

    // snapshot for rollback if drag is cancelled
    setClonedFeatures(planFeaturesList)

    if (event.active.data.current?.mode === "FeaturePlan") {
      setActiveFeature(event.active.data.current?.planFeatureVersion as PlanVersionFeatureDragDrop)
    }
  }

  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event

    if (isPublished) {
      return
    }

    if (!over) return

    const activeId = active.id
    const overId = over.id

    if (activeId === overId) return

    const activeData = active.data.current
    const overData = over.data.current

    if (!activeData) return

    // we only care about reordering within the attached list
    const isOverAFeaturePlan = overData?.mode === "FeaturePlan"
    if (!isOverAFeaturePlan) return

    setPlanFeaturesList((featuresList) => {
      const activeIndex = featuresList.findIndex((t) => t.featureId === activeId)
      const overIndex = featuresList.findIndex((t) => t.featureId === overId)
      if (activeIndex === -1 || overIndex === -1) return featuresList
      return arrayMove(featuresList, activeIndex, overIndex)
    })
  }

  return (
    <DndContext
      id={"plan-version-features"}
      sensors={sensors}
      measuring={{
        droppable: {
          strategy: MeasuringStrategy.Always,
        },
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragCancel={onDragCancel}
      collisionDetection={pointerWithin}
    >
      {children}
      {typeof window !== "undefined" &&
        "document" in window &&
        createPortal(
          <DragOverlay adjustScale={false} dropAnimation={dropAnimation}>
            {activeFeature && (
              <FeaturePlan mode={"FeaturePlan"} planFeatureVersion={activeFeature} />
            )}
          </DragOverlay>,
          document.body
        )}
    </DndContext>
  )
}
