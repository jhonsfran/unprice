import { getSession } from "@unprice/auth/server-rsc"
import { redirect } from "next/navigation"
import { OnboardingShell } from "~/components/onboarding/onboarding-shell"
import { OnboardingWrapper } from "~/components/onboarding/onboarding-wrapper"

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
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-4xl flex-col justify-center px-4 py-10">
      <OnboardingWrapper>
        <OnboardingShell />
      </OnboardingWrapper>
    </div>
  )
}
