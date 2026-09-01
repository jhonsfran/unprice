"use client"

import { useState } from "react"

import type { InsertPage } from "@unprice/db/validators"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"

import { PageForm } from "./page-form"

export function PageDialog({
  defaultValues,
  children,
}: {
  label?: string
  defaultValues?: InsertPage
  children?: React.ReactNode
}) {
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <ResponsiveDialogTrigger asChild>{children}</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Page Form</ResponsiveDialogTitle>

          <ResponsiveDialogDescription>Modify the plan details below.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <PageForm
          defaultValues={
            defaultValues ?? {
              name: "",
              subdomain: "",
              customDomain: "",
              projectId: "",
            }
          }
          setDialogOpen={setDialogOpen}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
