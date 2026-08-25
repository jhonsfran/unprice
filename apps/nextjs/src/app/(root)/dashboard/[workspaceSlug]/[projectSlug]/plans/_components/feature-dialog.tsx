"use client"

import { useState } from "react"

import type { InsertFeature } from "@unprice/db/validators"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"

import { FeatureForm } from "./feature-form"

export function FeatureDialog({
  defaultValues,
  children,
}: {
  label?: string
  defaultValues?: InsertFeature
  children?: React.ReactNode
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const isEdit = Boolean(defaultValues?.id)

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <ResponsiveDialogTrigger asChild>{children}</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {isEdit ? "Edit feature" : "Create feature"}
          </ResponsiveDialogTitle>

          <ResponsiveDialogDescription>
            Define the sellable or gateable capability that plan versions attach to meters,
            entitlements, and limits.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <FeatureForm
          defaultValues={defaultValues ?? { title: "", slug: "", description: "" }}
          setDialogOpen={setDialogOpen}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
