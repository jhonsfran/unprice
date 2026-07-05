import { FolderKanban } from "lucide-react"
import { useParams } from "next/navigation"

import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { cn } from "@unprice/ui/utils"
import { updateContextCookies } from "~/actions/update-context-cookies"
import { ProjectForm } from "~/app/(root)/dashboard/[workspaceSlug]/_components/project-form"

export function ProjectStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { updateContext, next, state } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()

  return (
    <div className={cn("flex max-w-md flex-col gap-6", className)}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-8 animate-content items-center justify-center rounded-md delay-0!">
            <FolderKanban className="size-6" />
          </div>
          <h1 className="animate-content font-bold text-2xl delay-0!">Create a Sandbox project</h1>
          <div className="animate-content text-center text-sm delay-0!">
            This project holds the plan version, meter event, customer, and API key for the
            walkthrough.
          </div>
        </div>
        <div className="animate-content delay-200!">
          <ProjectForm
            defaultValues={
              state?.context.flowData?.project ?? {
                defaultCurrency: "USD",
                timezone: "UTC",
                name: "Workflow API Sandbox",
                url: "https://workflow.example.com",
              }
            }
            onSuccess={async (project) => {
              // Set cookies so onboarding API requests can resolve the active project context
              await Promise.all([
                updateContextCookies(workspaceSlug, project.slug),
                updateContext({
                  flowData: {
                    project,
                  },
                }),
              ])
              await next()
            }}
          />
        </div>
      </div>
    </div>
  )
}
