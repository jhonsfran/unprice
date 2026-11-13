"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { useRouter } from "next/navigation"
import { useTRPC } from "~/trpc/client"
import { withDefaultRow } from "./plan-prices"

type SavedFeature = RouterOutputs["planVersionFeatures"]["update"]["planVersionFeature"]

export function useUpdatePlanFeature({
  currency,
  onSaved,
}: {
  currency: string | undefined
  onSaved?: (feature: SavedFeature) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  return useMutation(
    trpc.planVersionFeatures.update.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ planVersionFeature, row }, variables) => {
        if (variables.price !== undefined && currency) {
          queryClient.setQueryData(
            trpc.rateCards.forPlanVersion.queryKey({ planVersionId: variables.planVersionId }),
            (cached) =>
              cached
                ? {
                    ...cached,
                    cards: withDefaultRow(
                      cached.cards,
                      currency,
                      planVersionFeature.feature.slug,
                      row
                    ),
                  }
                : cached
          )
        }
        onSaved?.(planVersionFeature)
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
        void queryClient.invalidateQueries(trpc.planVersions.getById.pathFilter())
        router.refresh()
      },
    })
  )
}
