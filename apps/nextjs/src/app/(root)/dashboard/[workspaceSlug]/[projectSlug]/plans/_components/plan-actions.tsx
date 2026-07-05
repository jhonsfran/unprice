"use client"

import { ChevronDown } from "lucide-react"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"

import { PlanForm } from "./plan-form"

export function PlanActions({
  plan,
}: {
  plan: RouterOutputs["plans"]["getBySlug"]["plan"]
}) {
  return (
    <Dialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={"custom"}>
            <span className="sr-only">Actions</span>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44" align="end">
          <DialogTrigger asChild>
            <DropdownMenuItem>Edit plan</DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
      <DialogContent className="max-h-screen overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>Edit plan</DialogTitle>
          <DialogDescription>
            Update the commercial package. Plan versions keep the versioned features, meters, and
            billing behavior.
          </DialogDescription>
        </DialogHeader>
        <PlanForm defaultValues={plan} />
      </DialogContent>
    </Dialog>
  )
}
