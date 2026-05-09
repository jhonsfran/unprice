"use client"

import { useDroppable } from "@dnd-kit/core"
import type { AnimateLayoutChanges } from "@dnd-kit/sortable"
import { defaultAnimateLayoutChanges } from "@dnd-kit/sortable"

import { cn } from "@unprice/ui/utils"

// TODO: migrate this to sortable.tsx ui component
export const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true })

interface FeatureGroupProps {
  id: string
  children: React.ReactNode
  disabled?: boolean
}

export function DroppableContainer({ id, children, disabled }: FeatureGroupProps) {
  const { setNodeRef } = useDroppable({
    id: id,
    data: {
      type: "FeaturesListGroup",
    },
  })

  return (
    <div
      ref={disabled ? undefined : setNodeRef}
      className={cn("flex w-full flex-1 flex-shrink-0 snap-center flex-col space-y-2")}
    >
      {children}
    </div>
  )
}
