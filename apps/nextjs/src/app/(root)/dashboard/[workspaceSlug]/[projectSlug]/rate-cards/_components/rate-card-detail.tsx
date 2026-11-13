"use client"

import { singularUnit } from "@unprice/services/pricing"

import { useQuery } from "@tanstack/react-query"
import { formatAmount } from "@unprice/money"
import { MODEL_CATALOG_VERSION } from "@unprice/services/budgets"
import { type PricingShape, featureSlugsOf, priceTableOf } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { Typography } from "@unprice/ui/typography"
import { Plus, RefreshCw, Rows3 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import {
  LinePrice,
  PriceMatrix,
  StatusBadge,
  visibleApplies,
} from "~/components/pricing/price-matrix"
import {
  type MatrixLine,
  cardCurrency,
  catalogPolicyFor,
  describeCardState,
  markupPercent,
  matrixOf,
} from "~/components/pricing/rate-card-format"
import { CollapsibleSection } from "~/components/pricing/section-label"
import { useTRPC } from "~/trpc/client"
import { CatalogUpdates } from "./catalog-updates"
import { CloseRowDialog } from "./close-row-dialog"
import { PublishRowsDialog } from "./publish-rows-dialog"

type RateCardData = RouterOutputs["rateCards"]["get"]

/** How a feature is named and counted, from the plan version or the catalog. */
export type FeatureLabel = Readonly<{
  slug: string
  title: string
  unit: string
  /** How the feature is charged in words, such as "Fixed, every month"; the plan version knows. */
  charge?: string
  /**
   * What the feature's configuration fixes about any price for it: the shape, the event property
   * its meter counts, a bundle's size. A new price only rates it; changing these is a feature edit.
   */
  pricing?: Readonly<{ shape: PricingShape; property: string | null; size: number | null }>
}>

/** A card's prices, feature by feature, read as a price list. */
export function RateCardDetail({
  cardId,
  features,
  readOnly,
  catalogMarkup,
  catalogActions,
}: {
  cardId: string
  /** Titles and units for the card's features; a feature not listed shows its slug. */
  features?: readonly FeatureLabel[]
  /** A preview: the prices without the actions that change them. */
  readOnly?: boolean
  /** The markup in the catalog rule, rendered as a control that changes it. */
  catalogMarkup?: (featureSlug: string) => ReactNode
  /** What the catalog line offers after the rule, such as adding a model of the project's own. */
  catalogActions?: (featureSlug: string) => ReactNode
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

  return (
    <PriceList
      data={data}
      features={labels}
      now={dataUpdatedAt}
      readOnly={readOnly}
      catalogMarkup={catalogMarkup}
      catalogActions={catalogActions}
    />
  )
}

const SHOWN_LINES = 10

function labelFor(features: readonly FeatureLabel[], slug: string): FeatureLabel {
  return features.find((feature) => feature.slug === slug) ?? { slug, title: slug, unit: "units" }
}

type FeatureTable = Readonly<{
  feature: FeatureLabel
  unit: string
  table: ReturnType<typeof priceTableOf>
}>

/** The price list with fixed data, so a test renders it against a fixed clock. */
export function PriceList({
  data,
  features,
  now,
  readOnly = false,
  catalogMarkup,
  catalogActions,
}: {
  data: RateCardData
  features: readonly FeatureLabel[]
  now: number
  readOnly?: boolean
  catalogMarkup?: (featureSlug: string) => ReactNode
  /** What the catalog line offers after the rule, such as adding a model of the project's own. */
  catalogActions?: (featureSlug: string) => ReactNode
}) {
  const { card, rows, live } = data
  const currency = cardCurrency(card.unit)
  const tables: FeatureTable[] = featureSlugsOf(rows).map((slug) => {
    const feature = labelFor(features, slug)
    const unit = singularUnit(feature.unit)
    return { feature, unit, table: priceTableOf(slug, rows, now, currency, unit) }
  })
  // A feature with one price per cycle reads best beside the others; a sheet of model rates is
  // its own section.
  const single = tables.filter(({ table }) => table.dimensions.length === 0)
  // A plan version's feature without a row is unpriced; it blocks publishing, so it shows here too.
  const priced = new Set(tables.map(({ feature }) => feature.slug))
  // Only a plan version knows how a feature is charged; a shared card alone does not.
  const showCharge = features.some((feature) => feature.charge !== undefined)
  const unpriced = features.filter(
    (feature) => feature.charge !== undefined && !priced.has(feature.slug)
  )
  const sheets = tables.filter(({ table }) => table.dimensions.length > 0)
  const history = tables.filter(({ table }) => table.ended.length > 0)
  const pastCount = history.reduce((sum, { table }) => sum + table.ended.length, 0)
  const endAction = (line: MatrixLine) =>
    !readOnly && line.row && line.row.effectiveTo === null ? (
      <CloseRowDialog cardId={card.id} row={line.row} live={live} />
    ) : null

  return (
    <div className="flex flex-col gap-8">
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
            <Badge
              variant={live ? "success" : "secondary"}
              className="shrink-0 px-1.5 py-0 text-[10px]"
            >
              {live ? "live" : "draft"}
            </Badge>
            <span>{describeCardState(live)}</span>
          </div>
          <PublishRowsDialog card={card} rows={rows} live={live} features={features}>
            <Button size="sm" variant="outline" className="gap-1.5">
              <Plus className="size-3.5" />
              Add a price
            </Button>
          </PublishRowsDialog>
        </div>
      )}

      {tables.length === 0 ? (
        <EmptyPlaceholder className="min-h-[240px]">
          <EmptyPlaceholder.Icon>
            <Rows3 className="h-8 w-8" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No prices yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Set a price per feature in the plan editor, or add one here. A feature without a price
            cannot publish.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      ) : null}

      {(single.length > 0 || unpriced.length > 0) && (
        <section className="flex flex-col gap-2">
          <Typography variant="h5" affects="removePaddingMargin">
            Features
          </Typography>
          <div className="rounded-md border">
            <Table className="text-xs">
              <TableHeader className="bg-background-bgSubtle">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-9 px-3 text-left font-medium">Feature</TableHead>
                  {showCharge && (
                    <TableHead className="h-9 px-3 text-left font-medium">
                      How it's charged
                    </TableHead>
                  )}
                  <TableHead className="h-9 px-3 text-left font-medium">Price</TableHead>
                  {live && (
                    <TableHead className="h-9 px-3 text-left font-medium">In effect</TableHead>
                  )}
                  <TableHead className="h-9 w-20 px-3">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {single.flatMap(({ feature, unit, table }) => {
                  const matrix = matrixOf(table)
                  return matrix.lines.map((line, index) => (
                    <TableRow
                      key={`${feature.slug}:${line.key}`}
                      className="group border-b last:border-b-0"
                    >
                      <TableCell className="px-3 py-2 align-top">
                        {index === 0 && (
                          <span className="font-medium text-sm">{feature.title}</span>
                        )}
                      </TableCell>
                      {showCharge && (
                        <TableCell className="px-3 py-2 align-top text-muted-foreground">
                          {index === 0 ? (feature.charge ?? null) : null}
                        </TableCell>
                      )}
                      <TableCell className="px-3 py-2 align-top">
                        <span className="inline-flex items-center gap-2">
                          <LinePrice line={line} matrix={matrix} currency={currency} unit={unit} />
                          <StatusBadge status={line.status} />
                          {!live && line.status !== "current" && (
                            <span className="text-muted-foreground">{line.applies}</span>
                          )}
                        </span>
                      </TableCell>
                      {live && (
                        <TableCell className="px-3 py-2 align-top text-muted-foreground">
                          {visibleApplies(line, true)}
                        </TableCell>
                      )}
                      <TableCell className="px-3 py-1.5 text-right align-top">
                        <span className="inline-flex opacity-0 transition-opacity duration-150 ease-out focus-within:opacity-100 group-hover:opacity-100">
                          {endAction(line)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                })}
                {unpriced.map((feature) => (
                  <TableRow key={feature.slug} className="border-b last:border-b-0">
                    <TableCell className="px-3 py-2 align-top">
                      <span className="font-medium text-sm">{feature.title}</span>
                    </TableCell>
                    <TableCell className="px-3 py-2 align-top text-muted-foreground">
                      {feature.charge}
                    </TableCell>
                    <TableCell className="px-3 py-2 align-top text-warning">
                      Not priced yet. Publishing waits for a price.
                    </TableCell>
                    {live && <TableCell />}
                    <TableCell />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {sheets.map(({ feature, unit, table }) => {
        const policy = catalogPolicyFor(card.marginPolicy, feature.slug)
        return (
          <section key={feature.slug} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <Typography variant="h5" affects="removePaddingMargin">
                  {feature.title}
                </Typography>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {table.lines.length} prices by {table.dimensions.join(", ")}
                </span>
              </div>
            </div>
            {policy && (
              <p className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-muted-foreground text-xs">
                <RefreshCw className="mr-0.5 size-3.5 shrink-0" aria-hidden="true" />
                Priced from models.dev {MODEL_CATALOG_VERSION}: each model's provider cost plus
                {catalogMarkup && !readOnly ? (
                  catalogMarkup(feature.slug)
                ) : (
                  <span className="font-medium text-foreground">
                    {markupPercent(policy.markup)}%
                  </span>
                )}
                , rounded up to {currency === "USD" ? "$" : `${currency} `}
                {formatAmount(policy.roundTo)}.{!readOnly && catalogActions?.(feature.slug)}
              </p>
            )}
            {policy && !readOnly && (
              <CatalogUpdates card={card} policy={policy} live={live} unit={unit} />
            )}
            <CollapsibleSheet count={table.lines.length} dimension={table.dimensions.join(", ")}>
              <PriceMatrix
                matrix={matrixOf(table)}
                currency={currency}
                unit={unit}
                limit={SHOWN_LINES}
                datesCurrent={live}
                action={endAction}
              />
            </CollapsibleSheet>
          </section>
        )
      })}

      {pastCount > 0 && (
        <PriceHistory count={pastCount}>
          <div className="flex flex-col gap-4">
            {history.map(({ feature, unit, table }) => (
              <div key={feature.slug} className="flex flex-col gap-1.5">
                <span className="font-medium text-xs">{feature.title}</span>
                <PriceMatrix
                  matrix={matrixOf(table, "ended")}
                  currency={currency}
                  unit={unit}
                  limit={SHOWN_LINES}
                  className="opacity-80"
                />
              </div>
            ))}
          </div>
        </PriceHistory>
      )}
    </div>
  )
}

/** A sheet of many prices, closed until asked for: the rule above it says what they follow. */
function CollapsibleSheet({
  count,
  dimension,
  children,
}: {
  count: number
  dimension: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <CollapsibleSection
      label={open ? `Hide ${dimension} prices` : `Show ${count} ${dimension} prices`}
      open={open}
      onOpenChange={setOpen}
    >
      {children}
    </CollapsibleSection>
  )
}

function PriceHistory({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <CollapsibleSection
      label="Price history"
      summary={`${count} past ${count === 1 ? "price" : "prices"}`}
      open={open}
      onOpenChange={setOpen}
    >
      {children}
    </CollapsibleSection>
  )
}
