"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"

export function FinalStep({ className }: React.ComponentProps<"div">) {
  const { next, state, updateContext } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const [isCompleting, setIsCompleting] = useState(false)

  const flowData = state?.context?.flowData as
    | {
        done?: boolean
        seededMetrics?: boolean
        seedMetricsError?: string
        project?: { slug: string }
        customer?: { customerId?: string }
        subscription?: { id?: string }
      }
    | undefined
  const hasSeedEvidence = Boolean(flowData?.customer?.customerId && flowData?.subscription?.id)
  const hasSeedFailure = flowData?.seededMetrics === false || Boolean(flowData?.seedMetricsError)
  const completedFlow = Boolean(flowData?.done || state?.isCompleted)
  const seededMetrics =
    flowData?.seededMetrics === true || (!hasSeedFailure && (hasSeedEvidence || completedFlow))

  const router = useRouter()
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <Typography variant="h1" className="animate-title">
          Ready to inspect
        </Typography>
        <Typography variant="p" className="mb-8 w-[640px] max-w-[90vw] animate-title delay-300!">
          {seededMetrics
            ? "Your Sandbox project now has published plans, a test customer, an active subscription, and budgeted run evidence ready to inspect."
            : "Your Sandbox project is ready. Sample budgeted run evidence was not fully created, but you can still inspect the project and send usage when ready."}
        </Typography>

        <Button
          className="animate-button"
          disabled={isCompleting}
          onClick={async () => {
            if (isCompleting) return

            setIsCompleting(true)
            const projectSlug = flowData?.project?.slug

            try {
              await updateContext({
                flowData: {
                  done: true,
                  seededMetrics,
                  seedMetricsError: seededMetrics ? undefined : flowData?.seedMetricsError,
                },
              })

              await next()
            } finally {
              setIsCompleting(false)
            }

            if (projectSlug) {
              router.push(`/${workspaceSlug}/${projectSlug}`)
            } else {
              router.push(`/${workspaceSlug}`)
            }

            router.refresh()
          }}
        >
          {isCompleting ? "Opening project..." : "Inspect project overview"}
        </Button>
      </div>
    </div>
  )
}
