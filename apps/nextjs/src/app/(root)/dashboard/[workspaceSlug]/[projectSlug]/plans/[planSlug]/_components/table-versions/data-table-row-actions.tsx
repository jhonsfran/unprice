"use client"

import type { Row } from "@tanstack/react-table"

import { planSelectBaseSchema, planVersionSelectBaseSchema } from "@unprice/db/validators"
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
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"
import { MoreVertical } from "lucide-react"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { SuperLink } from "~/components/super-link"
import {
  PlanVersionDeactivate,
  PlanVersionDuplicate,
  PlanVersionPublish,
} from "../../../_components/plan-version-actions"
import { PlanVersionForm } from "../plan-version-form"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const pathname = usePathname()
  // parse to get the types
  const version = planVersionSelectBaseSchema
    .extend({
      plan: planSelectBaseSchema.pick({ defaultPlan: true }),
    })
    .parse(row.original)
  const [isOpen, setIsOpen] = useState(false)
  const [isOpenDialog, setIsOpenDialog] = useState(false)

  return (
    <ResponsiveDialog onOpenChange={setIsOpenDialog} open={isOpenDialog}>
      <DropdownMenu onOpenChange={setIsOpen} open={isOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <MoreVertical className="size-4" aria-hidden="true" />
            <span className="sr-only">Open row actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ResponsiveDialogTrigger asChild>
            <DropdownMenuItem>Edit version</DropdownMenuItem>
          </ResponsiveDialogTrigger>
          <DropdownMenuItem asChild>
            <PlanVersionDuplicate
              onConfirmAction={() => setIsOpen(false)}
              classNames="w-full relative flex cursor-pointer justify-start select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-background-bgHover hover:text-background-textContrast font-normal"
              planVersionId={version.id}
            />
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <PlanVersionPublish
              variant="custom"
              onConfirmAction={() => setIsOpen(false)}
              classNames="w-full relative flex cursor-pointer justify-start select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-background-bgHover hover:text-background-textContrast font-normal"
              planVersionId={version.id}
            />
          </DropdownMenuItem>
          <DropdownMenuItem>
            <SuperLink href={`${pathname}/${version.id}`}>Configure features</SuperLink>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <PlanVersionDeactivate
              onConfirmAction={() => setIsOpen(false)}
              classNames="w-full relative flex cursor-pointer justify-start select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 text-danger-text focus:bg-danger-solid focus:text-danger-foreground font-normal hover:bg-danger-solid hover:text-danger-foreground"
              planVersionId={version.id}
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ResponsiveDialogContent className="md:max-w-screen-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit plan version</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Update the pricing, billing, and entitlement rules for customers pinned to this version.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <PlanVersionForm
          defaultValues={{
            ...version,
            isDefault: version.plan.defaultPlan ?? false,
          }}
          setDialogOpen={setIsOpenDialog}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
