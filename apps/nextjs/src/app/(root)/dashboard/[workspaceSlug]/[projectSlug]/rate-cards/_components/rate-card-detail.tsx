"use client"

import { useQuery } from "@tanstack/react-query"
import { featureSlugsOf, priceTableOf } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { Rows3 } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useTRPC } from "~/trpc/client"
import { CatalogUpdates, describeCatalogPolicy } from "./catalog-updates"
import { CloseRowDialog } from "./close-row-dialog"
import { PriceMatrix } from "./price-matrix"
import { PublishRowsDialog } from "./publish-rows-dialog"
import { cardCurrency, catalogPolicyFor, describeCardState, matrixOf } from "./rate-card-format"

type RateCardData = RouterOutputs["rateCards"]["get"]

/** How a feature is named and counted, from the plan version or the catalog. */
export type FeatureLabel = Readonly<{ slug: string; title: string; unit: string }>

/** A card's prices, feature by feature, read as a price list. */
export function RateCardDetail({
  cardId,
  features,
}: {
  cardId: string
  /** Titles and units for the card's features; a feature not listed shows its slug. */
  features?: readonly FeatureLabel[]
}) {
  const trpc = useTRPC()
  // The lines are split as of when they were read, so a refetch after a write resplits them.
  const { data, isLoading, dataUpdatedAt } = useQuery(
    trpc.rateCards.get.queryOptions({ id: cardId })
  )
  const { data: catalog } = useQuery({
    ...trpc.features.listByActiveProject.queryOptions(),
    enabled: features === undefined,
  })

  if (isLoading || !data) return <EmptyPlaceholder isLoading className="min-h-[360px]" />

  const labels =
    features ??
    (catalog?.features ?? []).map((feature) => ({
      slug: feature.slug,
      title: feature.title,
      unit: feature.unitOfMeasure ?? "units",
    }))

  return <PriceList data={data} features={labels} now={dataUpdatedAt} />
}

const SHOWN_LINES = 12

function labelFor(features: readonly FeatureLabel[], slug: string): FeatureLabel {
  return features.find((feature) => feature.slug === slug) ?? { slug, title: slug, unit: "units" }
}

/** The price list with fixed data, so a test renders it against a fixed clock. */
export function PriceList({
  data,
  features,
  now,
}: {
  data: RateCardData
  features: readonly FeatureLabel[]
  now: number
}) {
  const { card, rows, live } = data
  const currency = cardCurrency(card.unit)
  const slugs = featureSlugsOf(rows)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Typography variant="p" affects="removePaddingMargin" className="text-muted-foreground">
          {describeCardState(live)}
        </Typography>
        <PublishRowsDialog card={card} rows={rows} live={live}>
          <Button size="sm" variant="outline">
            Add a price row
          </Button>
        </PublishRowsDialog>
      </div>

      {slugs.length === 0 ? (
        <EmptyPlaceholder className="min-h-[240px]">
          <EmptyPlaceholder.Icon>
            <Rows3 className="h-8 w-8" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No prices yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Set a price per feature in the plan editor, or add a price row here. A feature without a
            price cannot publish.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      ) : (
        slugs.map((slug) => {
          const feature = labelFor(features, slug)
          const unit = feature.unit.replace(/s$/, "")
          const table = priceTableOf(slug, rows, now, currency, unit)
          const policy = catalogPolicyFor(card.marginPolicy, slug)
          const ended = matrixOf(table, "ended")
          return (
            <section key={slug} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Typography variant="h5" affects="removePaddingMargin">
                  {feature.title}
                </Typography>
                <span className="text-muted-foreground text-xs">
                  {table.dimensions.length > 0
                    ? `${table.lines.length} prices by ${table.dimensions.join(", ")}`
                    : null}
                  {policy && table.dimensions.length > 0 ? " · " : null}
                  {policy ? describeCatalogPolicy(policy) : null}
                </span>
              </div>
              <PriceMatrix
                matrix={matrixOf(table)}
                currency={currency}
                unit={unit}
                limit={table.dimensions.length > 0 ? SHOWN_LINES : undefined}
                action={(line) =>
                  line.row && line.row.effectiveTo === null ? (
                    <CloseRowDialog cardId={card.id} row={line.row} live={live} />
                  ) : null
                }
              />
              {policy && <CatalogUpdates card={card} policy={policy} live={live} unit={unit} />}
              {ended.lines.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground text-xs">
                    {ended.lines.length} past {ended.lines.length === 1 ? "price" : "prices"}
                  </summary>
                  <PriceMatrix
                    matrix={ended}
                    currency={currency}
                    unit={unit}
                    className="mt-2 opacity-80"
                  />
                </details>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
