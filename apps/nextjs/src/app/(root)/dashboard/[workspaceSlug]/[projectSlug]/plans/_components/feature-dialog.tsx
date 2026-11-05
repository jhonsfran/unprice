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

import { type CreatedFeature, FeatureForm } from "./feature-form"

export function FeatureDialog({
  defaultValues,
  children,
  onCreated,
  onUpdated,
  open,
  onOpenChange,
}: {
  label?: string
  defaultValues?: InsertFeature
  children?: React.ReactNode
  /** What happens to a feature created here, such as attaching it to the open draft version. */
  onCreated?: (feature: CreatedFeature) => void
  /** What happens to a feature edited here, such as renaming its row in the table. */
  onUpdated?: (feature: CreatedFeature) => void
  /** Controlled open state, for a dialog opened from a menu or palette that unmounts on pick. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const isOpen = open ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  const isEdit = Boolean(defaultValues?.id)

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={setOpen}>
      {children && <ResponsiveDialogTrigger asChild>{children}</ResponsiveDialogTrigger>}
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
          setDialogOpen={setOpen}
          onCreated={onCreated}
          onUpdated={onUpdated}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
