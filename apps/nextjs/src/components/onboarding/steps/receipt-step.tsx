"use client"

import { useOnboarding } from "@onboardjs/react"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Button } from "@unprice/ui/button"
import { track } from "@vercel/analytics"
import { useParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"

import { SuperLink } from "~/components/super-link"
import { DecisionReceipt } from "../decision-receipt"
import { type OnboardingFlowData, canCompleteOnboarding } from "../paid-action-schema"

export function ReceiptStep() {
  const { currentStep, next, state, updateContext } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const [isRevealing, setIsRevealing] = useState(false)
  const completionStartedRef = useRef(false)
  const flowData = (state?.context?.flowData ?? {}) as OnboardingFlowData
  const proof = flowData.proof

  useEffect(() => {
    if (
      currentStep?.id !== "receipt" ||
      !canCompleteOnboarding(flowData) ||
      completionStartedRef.current
    ) {
      return
    }

    completionStartedRef.current = true
    void next()
  }, [currentStep?.id, flowData, next])

  if (!proof) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Alert variant="destructive">
          <AlertTitle>The decision receipt is unavailable.</AlertTitle>
          <AlertDescription>
            The paid-action proof did not return both decisions. Return to the workspace and reopen
            onboarding to try again.
          </AlertDescription>
        </Alert>
        <SuperLink
          href={`/${workspaceSlug}`}
          className="text-background-textContrast text-sm underline underline-offset-4"
        >
          Return to workspace
        </SuperLink>
      </div>
    )
  }

  const projectSlug = flowData.project?.slug
  const planVersionId = flowData.planVersionId
  const planSlug =
    flowData.appliedTemplates?.find((template) => template.planVersionId === planVersionId)?.key ??
    "starter"
  const deniedRevealed = flowData.deniedRevealed === true
  const projectBase = projectSlug ? `/${workspaceSlug}/${projectSlug}` : `/${workspaceSlug}`

  const revealDeniedDecision = async () => {
    if (isRevealing || deniedRevealed) return

    setIsRevealing(true)
    completionStartedRef.current = true
    try {
      await updateContext({
        flowData: {
          deniedRevealed: true,
          done: true,
        },
      })
      track("onboarding_aha_revealed")
      await next()
    } finally {
      completionStartedRef.current = false
      setIsRevealing(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-5">
      <DecisionReceipt
        action={proof.action}
        decisions={proof.decisions}
        deniedRevealed={deniedRevealed}
      />

      {!deniedRevealed ? (
        <div className="flex flex-col items-start gap-3">
          <p className="max-w-xl text-background-text text-sm leading-6">
            The first request used the customer’s entire Sandbox budget. Now inspect the identical
            request that arrived next.
          </p>
          <Button disabled={isRevealing} onClick={() => void revealDeniedDecision()}>
            {isRevealing ? "Revealing decision…" : "Show the over-budget request"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <p className="font-medium text-background-textContrast text-base">
              Unprice stopped the action before it created additional cost.
            </p>
            <p className="max-w-xl text-background-text text-sm leading-6">
              Same customer, same paid action, same price. The budget changed the decision before
              your application performed the work.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <SuperLink
                href={`${projectBase}/apikeys`}
                onClick={() => track("onboarding_connect_app_selected")}
              >
                Connect my application
              </SuperLink>
            </Button>
            {projectSlug && planVersionId ? (
              <Button asChild variant="outline">
                <SuperLink href={`${projectBase}/plans/${planSlug}/${planVersionId}`}>
                  Adjust pricing
                </SuperLink>
              </Button>
            ) : null}
            <Button asChild variant="link">
              <SuperLink href={projectBase}>Explore the project</SuperLink>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
