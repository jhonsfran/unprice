"use client"

import { useOnboarding } from "@onboardjs/react"
import { useParams } from "next/navigation"

import { updateContextCookies } from "~/actions/update-context-cookies"
import { ProjectForm } from "~/app/(root)/dashboard/[workspaceSlug]/_components/project-form"

// The only human input on the path: the shared dashboard ProjectForm, reused
// as-is. On success the Project station settles with the returned slug and
// the flow advances into the build.

export function ProjectStep() {
  const { updateContext, next, state } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
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
          // Set cookies so onboarding API requests can resolve the active
          // project context.
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
  )
}
