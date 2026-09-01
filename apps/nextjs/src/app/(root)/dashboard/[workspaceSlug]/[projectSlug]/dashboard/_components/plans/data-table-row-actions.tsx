"use client"

import type { Row } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"

import { customerSelectSchema } from "@unprice/db/validators"
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
import { CustomerForm } from "../../../customers/_components/customers/customer-form"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const customer = customerSelectSchema.parse(row.original)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-8 p-0 data-[state=open]:bg-accent">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>More actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ResponsiveDialogTrigger asChild>
            <DropdownMenuItem>Edit Customer</DropdownMenuItem>
          </ResponsiveDialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
      <ResponsiveDialogContent className="md:max-w-screen-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Customer details</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Update the economic actor that holds subscriptions, wallet credits, runs, and invoices.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <CustomerForm defaultValues={customer} setDialogOpen={setDialogOpen} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
