"use client"

import type { RateRow } from "@unprice/db/validators"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { type PriceState, rowsByFeature } from "~/components/pricing/plan-prices"
import { useVersionPricing } from "~/components/pricing/use-version-pricing"
import { usePlanFeaturesList } from "~/hooks/use-features"
import { type StatusTone, statusToneClasses } from "~/lib/status-tones"

/** What publishing checks, read from the editor's feature list and the version's card. */
export function PublishChecklist({
  planVersionId,
  currency,
}: {
  planVersionId: string
  currency: string
}) {
  const [features] = usePlanFeaturesList()
  const { card, now, readiness, isLoading } = useVersionPricing(planVersionId, currency)
  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <PublishChecklistView
      features={features.map((entry) => ({ slug: entry.feature.slug, title: entry.feature.title }))}
      rows={card?.rows ?? []}
      hasCard={readiness.hasCard}
      unpricedFeatureSlugs={readiness.unpricedFeatureSlugs}
      currency={currency}
      now={now}
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
  unpricedFeatureSlugs,
  currency,
  now,
}: {
  features: readonly { slug: string; title: string }[]
  rows: readonly RateRow[]
  hasCard: boolean
  unpricedFeatureSlugs: readonly string[]
  currency: string
  now: number
}) {
  const byFeature = rowsByFeature(rows, now)
  const lines = features.map((feature) => ({
    ...feature,
    state: unpricedFeatureSlugs.includes(feature.slug)
      ? ("unpriced" as const)
      : byFeature.get(feature.slug)?.scheduled &&
          !byFeature.get(feature.slug)?.current &&
          !byFeature.get(feature.slug)?.byDimension.length
        ? ("scheduled" as const)
        : ("priced" as const),
  }))
  const unpriced = unpricedFeatureSlugs.length

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
