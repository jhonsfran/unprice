import { getSession } from "@unprice/auth/server-rsc"
import { redirect } from "next/navigation"
import { BudgetsSetup } from "~/components/onboarding/budgets-setup"
import { OnboardingShell } from "~/components/onboarding/onboarding-shell"
import { OnboardingWrapper } from "~/components/onboarding/onboarding-wrapper"
import { getSignupIntent } from "~/lib/signup-funnel"

export default async function OnboardingPage(props: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ intent?: string | string[] }>
}) {
  const [{ workspaceSlug }, { intent }, session] = await Promise.all([
    props.params,
    props.searchParams,
    getSession(),
  ])

  // A Budgets visitor came for a runtime key, not the paid-action proof. The setup stays
  // reachable after onboarding, because a returning builder may want a key for a new project.
  if (getSignupIntent(intent) === "budgets") {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-4xl flex-col justify-center px-4 py-10">
        <BudgetsSetup />
      </div>
    )
  }

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
