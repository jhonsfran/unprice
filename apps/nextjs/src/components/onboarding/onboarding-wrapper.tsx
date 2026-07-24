"use client"
import { OnboardingProvider } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { track } from "@vercel/analytics"
import { type PropsWithChildren, useEffect } from "react"
import { steps } from "~/lib/onboarding-steps"
import { createFunnelPageEventClaimer } from "~/lib/signup-funnel"
import { useTRPC } from "~/trpc/client"

// v4 replaces the setup rail with the paid-action proof. Keep persistence in
// development too: reload and retry are part of the onboarding contract.
const ONBOARDING_STORAGE_KEY = "unprice_onboarding_v4"
const ONBOARDING_STARTED_EVENT = "funnel_onboarding_started"
const isDevelopment = process.env.NODE_ENV === "development"
const claimOnboardingStartEvent = createFunnelPageEventClaimer()

export function OnboardingWrapper({ children }: PropsWithChildren) {
  const trpc = useTRPC()

  const mutateSetOnboardingCompleted = useMutation(
    trpc.auth.setOnboardingCompleted.mutationOptions()
  )

  useEffect(() => {
    if (claimOnboardingStartEvent(ONBOARDING_STARTED_EVENT)) {
      track(ONBOARDING_STARTED_EVENT)
    }
  }, [])

  return (
    <OnboardingProvider
      steps={steps}
      onFlowComplete={async () => {
        if (isDevelopment) {
          return
        }

        await mutateSetOnboardingCompleted.mutateAsync({ onboardingCompleted: true })
      }}
      debug={false}
      localStoragePersistence={{
        key: ONBOARDING_STORAGE_KEY,
        ttl: 1000 * 60 * 60 * 24 * 30,
      }}
    >
      {children}
    </OnboardingProvider>
  )
}
