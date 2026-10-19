import { getSession } from "@unprice/auth/server-rsc"
import { redirect } from "next/navigation"
import { OnboardingShell } from "~/components/onboarding/onboarding-shell"
import { OnboardingWrapper } from "~/components/onboarding/onboarding-wrapper"

export default async function OnboardingPage(props: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const [{ workspaceSlug }, session] = await Promise.all([props.params, getSession()])
  const onboardingCompleted = session?.user?.onboardingCompleted ?? false
  const isDevelopment = process.env.NODE_ENV === "development"

  if (onboardingCompleted && !isDevelopment) {
    return redirect(`/${workspaceSlug}`)
  }

  return (
    <OnboardingWrapper>
      <OnboardingShell />
    </OnboardingWrapper>
  )
}
