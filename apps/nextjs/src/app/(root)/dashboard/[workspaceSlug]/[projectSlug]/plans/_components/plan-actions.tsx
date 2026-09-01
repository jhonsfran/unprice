"use client"

import { ChevronDown } from "lucide-react"

import type { RouterOutputs } from "@unprice/trpc/routes"
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

import { PlanForm } from "./plan-form"

export function PlanActions({
  plan,
}: {
  plan: RouterOutputs["plans"]["getBySlug"]["plan"]
}) {
  return (
    <ResponsiveDialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={"custom"}>
            <span className="sr-only">More actions</span>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44" align="end">
          <DropdownMenuLabel>More actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ResponsiveDialogTrigger asChild>
            <DropdownMenuItem>Edit plan</DropdownMenuItem>
          </ResponsiveDialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit plan</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Update the commercial package. Plan versions keep the versioned features, meters, and
            billing behavior.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <PlanForm defaultValues={plan} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
