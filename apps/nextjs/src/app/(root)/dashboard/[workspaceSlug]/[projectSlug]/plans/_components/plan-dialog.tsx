"use client"

import { useState } from "react"

import type { InsertPlan } from "@unprice/db/validators"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"

import { PlanForm } from "./plan-form"

export function PlanDialog({
  defaultValues,
  children,
}: {
  label?: string
  defaultValues?: InsertPlan
  children?: React.ReactNode
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const isEdit = Boolean(defaultValues?.id)

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <ResponsiveDialogTrigger asChild>{children}</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{isEdit ? "Edit plan" : "Create plan"}</ResponsiveDialogTitle>

          <ResponsiveDialogDescription>
            {isEdit
              ? "Update the commercial package. Plan versions keep the versioned features, meters, and billing behavior."
              : "Define the commercial package. The plan starts with a draft version to configure: its features, prices, and billing live there."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <PlanForm
          defaultValues={
            defaultValues ?? {
              slug: "",
              title: "",
              description: "",
              active: true,
              defaultPlan: false,
              enterprisePlan: false,
              trialUnits: 0,
            }
          }
          setDialogOpen={setDialogOpen}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
