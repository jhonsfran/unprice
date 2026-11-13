"use client"

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"
import type { ReactNode } from "react"

import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { TableRow } from "@unprice/ui/table"
import { cn } from "@unprice/ui/utils"

/**
 * A feature table row that can be dragged by its handle into a new order. The row is the sortable
 * node; the handle alone carries the listeners, so the row's cells keep their own focus and keys.
 */
export function SortableFeatureRow({
  planFeatureVersion,
  disabled,
  className,
  children,
}: {
  planFeatureVersion: PlanVersionFeatureDragDrop
  disabled?: boolean
  className?: string
  children: (handle: ReactNode) => ReactNode
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    isDragging,
    transform,
    transition,
  } = useSortable({
    id: planFeatureVersion.featureId,
    data: {
      mode: "FeaturePlan",
      planFeatureVersion,
    },
    attributes: {
      roleDescription: "sortable feature",
    },
    disabled,
    // Only animate during active sort or right after a drop; an attached feature appears in
    // place without sliding in.
    animateLayoutChanges: ({ isSorting, wasDragging }) => isSorting || wasDragging,
  })

  const handle = disabled ? null : (
    <button
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      className={cn(
        "flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground active:cursor-grabbing",
        isDragging && "cursor-grabbing text-foreground"
      )}
      aria-label={`Drag to reorder ${planFeatureVersion.feature.title}`}
    >
      <GripVertical className="size-3.5" strokeWidth={1.5} />
    </button>
  )

  return (
    <TableRow
      ref={disabled ? undefined : setNodeRef}
      style={{ transition, transform: CSS.Translate.toString(transform) }}
      className={cn(isDragging && "relative z-10 bg-background-bgHover shadow-ambient", className)}
    >
      {children(handle)}
    </TableRow>
  )
}
