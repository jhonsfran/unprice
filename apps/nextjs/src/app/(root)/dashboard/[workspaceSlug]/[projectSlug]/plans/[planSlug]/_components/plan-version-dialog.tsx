"use client"

import { useState } from "react"

import type { InsertPlanVersion } from "@unprice/db/validators"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"

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

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-screen overflow-y-scroll md:max-w-screen-md">
        <DialogHeader>
          <DialogTitle>Plan version form</DialogTitle>

          <DialogDescription>Modify the plan version details below.</DialogDescription>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  )
}
