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
import { useParams } from "next/navigation"
import { SuperLink } from "~/components/super-link"
import { CustomerForm } from "../customer-form"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const customer = customerSelectSchema.parse(row.original)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const { workspaceSlug, projectSlug } = useParams()
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customer.id}`

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 data-[state=open]:bg-accent">
            <MoreHorizontal className="size-4" aria-hidden="true" />
            <span className="sr-only">Open row actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>More actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ResponsiveDialogTrigger asChild>
            <DropdownMenuItem>Edit Customer</DropdownMenuItem>
          </ResponsiveDialogTrigger>
          <ResponsiveDialogTrigger asChild>
            <DropdownMenuItem>
              <SuperLink href={baseUrl}>Open customer</SuperLink>
            </DropdownMenuItem>
          </ResponsiveDialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
      <ResponsiveDialogContent className="md:max-w-xl">
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
