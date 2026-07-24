import type { OnboardingStep } from "@onboardjs/react"
import { PaidActionStep } from "~/components/onboarding/steps/paid-action-step"
import { ProofStep } from "~/components/onboarding/steps/proof-step"
import { ReceiptStep } from "~/components/onboarding/steps/receipt-step"

export const STEP_IDS = ["paid-action", "proof", "receipt"] as const

export const steps: OnboardingStep[] = [
  {
    id: "paid-action",
    component: PaidActionStep,
    nextStep: "proof",
  },
  {
    id: "proof",
    component: ProofStep,
    nextStep: "receipt",
  },
  {
    id: "receipt",
    component: ReceiptStep,
    nextStep: null,
  },
]
