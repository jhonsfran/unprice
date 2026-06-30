"use client"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Pencil } from "lucide-react"
import { useSelectedLayoutSegment } from "next/navigation"
import HeaderTab from "~/components/layout/header-tab"
import { ProjectDialog } from "../../../_components/project-dialog"

type Project = RouterOutputs["projects"]["getBySlug"]["project"]

function getSettingsHeaderCopy(segment: string | null) {
  switch (segment) {
    case "danger":
      return {
        title: "Danger Zone",
        description: "Transfer ownership or delete this project.",
      }
    case "payment":
      return {
        title: "Infrastructure",
        description: "Configure payment provider infrastructure for this project.",
      }
    default:
      return {
        title: "General Settings",
        description: "Manage your project settings.",
      }
  }
}

export function ProjectSettingsHeader({ project }: { project: Project }) {
  const segment = useSelectedLayoutSegment()
  const copy = getSettingsHeaderCopy(segment)

  return (
    <HeaderTab
      title={copy.title}
      description={copy.description}
      action={
        <ProjectDialog defaultValues={project}>
          <Button variant="outline">
            <Pencil className="mr-2 size-4" aria-hidden="true" />
            Edit Project
          </Button>
        </ProjectDialog>
      }
    />
  )
}
