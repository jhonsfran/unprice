"use client"
import { OnboardingProvider } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { type PropsWithChildren, useEffect } from "react"
import { steps } from "~/lib/onboarding-steps"
import { useTRPC } from "~/trpc/client"

const ONBOARDING_STORAGE_KEY = "unprice_onboarding_v2"
const isDevelopment = process.env.NODE_ENV === "development"

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
  }, [])

  return (
    <OnboardingProvider
      steps={steps}
      onFlowComplete={() => {
        if (isDevelopment) {
          console.info("Onboarding complete")
          return
        }

        mutateSetOnboardingCompleted.mutate({ onboardingCompleted: true })
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
