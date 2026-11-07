"use client"

import { useQuery } from "@tanstack/react-query"
import type { RateRow } from "@unprice/db/validators"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { usePlanFeaturesList } from "~/hooks/use-features"
import { type StatusTone, statusToneClasses } from "~/lib/status-tones"
import { useTRPC } from "~/trpc/client"
import { type PriceState, priceStateOf, rowsByFeature } from "../../../_components/plan-prices"

/** What publishing checks, read from the editor's feature list and the version's card. */
export function PublishChecklist({
  planVersionId,
  currency,
}: {
  planVersionId: string
  currency: string
}) {
  const trpc = useTRPC()
  const [features] = usePlanFeaturesList()
  const { data, dataUpdatedAt, isLoading } = useQuery(
    trpc.rateCards.forPlanVersion.queryOptions({ planVersionId })
  )

  if (isLoading) return <Skeleton className="h-20 w-full" />

  const card = data?.cards.find((entry) => entry.currency === currency)

  return (
    <PublishChecklistView
      features={features.map((entry) => ({ slug: entry.feature.slug, title: entry.feature.title }))}
      rows={card?.rows ?? []}
      hasCard={Boolean(card)}
      currency={currency}
      now={dataUpdatedAt}
    />
  )
}

const STATE_TONE: Record<PriceState, StatusTone> = {
  priced: "success",
  scheduled: "info",
  unpriced: "warning",
}

/** The checklist with fixed data: one line per feature, the card line, and the count publish refuses on. */
export function PublishChecklistView({
  features,
  rows,
  hasCard,
  currency,
  now,
}: {
  features: readonly { slug: string; title: string }[]
  rows: readonly RateRow[]
  hasCard: boolean
  currency: string
  now: number
}) {
  const byFeature = rowsByFeature(rows, now)
  const lines = features.map((feature) => ({
    ...feature,
    state: priceStateOf(byFeature.get(feature.slug)),
  }))
  const unpriced = lines.filter((line) => line.state === "unpriced").length

  return (
    <div className="rounded-md border bg-card text-xs">
      <ChecklistLine
        tone={hasCard ? "success" : "warning"}
        label={`Card in ${currency}`}
        value={hasCard ? "present" : "none yet"}
      />
      {lines.map((line) => (
        <ChecklistLine
          key={line.slug}
          tone={STATE_TONE[line.state]}
          label={line.title}
          value={line.state}
        />
      ))}
      <p className="px-3 py-2 text-muted-foreground">
        {features.length === 0
          ? "Attach a feature to start."
          : unpriced === 0
            ? "Every feature is priced."
            : `${unpriced} unpriced ${unpriced === 1 ? "feature" : "features"}. Publishing refuses until each has a price.`}
      </p>
    </div>
  )
}

function ChecklistLine({
  tone,
  label,
  value,
}: {
  tone: StatusTone
  label: string
  value: string
}) {
  const classes = statusToneClasses[tone]
  return (
    <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
      <span className="truncate text-foreground/70">{label}</span>
      <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono", classes.text)}>
        <span className={cn("size-1.5 rounded-full", classes.dot)} />
        {value}
      </span>
    </div>
  )
}
