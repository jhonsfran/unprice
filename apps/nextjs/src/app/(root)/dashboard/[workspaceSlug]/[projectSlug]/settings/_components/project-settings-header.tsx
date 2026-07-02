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
        description:
          "Transfer ownership or delete the project. These actions affect every customer, key, plan, and invoice in this project.",
      }
    case "payment":
      return {
        title: "Payment providers",
        description: "Configure providers that plan versions can use for subscription settlement.",
      }
    default:
      return {
        title: "Project identity",
        description:
          "Configure the project name used across dashboard navigation, API keys, events, customers, and invoices.",
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
