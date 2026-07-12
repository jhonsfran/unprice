"use client"

import { useOnboarding } from "@onboardjs/react"
import { cn } from "@unprice/ui/utils"
import { useParams } from "next/navigation"
import { useEffect, useRef } from "react"
import Balancer from "react-wrap-balancer"

import { updateContextCookies } from "~/actions/update-context-cookies"
import { useIsOnboarding } from "~/hooks/use-features"
import { MoneyPathRail } from "./money-path-rail"
import { type OnboardingFlowData, type OnboardingMomentId, deriveRailState } from "./rail-state"
import { ReceiptStep } from "./steps/receipt-step"

// One stable anatomy across the whole flow: eyebrow + two-tone headline on
// the page ground, then the single lifted panel — moment content on the
// left, the money-path rail on the right. The copy changes per moment; the
// frame never moves, so progress reads as the rail settling, not the page
// rearranging itself.

const MOMENT_COPY: Record<
  OnboardingMomentId,
  { index: string; setup: string; operative: string; sub: string }
> = {
  welcome: {
    index: "01",
    setup: "Build one",
    operative: "Sandbox paid action.",
    sub: "Create a Sandbox project, publish a plan version, assign a test customer, and generate synthetic evidence for the paid action you want to protect.",
  },
  project: {
    index: "02",
    setup: "Name the",
    operative: "Sandbox project.",
    sub: "This project holds the plan versions, test customer, API key, and synthetic evidence for the walkthrough.",
  },
  build: {
    index: "03",
    setup: "Building",
    operative: "the money path.",
    sub: "Three real requests against your workspace. Every fact on the rail is written from a response; the budget evidence is synthetic.",
  },
  receipt: {
    index: "04",
    setup: "Your Sandbox paid action",
    operative: "is ready.",
    sub: "A published plan, test customer, active subscription, and synthetic budget evidence — inspect any line from the project overview.",
  },
}

function isMomentId(id: string): id is OnboardingMomentId {
  return id in MOMENT_COPY
}

export function OnboardingShell() {
  const { renderStep, currentStep, state } = useOnboarding()
  const [, setIsOnboarding] = useIsOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousMomentRef = useRef<OnboardingMomentId | null>(null)

  const flowData = state?.context?.flowData as OnboardingFlowData | undefined

  // After the engine completes, currentStep is null: keep showing the receipt
  // while the redirect happens.
  const rawStepId = currentStep == null ? "receipt" : String(currentStep.id)
  const moment: OnboardingMomentId = isMomentId(rawStepId) ? rawStepId : "receipt"

  const stations = deriveRailState(flowData, moment)
  const copy = MOMENT_COPY[moment]

  // Sync cookies if the user reloads the page and the project is already
  // created, so onboarding API requests resolve the active project context.
  useEffect(() => {
    const projectSlug = flowData?.project?.slug
    if (projectSlug && workspaceSlug) {
      void updateContextCookies(workspaceSlug, projectSlug)
    }
  }, [flowData?.project?.slug, workspaceSlug])

  useEffect(() => {
    setIsOnboarding(true)
  }, [])

  // Keep the reader oriented: when the moment changes, move focus to the
  // headline that just described it. Skip the initial render.
  useEffect(() => {
    if (previousMomentRef.current !== null && previousMomentRef.current !== moment) {
      headingRef.current?.focus({ preventScroll: true })
    }
    previousMomentRef.current = moment
  }, [moment])

  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
          <span className="font-mono text-background-text text-xs uppercase tracking-widest">
            sandbox · money path
          </span>
          <span className="font-mono text-[10px] text-background-text tabular-nums">
            {copy.index} / 04
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
        aria-label="Onboarding money path"
        className="overflow-hidden rounded-lg border border-background-border bg-surface-panel shadow-raised"
      >
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
          <div className={cn("flex flex-col justify-center p-6 sm:p-8", "lg:min-h-[420px]")}>
            {currentStep == null ? <ReceiptStep /> : renderStep()}
          </div>
          <div className="border-background-border border-t bg-background-bgSubtle p-6 lg:border-t-0 lg:border-l">
            <MoneyPathRail stations={stations} />
          </div>
        </div>
      </section>
    </div>
  )
}
