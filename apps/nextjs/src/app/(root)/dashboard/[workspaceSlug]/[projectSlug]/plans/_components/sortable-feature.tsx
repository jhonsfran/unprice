"use client"

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"

import { cn } from "@unprice/ui/utils"

import type { FeaturePlanProps } from "./feature-plan"
import { FeaturePlan } from "./feature-plan"

export function SortableFeature(props: FeaturePlanProps) {
  const { setNodeRef, listeners, isDragging, attributes, transform, transition } = useSortable({
    id: props.planFeatureVersion.featureId,
    data: {
      mode: props.mode,
      planFeatureVersion: props.planFeatureVersion,
    },
    attributes: {
      roleDescription: props.mode,
    },
    disabled: props.disabled,
    // Only animate during active sort / right after a drop. New items added via "+ Add" should
    // appear in place without sliding in.
    animateLayoutChanges: ({ isSorting, wasDragging }) => isSorting || wasDragging,
  })

  const style = {
    transition,
    transform: CSS.Translate.toString(transform),
  }

  // Library mode keeps the original structure; drag only applies to attached
  // plan features.
  if (props.mode === "Feature") {
    return <FeaturePlan {...props} />
  }

  return (
    <FeaturePlan
      ref={props.disabled ? undefined : setNodeRef}
      style={style}
      {...attributes}
      isDragging={isDragging}
      renderDragHandle={
        props.disabled
          ? undefined
          : () => (
              <button
                type="button"
                {...listeners}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className={cn(
                  "flex size-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing",
                  isDragging && "cursor-grabbing text-foreground"
                )}
                aria-label="Drag to reorder feature"
              >
                <GripVertical className="size-3.5" />
              </button>
            )
      }
      {...props}
    />
  )
}
