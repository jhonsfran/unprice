"use client"

import { useQuery } from "@tanstack/react-query"
import { rowsByFeature } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { useTRPC } from "~/trpc/client"

export type PlanVersionCard = RouterOutputs["rateCards"]["forPlanVersion"]["cards"][number]

export function useVersionPricing(planVersionId: string | undefined, currency: string | undefined) {
  const trpc = useTRPC()
  const {
    data,
    dataUpdatedAt: now,
    isLoading,
  } = useQuery({
    ...trpc.rateCards.forPlanVersion.queryOptions({ planVersionId: planVersionId ?? "" }),
    enabled: Boolean(planVersionId),
  })
  const card = data?.cards.find((entry) => entry.currency === currency)
  return {
    card,
    rows: rowsByFeature(card?.rows ?? [], now),
    now,
    readiness: {
      hasCard: data?.hasCard ?? false,
      unpricedFeatureSlugs: data?.unpricedFeatureSlugs ?? [],
    },
    isLoading,
  }
}
