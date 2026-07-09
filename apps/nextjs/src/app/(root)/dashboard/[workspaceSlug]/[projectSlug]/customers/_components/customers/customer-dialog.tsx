"use client"

import { useState } from "react"

import type { InsertCustomer } from "@unprice/db/validators"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"

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
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="md:max-w-xl">
        <DialogHeader>
          <DialogTitle>Customer details</DialogTitle>
          <DialogDescription>
            Create the economic actor that holds subscriptions, wallet credits, runs, and invoices.
          </DialogDescription>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  )
}
