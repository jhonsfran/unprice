"use client"

import { ChevronDown } from "lucide-react"

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
  PlanVersionPublish,
} from "../../../_components/plan-version-actions"

const ITEM_CLASSES =
  "w-full relative flex cursor-pointer justify-start select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-background-bgHover hover:text-background-textContrast font-normal"

const DESTRUCTIVE_ITEM_CLASSES =
  "w-full relative flex cursor-pointer justify-start select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 text-danger-text focus:bg-danger-solid focus:text-danger-foreground font-normal hover:bg-danger-solid hover:text-danger-foreground"

// Split-button pattern: the lifecycle's next action is the primary segment,
// everything else lives behind the chevron. Draft → Publish; published →
// Duplicate (the way to iterate on an immutable version).
export function PlanVersionHeaderActions({
  planVersionId,
  status,
  active,
}: {
  planVersionId: string
  status: "draft" | "published"
  active: boolean
}) {
  const isDraft = status === "draft"
  const canDeactivate = status === "published" && active
  const canDelete = status === "draft"
  const hasMenuItems = isDraft || canDeactivate

  return (
    <div className="button-primary flex items-center space-x-1 rounded-md">
      {isDraft ? (
        <PlanVersionPublish planVersionId={planVersionId} variant="custom" />
      ) : (
        <PlanVersionDuplicate planVersionId={planVersionId} />
      )}

      {hasMenuItems && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="custom" size="icon" aria-haspopup="true">
              <span className="sr-only">More actions</span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>More actions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {isDraft && (
              <DropdownMenuItem asChild>
                <PlanVersionDuplicate planVersionId={planVersionId} classNames={ITEM_CLASSES} />
              </DropdownMenuItem>
            )}
            {canDeactivate && (
              <DropdownMenuItem asChild>
                <PlanVersionDeactivate
                  planVersionId={planVersionId}
                  classNames={DESTRUCTIVE_ITEM_CLASSES}
                />
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
      )}
    </div>
  )
}
