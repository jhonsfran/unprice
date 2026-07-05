"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import {
  type CurrentAccessData,
  CurrentAccessOverview,
  type CurrentAccessWallet,
  PlanVersionButton,
} from "~/components/billing/current-access-overview"
import { SuperLink } from "~/components/super-link"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { EntitlementConfigSheet } from "./entitlement-config-sheet"

export function CustomerCurrentAccess({
  access: initialAccess,
  wallet,
  subscriptionsHref,
  plansHref,
}: {
  access: CurrentAccessData
  wallet: CurrentAccessWallet
  subscriptionsHref: string
  plansHref: string
}) {
  const trpc = useTRPC()
  const { data: access, isFetching } = useSuspenseQuery(
    trpc.customers.getCurrentAccess.queryOptions(
      {
        customerId: initialAccess.customerId,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        initialData: initialAccess,
      }
    )
  )
  const activePlan = access.activePlan
  const activePhase = activePlan?.activePhase ?? null
  const planVersionHref =
    activePlan && activePhase
      ? `${plansHref}/${encodeURIComponent(activePlan.planSlug)}/${encodeURIComponent(
          activePhase.planVersion.id
        )}`
      : null

  return (
    <CurrentAccessOverview
      access={access}
      wallet={wallet}
      isFetching={isFetching}
      billingPeriodAction={
        <Button asChild variant="ghost" size="sm">
          <SuperLink href={subscriptionsHref}>View subscriptions</SuperLink>
        </Button>
      }
      planAction={planVersionHref ? <PlanVersionButton href={planVersionHref} /> : null}
      renderEntitlementAction={(entitlement) => (
        <EntitlementConfigSheet
          entitlement={entitlement}
          planVersionId={activePhase?.planVersion.id ?? null}
        />
      )}
    />
  )
}
