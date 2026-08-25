"use client"

import { useState } from "react"

import type { CreateDomain } from "@unprice/db/validators"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"

import { DomainForm } from "./domain-form"

export function DomainDialog({
  children,
  defaultValues,
}: {
  children: React.ReactNode
  defaultValues?: CreateDomain
}) {
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <ResponsiveDialogTrigger asChild>{children}</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Domain for this workspace</ResponsiveDialogTitle>

          <ResponsiveDialogDescription>
            Add a hostname that can serve verified project pages after DNS checks pass.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <DomainForm
          defaultValues={defaultValues ?? { name: "" }}
          onSubmit={() => {
            setDialogOpen(false)
          }}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
