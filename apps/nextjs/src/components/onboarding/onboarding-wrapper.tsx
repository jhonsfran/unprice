"use client"
import { OnboardingProvider } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { track } from "@vercel/analytics"
import { type PropsWithChildren, useEffect } from "react"
import { steps } from "~/lib/onboarding-steps"
import { createFunnelPageEventClaimer } from "~/lib/signup-funnel"
import { useTRPC } from "~/trpc/client"

const ONBOARDING_STORAGE_KEY = "unprice_onboarding_v2"
const ONBOARDING_STARTED_EVENT = "funnel_onboarding_started"
const isDevelopment = process.env.NODE_ENV === "development"
const claimOnboardingStartEvent = createFunnelPageEventClaimer()

export function OnboardingWrapper({ children }: PropsWithChildren) {
  const trpc = useTRPC()

  const mutateSetOnboardingCompleted = useMutation(
    trpc.auth.setOnboardingCompleted.mutationOptions({
      onSuccess: () => {
        console.info("Onboarding complete")
      },
    })
  )

  useEffect(() => {
    if (isDevelopment) {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY)
    }

    if (claimOnboardingStartEvent(ONBOARDING_STARTED_EVENT)) {
      track(ONBOARDING_STARTED_EVENT)
    }
  }, [])

  return (
    <OnboardingProvider
      steps={steps}
      onFlowComplete={async () => {
        if (isDevelopment) {
          console.info("Onboarding complete")
          return
        }

        await mutateSetOnboardingCompleted.mutateAsync({ onboardingCompleted: true })
      }}
      debug={false}
      localStoragePersistence={
        isDevelopment
          ? undefined
          : {
              key: ONBOARDING_STORAGE_KEY,
              ttl: 1000 * 60 * 60 * 24 * 30, // 30 days
            }
      }
    >
      {children}
    </OnboardingProvider>
  )
}
