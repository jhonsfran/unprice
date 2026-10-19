import { BudgetsSetup } from "~/components/onboarding/budgets-setup"
import { getSingleSearchParam } from "~/lib/signup-funnel"

// The Budgets setup: a visitor from /budgets came for a runtime key, not the paid-action proof. It
// stays reachable after onboarding, because a returning builder may want a key for a new project.
export default async function BudgetsOnboardingPage(props: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ project?: string | string[] }>
}) {
  const [{ workspaceSlug }, { project }] = await Promise.all([props.params, props.searchParams])
  return (
    <BudgetsSetup
      workspaceSlug={workspaceSlug}
      projectSlug={getSingleSearchParam(project) ?? null}
    />
  )
}
