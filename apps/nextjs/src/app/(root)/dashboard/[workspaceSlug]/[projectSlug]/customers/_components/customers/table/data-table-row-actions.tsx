"use client"

import type { Row } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"

import { customerSelectSchema } from "@unprice/db/validators"
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
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
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 data-[state=open]:bg-accent">
            <MoreHorizontal className="size-4" aria-hidden="true" />
            <span className="sr-only">Open row actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DialogTrigger asChild>
            <DropdownMenuItem>Edit Customer</DropdownMenuItem>
          </DialogTrigger>
          <DialogTrigger asChild>
            <DropdownMenuItem>
              <SuperLink href={baseUrl}>Manage</SuperLink>
            </DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>
      <DialogContent className="max-h-[95vh] md:max-w-screen-md">
        <DialogHeader>
          <DialogTitle>Customer Form</DialogTitle>
          <DialogDescription>Modify the customer details below.</DialogDescription>
        </DialogHeader>
        <CustomerForm defaultValues={customer} setDialogOpen={setDialogOpen} />
      </DialogContent>
    </Dialog>
  )
}
