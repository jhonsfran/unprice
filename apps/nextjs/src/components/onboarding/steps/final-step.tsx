"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { useParams, useRouter } from "next/navigation"

export function FinalStep({ className }: React.ComponentProps<"div">) {
  const { updateContext, state } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()

  const flowData = state?.context?.flowData as
    | {
        seededMetrics?: boolean
        seedMetricsError?: string
        project?: { slug: string }
        customer?: { customerId?: string }
        subscription?: { id?: string }
      }
    | undefined
  const hasSeedEvidence = Boolean(flowData?.customer?.customerId && flowData?.subscription?.id)
  const seededMetrics =
    flowData?.seededMetrics === true ||
    (flowData?.seededMetrics !== false && !flowData?.seedMetricsError && hasSeedEvidence)

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
          onClick={async () => {
            const projectSlug = flowData?.project?.slug

            // clear the flow data
            await updateContext({
              flowData: {
                project: undefined,
                customer: undefined,
                subscription: undefined,
                paymentProvider: undefined,
                planVersionId: undefined,
                apiKey: undefined,
                templatePlansCreated: undefined,
                seededMetrics: undefined,
                seedMetricsError: undefined,
                done: true,
              },
            })

            if (projectSlug) {
              router.push(`/${workspaceSlug}/${projectSlug}`)
            } else {
              router.push(`/${workspaceSlug}`)
            }

            router.refresh()
          }}
        >
          Inspect project overview
        </Button>
      </div>
    </div>
  )
}
