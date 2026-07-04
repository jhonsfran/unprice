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

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-screen-lg flex-col items-center px-4">
      <OnboardingWrapper>
        <div className="flex w-full flex-1 flex-col items-center justify-center overflow-x-hidden py-10">
          <OnboardingUI />
        </div>
        <div className="flex w-full shrink-0 items-center justify-center pb-8">
          <StepNavigator />
        </div>
      </OnboardingWrapper>
    </div>
  )
}
