"use client"

import { useOnboarding } from "@onboardjs/react"
import { Skeleton } from "@unprice/ui/skeleton"
import { useParams } from "next/navigation"
import { useEffect } from "react"

import { updateContextCookies } from "~/actions/update-context-cookies"
import { useIsOnboarding } from "~/hooks/use-features"
import { OnboardingFrame, type OnboardingMoment } from "./onboarding-frame"
import type { OnboardingFlowData } from "./paid-action-schema"
import { ReceiptStep } from "./steps/receipt-step"

type OnboardingMomentId = "paid-action" | "proof" | "receipt"

const MOMENTS: Record<OnboardingMomentId, OnboardingMoment> = {
  "paid-action": {
    label: "Paid action",
    setup: "Define one",
    operative: "paid action.",
    sub: "Name work your customer pays for. Unprice will save it as a real metered feature and prove the budget decision.",
  },
  proof: {
    label: "Real proof",
    setup: "Prove the",
    operative: "budget guardrail.",
    sub: "We are preparing a real Sandbox plan, then sending the same paid action twice against one action of budget.",
  },
  receipt: {
    label: "Decision",
    setup: "See the decision",
    operative: "before the cost.",
    sub: "First inspect the allowed request. Then reveal what happened when the identical request arrived with no budget remaining.",
  },
}

function isMomentId(id: string): id is OnboardingMomentId {
  return id in MOMENTS
}

function OnboardingShellSkeleton() {
  return (
    <div className="flex w-full flex-col gap-8" aria-label="Loading onboarding">
      <header className="flex flex-col gap-4">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-12 w-3/5" />
        <Skeleton className="h-5 w-4/5" />
      </header>
      <div className="overflow-hidden rounded-lg border border-background-border bg-surface-panel">
        <Skeleton className="h-12 w-full rounded-none" />
        <div className="flex min-h-[380px] flex-col justify-center gap-4 p-6 sm:p-8">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-9 w-52" />
        </div>
      </div>
    </div>
  )
}

export function OnboardingShell() {
  const { renderStep, currentStep, isCompleted, loading, state } = useOnboarding()
  const [, setIsOnboarding] = useIsOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const flowData = state?.context?.flowData as OnboardingFlowData | undefined
  const isReady = Boolean(state && !loading.isHydrating && (currentStep || isCompleted))
  const rawStepId =
    currentStep == null ? (isCompleted ? "receipt" : "paid-action") : String(currentStep.id)
  const moment: OnboardingMomentId = isMomentId(rawStepId) ? rawStepId : "receipt"

  useEffect(() => {
    const projectSlug = flowData?.project?.slug
    if (projectSlug && workspaceSlug) {
      void updateContextCookies(workspaceSlug, projectSlug)
    }
  }, [flowData?.project?.slug, workspaceSlug])

  useEffect(() => {
    setIsOnboarding(true)
  }, [setIsOnboarding])

  if (!isReady) {
    return <OnboardingShellSkeleton />
  }

  return (
    <OnboardingFrame
      eyebrow="sandbox · paid action proof"
      label="Paid-action onboarding"
      moments={MOMENTS}
      active={moment}
    >
      <div className="flex min-h-[380px] flex-col justify-center p-6 sm:p-8">
        {currentStep == null ? <ReceiptStep /> : renderStep()}
      </div>
    </OnboardingFrame>
  )
}
