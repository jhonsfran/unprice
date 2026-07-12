import type { OnboardingStep } from "@onboardjs/react"
import { BuildStep } from "~/components/onboarding/steps/build-step"
import { ProjectStep } from "~/components/onboarding/steps/project-step"
import { ReceiptStep } from "~/components/onboarding/steps/receipt-step"
import { WelcomeStep } from "~/components/onboarding/steps/welcome-step"

// Four moments on the money path: the pitch, the only human input, the
// automated build (provider → plan versions → synthetic evidence), and the
// receipt. Progress renders on the rail in onboarding-shell, not in a
// separate navigator.

export const STEP_IDS = ["welcome", "project", "build", "receipt"] as const

export const steps: OnboardingStep[] = [
  {
    id: "welcome",
    component: WelcomeStep,
    nextStep: "project",
  },
  {
    id: "project",
    component: ProjectStep,
    nextStep: "build",
  },
  {
    id: "build",
    component: BuildStep,
    nextStep: "receipt",
  },
  {
    id: "receipt",
    component: ReceiptStep,
    nextStep: null,
  },
]
