"use client"

import { useState } from "react"

import type { InsertCustomer } from "@unprice/db/validators"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"

import { CustomerForm } from "./customer-form"

export function CustomerDialog({
  defaultValues,
  children,
}: {
  label?: string
  defaultValues?: InsertCustomer
  children?: React.ReactNode
}) {
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <ResponsiveDialogTrigger asChild>{children}</ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="md:max-w-xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Customer details</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Create the economic actor that holds subscriptions, wallet credits, runs, and invoices.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <CustomerForm
          defaultValues={
            defaultValues ?? {
              email: "",
              name: "",
              description: "",
            }
          }
          setDialogOpen={setDialogOpen}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
