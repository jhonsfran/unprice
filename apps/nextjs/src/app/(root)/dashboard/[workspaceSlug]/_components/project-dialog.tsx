"use client"

import { useState } from "react"

import type { Project, ProjectInsert } from "@unprice/db/validators"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"

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
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit project" : "Create project"}</DialogTitle>
          <DialogDescription>
            Projects group plans, customers, events, wallets, and invoice evidence in one money
            path.
          </DialogDescription>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  )
}
