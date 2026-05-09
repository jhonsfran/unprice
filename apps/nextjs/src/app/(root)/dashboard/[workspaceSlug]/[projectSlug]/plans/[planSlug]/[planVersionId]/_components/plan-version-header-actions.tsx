"use client"

import { MoreVertical } from "lucide-react"

import { Button } from "@unprice/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"

import {
  PlanVersionDeactivate,
  PlanVersionDelete,
  PlanVersionDuplicate,
} from "../../../_components/plan-version-actions"

const ITEM_CLASSES =
  "w-full relative flex cursor-pointer justify-start select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-background-bgHover hover:text-background-textContrast font-normal"

const DESTRUCTIVE_ITEM_CLASSES = `${ITEM_CLASSES} text-danger hover:text-danger`

export function PlanVersionHeaderActions({
  planVersionId,
  status,
  active,
}: {
  planVersionId: string
  status: "draft" | "published"
  active: boolean
}) {
  const canDeactivate = status === "published" && active
  const canDelete = status === "draft"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-haspopup="true" size="icon" variant="ghost">
          <MoreVertical className="h-4 w-4" />
          <span className="sr-only">More actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <PlanVersionDuplicate planVersionId={planVersionId} classNames={ITEM_CLASSES} />
        </DropdownMenuItem>
        {canDeactivate && (
          <DropdownMenuItem asChild>
            <PlanVersionDeactivate planVersionId={planVersionId} classNames={ITEM_CLASSES} />
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <PlanVersionDelete
                planVersionId={planVersionId}
                classNames={DESTRUCTIVE_ITEM_CLASSES}
              />
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
