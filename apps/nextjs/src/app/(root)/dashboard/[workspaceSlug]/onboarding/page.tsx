import { getSession } from "@unprice/auth/server-rsc"
import { redirect } from "next/navigation"
import { OnboardingUI } from "~/components/onboarding/onboarding-ui"
import { OnboardingWrapper } from "~/components/onboarding/onboarding-wrapper"
import { StepNavigator } from "~/components/onboarding/step-navigator"

export default async function OnboardingPage(props: {
  params: { workspaceSlug: string }
}) {
  const { workspaceSlug } = props.params
  const session = await getSession()
  const onboardingCompleted = session?.user?.onboardingCompleted ?? false
  const isDevelopment = process.env.NODE_ENV === "development"

  if (onboardingCompleted && !isDevelopment) {
    return redirect(`/${workspaceSlug}`)
  }

  // the hero and the money-path stepper center together as one group; a
  // stepper pinned to the bottom of an empty viewport reads as detached
  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-screen-lg flex-col items-center justify-center gap-14 px-4 py-10">
      <OnboardingWrapper>
        <div className="flex w-full flex-col items-center overflow-x-hidden">
          <OnboardingUI />
        </div>
        <div className="flex w-full shrink-0 items-center justify-center">
          <StepNavigator />
        </div>
      </OnboardingWrapper>
    </div>
  )
}
