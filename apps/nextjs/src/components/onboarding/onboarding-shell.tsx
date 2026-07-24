"use client"

import { useOnboarding } from "@onboardjs/react"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { useParams } from "next/navigation"
import { useEffect, useRef } from "react"
import Balancer from "react-wrap-balancer"

import { updateContextCookies } from "~/actions/update-context-cookies"
import { useIsOnboarding } from "~/hooks/use-features"
import type { OnboardingFlowData } from "./paid-action-schema"
import { ReceiptStep } from "./steps/receipt-step"

type OnboardingMomentId = "paid-action" | "proof" | "receipt"

const MOMENT_COPY: Record<
  OnboardingMomentId,
  { index: string; setup: string; operative: string; sub: string }
> = {
  "paid-action": {
    index: "01",
    setup: "Define one",
    operative: "paid action.",
    sub: "Name work your customer pays for. Unprice will save it as a real metered feature and prove the budget decision.",
  },
  proof: {
    index: "02",
    setup: "Prove the",
    operative: "budget guardrail.",
    sub: "We are preparing a real Sandbox plan, then sending the same paid action twice against one action of budget.",
  },
  receipt: {
    index: "03",
    setup: "See the decision",
    operative: "before the cost.",
    sub: "First inspect the allowed request. Then reveal what happened when the identical request arrived with no budget remaining.",
  },
}

const MOMENT_LABELS: Array<{ id: OnboardingMomentId; label: string }> = [
  { id: "paid-action", label: "Paid action" },
  { id: "proof", label: "Real proof" },
  { id: "receipt", label: "Decision" },
]

function isMomentId(id: string): id is OnboardingMomentId {
  return id in MOMENT_COPY
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
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousMomentRef = useRef<OnboardingMomentId | null>(null)
  const flowData = state?.context?.flowData as OnboardingFlowData | undefined
  const isReady = Boolean(state && !loading.isHydrating && (currentStep || isCompleted))
  const rawStepId =
    currentStep == null ? (isCompleted ? "receipt" : "paid-action") : String(currentStep.id)
  const moment: OnboardingMomentId = isMomentId(rawStepId) ? rawStepId : "receipt"
  const copy = MOMENT_COPY[moment]
  const activeIndex = MOMENT_LABELS.findIndex(({ id }) => id === moment)

  useEffect(() => {
    const projectSlug = flowData?.project?.slug
    if (projectSlug && workspaceSlug) {
      void updateContextCookies(workspaceSlug, projectSlug)
    }
  }, [flowData?.project?.slug, workspaceSlug])

  useEffect(() => {
    setIsOnboarding(true)
  }, [setIsOnboarding])

  useEffect(() => {
    if (previousMomentRef.current !== null && previousMomentRef.current !== moment) {
      headingRef.current?.focus({ preventScroll: true })
    }
    previousMomentRef.current = moment
  }, [moment])

  if (!isReady) {
    return <OnboardingShellSkeleton />
  }

  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
          <span className="font-mono text-background-text text-xs uppercase tracking-widest">
            sandbox · paid action proof
          </span>
          <span className="font-mono text-[10px] text-background-text tabular-nums">
            {copy.index} / 03
          </span>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-primary text-background-textContrast text-display-3 outline-none"
        >
          <Balancer>
            <span className="text-background-text">{copy.setup}</span> {copy.operative}
          </Balancer>
        </h1>
        <p className="max-w-2xl text-background-text text-sm leading-6">{copy.sub}</p>
      </header>

      <section
        aria-label="Paid-action onboarding"
        className="overflow-hidden rounded-lg border border-background-border bg-surface-panel shadow-raised"
      >
        <ol className="grid grid-cols-3 border-background-border border-b bg-background-bgSubtle">
          {MOMENT_LABELS.map((item, index) => {
            const current = index === activeIndex
            const completed = index < activeIndex
            return (
              <li
                key={item.id}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 border-background-border border-r px-3 py-3 text-xs last:border-r-0 sm:px-5",
                  current || completed ? "text-background-textContrast" : "text-background-text"
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px]",
                    // Blue marks the current moment (live context); amber stays
                    // reserved for the one primary action per view.
                    current
                      ? "bg-info-solid text-white"
                      : completed
                        ? "bg-success-solid text-white"
                        : "bg-background-bgActive text-background-text"
                  )}
                >
                  {index + 1}
                </span>
                <span className="truncate">{item.label}</span>
              </li>
            )
          })}
        </ol>

        <div className="flex min-h-[380px] flex-col justify-center p-6 sm:p-8">
          {currentStep == null ? <ReceiptStep /> : renderStep()}
        </div>
      </section>
    </div>
  )
}
