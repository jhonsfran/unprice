import { GalleryVerticalEnd } from "lucide-react"

import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { cn } from "@unprice/ui/utils"
import CreateApiKeyForm from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/_components/create-api-key-form"

export function ApiKeyStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { updateContext, next } = useOnboarding()

  return (
    <div className={cn("flex max-w-md flex-col gap-6", className)}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          {/* biome-ignore lint/a11y/useValidAnchor: <explanation> */}
          <a href="#" className="flex flex-col items-center gap-2 font-medium">
            <div className="flex size-8 animate-content items-center justify-center rounded-md delay-0!">
              <GalleryVerticalEnd className="size-6" />
            </div>
          </a>
          <h1 className="animate-content font-bold text-2xl delay-0!">Create a new API Key</h1>
          <div className="animate-content text-center text-sm delay-0!">
            API Keys are used to authenticate your requests to the Unprice API.
          </div>
        </div>
        <div className="animate-content delay-200!">
          <CreateApiKeyForm
            isOnboarding={true}
            onSuccess={async (data) => {
              await updateContext({
                flowData: {
                  apiKey: data,
                },
              })

              // go to the next step
              await next()
            }}
            defaultValues={{
              name: "api-key-onboarding",
              // this key will expire in 1 day
              expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
            }}
          />
        </div>
      </div>
    </div>
  )
}
