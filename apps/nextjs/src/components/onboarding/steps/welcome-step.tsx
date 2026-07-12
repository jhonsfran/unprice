"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { useParams } from "next/navigation"

import { SuperLink } from "~/components/super-link"

// The before-tableau: the rail beside this copy is all ghost stations, and
// this moment's job is to make that absence legible. One amber CTA starts
// the build; the quiet skip link leaves onboarding incomplete so the
// dashboard's "Create project" action routes back here.

export function WelcomeStep() {
  const { next } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()

  return (
    <div className="flex w-full max-w-md flex-col items-start gap-6">
      <p className="text-background-text text-sm leading-6">
        Every station on the rail starts empty — no plan version, no customer, no evidence. One
        build settles all eight: publish plan versions, assign a test customer, generate synthetic
        budget evidence, and check access in the request path.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button className="gap-1.5" onClick={() => next()}>
          Build the Sandbox paid action
          <ArrowRight aria-hidden className="size-3.5" />
        </Button>
        <SuperLink
          href={`/${workspaceSlug}`}
          className="text-background-text text-xs transition-colors duration-quick ease-out-quad hover:text-background-textContrast"
        >
          Skip for now
        </SuperLink>
      </div>
    </div>
  )
}
