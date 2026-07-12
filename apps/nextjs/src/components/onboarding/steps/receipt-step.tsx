"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Ban, Check } from "lucide-react"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"

import type { OnboardingFlowData } from "../rail-state"

// The receipt: the rail beside this column is fully settled, and this column
// states the verdict and hands the path to the reader's own app — the same
// two calls the landing promises, preloaded with the ids this build just
// created. No secrets here: the API key never renders as a token.

function firstTwoCallsSnippet(flowData: OnboardingFlowData): string {
  const planSlug =
    flowData.appliedTemplates?.find((template) => template.planVersionId === flowData.planVersionId)
      ?.key ?? "pro"
  const featureSlug = flowData.verification?.featureSlug ?? "runs"

  return `// once, at your own signup
const { result: signup } = await unprice.customers.signUp({
  email: "buyer@acme.com",
  planSlug: "${planSlug}",
})

// before the paid action, on every request
const { result } = await unprice.access.check({
  customerId: signup.customerId,
  featureSlug: "${featureSlug}",
})`
}

export function ReceiptStep() {
  const { next, state, updateContext } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const router = useRouter()
  const [isCompleting, setIsCompleting] = useState(false)

  const flowData = (state?.context?.flowData ?? {}) as OnboardingFlowData
  const verification = flowData.verification
  const usageSkipped = flowData.usage?.state === "skipped"
  const denied = verification?.state === "done" && verification.allowed === false
  const checked = verification?.state === "done" && !denied

  return (
    <div className="flex w-full max-w-md flex-col items-start gap-5">
      {checked && (
        <div className="w-full">
          <div className="flex items-center gap-2.5 rounded-sm border border-success-border bg-success-bg px-3 py-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-success-solid text-white">
              <Check aria-hidden className="size-3.5" />
            </span>
            <div className="flex flex-1 items-baseline justify-between gap-2">
              <p className="font-medium text-background-textContrast text-sm">
                access.check · allowed
              </p>
              <p className="font-mono text-[11px] text-success-text">
                {verification?.featureSlug ?? "runs"}
              </p>
            </div>
          </div>
          <p className="mt-1.5 text-background-text text-xs leading-5">
            Allowed because the run is within budget — decided in the request path.
          </p>
        </div>
      )}

      {denied && (
        <div className="w-full">
          <div className="flex items-center gap-2.5 rounded-sm border border-danger-border bg-danger-bg px-3 py-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-danger-solid text-white">
              <Ban aria-hidden className="size-3.5" />
            </span>
            <div className="flex flex-1 items-baseline justify-between gap-2">
              <p className="font-medium text-background-textContrast text-sm">
                access.check · denied
              </p>
              <p className="font-mono text-[11px] text-danger-text">
                {verification?.featureSlug ?? "runs"}
              </p>
            </div>
          </div>
          <p className="mt-1.5 text-background-text text-xs leading-5">
            Denied before any cost was created — the check itself worked.
          </p>
        </div>
      )}

      {usageSkipped && (
        <div className="w-full rounded-sm border border-warning-line bg-warning-bgSubtle p-3 text-warning-text text-xs leading-5">
          No usage-based feature with meter configuration was found. Usage evidence will appear
          after you attach a meter to a plan version.
        </div>
      )}

      <div className="w-full rounded-sm border border-background-border bg-surface-raised px-3 py-2">
        <div className="flex items-baseline justify-between gap-3 border-background-border border-b pb-2">
          <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
            your app's first two calls
          </span>
          <span className="font-mono text-[10px] text-background-text">typescript</span>
        </div>
        <pre className="overflow-x-auto py-2 font-mono text-[11px] text-background-text leading-5">
          {firstTwoCallsSnippet(flowData)}
        </pre>
      </div>

      <Button
        disabled={isCompleting}
        onClick={async () => {
          if (isCompleting) return

          setIsCompleting(true)
          const projectSlug = flowData.project?.slug

          try {
            await updateContext({
              flowData: {
                done: true,
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
        {isCompleting ? "Opening project…" : "Inspect project overview"}
      </Button>
    </div>
  )
}
