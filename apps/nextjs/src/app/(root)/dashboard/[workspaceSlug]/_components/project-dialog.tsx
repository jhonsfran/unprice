"use client"

import { useState } from "react"

import type { Project, ProjectInsert } from "@unprice/db/validators"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"

import { ProjectForm } from "./project-form"

export function ProjectDialog({
  defaultValues,
  children,
}: {
  label?: string
  defaultValues?: ProjectInsert | Project
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
            {isEdit ? "Edit project" : "Create project"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Projects group plans, customers, events, wallets, and invoice evidence in one money
            path.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ProjectForm
          defaultValues={
            defaultValues ?? {
              name: "Acme project",
              url: "https://acme.com",
              defaultCurrency: "USD",
              timezone: "UTC",
            }
          }
          onSuccess={() => setDialogOpen(false)}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
