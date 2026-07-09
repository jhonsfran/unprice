"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { ArrowRight, CheckCircle2 } from "lucide-react"

const STEP_COPY: Record<string, { label: string; detail: string }> = {
  welcome: {
    label: "Start",
    detail: "paid workflow",
  },
  project: {
    label: "Project",
    detail: "workspace context",
  },
  "payment-provider": {
    label: "Payment Provider",
    detail: "sandbox",
  },
  "template-plan": {
    label: "Plan version",
    detail: "features + meters",
  },
  "seed-metrics": {
    label: "Evidence",
    detail: "budgeted run",
  },
  done: {
    label: "Inspect",
    detail: "project overview",
  },
}

export function StepNavigator() {
  const { state, goToStep, engine } = useOnboarding()
  const steps = engine?.getRelevantSteps() ?? []
  const currentStepNumber = state?.currentStepNumber ?? 1

  if (!steps.length) {
    return null
  }

  return (
    <nav aria-label="Onboarding money path" className="flex w-full flex-col gap-8">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {steps.map((currentStep, index) => {
          const isCurrentStep = state?.currentStepNumber === index + 1
          const isCompleted = index + 1 < currentStepNumber
          const isLocked = index + 1 > currentStepNumber
          const stepCopy = STEP_COPY[String(currentStep.id)] ?? {
            label: String(currentStep.id),
            detail: "next state",
          }

          return (
            <div key={currentStep.id} className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-current={isCurrentStep ? "step" : undefined}
                disabled={isLocked}
                className={cn(
                  "h-auto min-w-0 gap-2 bg-transparent px-2.5 py-2 text-left",
                  isLocked && "cursor-not-allowed opacity-60"
                )}
                onClick={() => goToStep(String(currentStep.id))}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums",
                    isCurrentStep && "primary",
                    isCompleted && "success",
                    !isCurrentStep && !isCompleted && "border-border text-muted-foreground"
                  )}
                >
                  {isCompleted ? <CheckCircle2 className="size-3" /> : index + 1}
                </span>
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="max-w-32 truncate font-medium text-xs">{stepCopy.label}</span>
                  <span className="hidden max-w-28 truncate text-[11px] text-muted-foreground sm:block">
                    {stepCopy.detail}
                  </span>
                </span>
              </Button>
              {index < steps.length - 1 && (
                <ArrowRight className="hidden size-3 text-muted-foreground md:block" />
              )}
            </div>
          )
        })}
      </div>
      <p className="text-center text-muted-foreground text-xs">
        Request path to plan version, budgeted run, customer, and usage evidence.
      </p>
    </nav>
  )
}
