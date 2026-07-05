"use client"

import { useState } from "react"

import type { InsertPlan } from "@unprice/db/validators"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"

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
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-screen overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit plan" : "Create plan"}</DialogTitle>

          <DialogDescription>
            Define the commercial package. Plan versions carry the features, meters, limits, and
            billing behavior.
          </DialogDescription>
        </DialogHeader>

        <PlanForm
          defaultValues={
            defaultValues ?? {
              slug: "",
              title: "",
              description: "",
              active: true,
              defaultPlan: false,
              enterprisePlan: false,
            }
          }
          setDialogOpen={setDialogOpen}
        />
      </DialogContent>
    </Dialog>
  )
}
