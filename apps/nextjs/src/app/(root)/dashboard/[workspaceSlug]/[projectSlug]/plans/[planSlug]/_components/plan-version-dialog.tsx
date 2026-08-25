"use client"

import { useState } from "react"

import type { InsertPlanVersion } from "@unprice/db/validators"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"

import { PlanVersionForm } from "./plan-version-form"

export function PlanVersionDialog({
  defaultValues,
  children,
}: {
  label?: string
  defaultValues?: InsertPlanVersion
  children?: React.ReactNode
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const isEdit = Boolean(defaultValues?.id)

  return (
    <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <ResponsiveDialogTrigger asChild>{children}</ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="md:max-w-screen-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {isEdit ? "Edit plan version" : "Create plan version"}
          </ResponsiveDialogTitle>

          <ResponsiveDialogDescription>
            Version the pricing, billing, and entitlement rules that customers can be pinned to.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <PlanVersionForm
          defaultValues={
            defaultValues ?? {
              title: "",
              planId: "",
              projectId: "",
              currency: "USD",
              paymentProvider: "sandbox",
              description: "",
              collectionMethod: "charge_automatically",
              whenToBill: "pay_in_advance",
              autoRenew: true,
              paymentMethodRequired: false,
              trialUnits: 0,
              dueBehaviour: "cancel",
              gracePeriod: 0,
              billingConfig: {
                name: "monthly",
                billingInterval: "month",
                billingIntervalCount: 1,
                billingAnchor: "dayOfCreation",
                planType: "recurring",
              },
            }
          }
          setDialogOpen={setDialogOpen}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
