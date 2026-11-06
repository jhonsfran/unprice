"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RATE_CHANGE_NOTICE_MS, type RateCard } from "@unprice/db/validators"
import { MODEL_CATALOG_VERSION } from "@unprice/services/budgets"
import { Button } from "@unprice/ui/button"
import { Skeleton } from "@unprice/ui/skeleton"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { PriceMatrix } from "./price-matrix"
import {
  type CostPlusFeaturePolicy,
  cardCurrency,
  changeMatrixOf,
  describeChanges,
  earliestStart,
  markupPercent,
  toDateTimeLocal,
} from "./rate-card-format"
import { ScheduleField } from "./schedule-field"

/** "Follows models.dev 2026-10-20 at cost + 30%". */
export function describeCatalogPolicy(policy: CostPlusFeaturePolicy): string {
  return `Follows models.dev ${MODEL_CATALOG_VERSION} at cost + ${markupPercent(policy.markup)}%`
}

/**
 * What the catalog would change for one feature priced from it: nothing, or the models whose
 * rates moved, shown old beside new, with one action that publishes them.
 */
export function CatalogUpdates({
  card,
  policy,
  live,
  unit,
}: {
  card: RateCard
  policy: CostPlusFeaturePolicy
  live: boolean
  unit: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [schedule, setSchedule] = useState(false)
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    toDateTimeLocal(earliestStart(live, Date.now(), RATE_CHANGE_NOTICE_MS))
  )
  const { data, isLoading } = useQuery(
    trpc.rateCards.previewCostPlus.queryOptions({ cardId: card.id })
  )
  const { mutate, isPending } = useMutation(
    trpc.rateCards.publishCostPlus.mutationOptions({
      onSuccess: ({ inserted, closed }) => {
        toast.success(`Published ${inserted.length} prices, ended ${closed.length}`)
        void queryClient.invalidateQueries(trpc.rateCards.get.queryFilter({ id: card.id }))
        void queryClient.invalidateQueries(trpc.rateCards.previewCostPlus.pathFilter())
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
      },
    })
  )

  if (isLoading) return <Skeleton className="h-8 w-full" />
  if (!data) return null

  const matrix = changeMatrixOf(data.draft, policy.featureSlug)
  const summary = describeChanges(matrix)
  const writes = matrix.lines.filter(
    (line) => line.status === "added" || line.status === "changed"
  ).length

  if (matrix.lines.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">{describeCatalogPolicy(policy)}. Up to date.</p>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">The catalog changed: {summary}.</span>{" "}
          <span className="text-muted-foreground">{describeCatalogPolicy(policy)}.</span>
        </p>
      </div>
      <PriceMatrix matrix={matrix} currency={cardCurrency(card.unit)} unit={unit} />
      {writes > 0 && data.draftHash && (
        <form
          className="flex flex-wrap items-end justify-between gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            mutate({
              cardId: card.id,
              draftHash: data.draftHash ?? "",
              ...(schedule ? { effectiveFrom: new Date(effectiveFrom).getTime() } : {}),
            })
          }}
        >
          <ScheduleField
            id="catalog-from"
            label="Starts at"
            schedule={schedule}
            onScheduleChange={setSchedule}
            value={effectiveFrom}
            onChange={setEffectiveFrom}
          />
          <Button type="submit" size="sm" disabled={isPending || (schedule && !effectiveFrom)}>
            Apply {writes} {writes === 1 ? "price" : "prices"}
            {live && !schedule ? " in 10 min" : ""}
          </Button>
        </form>
      )}
    </section>
  )
}
