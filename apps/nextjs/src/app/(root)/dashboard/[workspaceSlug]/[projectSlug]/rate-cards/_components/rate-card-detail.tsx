"use client"

import { useQuery } from "@tanstack/react-query"
import type { RateRow } from "@unprice/db/validators"
import { describeRatePrice } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { Typography } from "@unprice/ui/typography"
import { Rows3 } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useTRPC } from "~/trpc/client"
import { CloseRowDialog } from "./close-row-dialog"
import { CostPlusDraft } from "./cost-plus-draft"
import { PublishRowsDialog } from "./publish-rows-dialog"
import {
  type FeatureRows,
  cardCurrency,
  formatInterval,
  formatMatch,
  groupRowsByFeature,
} from "./rate-card-format"

type RateCardData = RouterOutputs["rateCards"]["get"]

/** A card's rows grouped by feature, and the actions that change them. */
export function RateCardDetail({ cardId }: { cardId: string }) {
  const trpc = useTRPC()
  // The rows are grouped as of when they were read, so a refetch after a write regroups them.
  const { data, isLoading, dataUpdatedAt } = useQuery(
    trpc.rateCards.get.queryOptions({ id: cardId })
  )

  if (isLoading || !data) return <EmptyPlaceholder isLoading className="min-h-[360px]" />

  return <RateCardRows data={data} now={dataUpdatedAt} />
}

/** The rows view, controlled so a test can render it with fixed rows and a fixed clock. */
export function RateCardRows({ data, now }: { data: RateCardData; now: number }) {
  const { card, rows } = data
  const groups = groupRowsByFeature(rows, now)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Typography variant="p" affects="removePaddingMargin" className="text-muted-foreground">
          {rows.length === 0
            ? "The card's first rows can start at once."
            : "Rows are immutable: a price change publishes a successor and closes the old row."}
        </Typography>
        <PublishRowsDialog card={card} rows={rows}>
          <Button size="sm">Publish rows</Button>
        </PublishRowsDialog>
      </div>

      {card.marginPolicy.type === "costPlus" && <CostPlusDraft card={card} />}

      {groups.length === 0 ? (
        <EmptyPlaceholder className="min-h-[240px]">
          <EmptyPlaceholder.Icon>
            <Rows3 className="h-8 w-8" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No rows yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Publish a row per feature. A feature without a row is not priced.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      ) : (
        groups.map((group) => (
          <FeatureRowsSection
            key={group.featureSlug}
            group={group}
            cardId={card.id}
            currency={cardCurrency(card.unit)}
            hasRows={rows.length > 0}
            now={now}
          />
        ))
      )}
    </div>
  )
}

function FeatureRowsSection({
  group,
  cardId,
  currency,
  hasRows,
  now,
}: {
  group: FeatureRows
  cardId: string
  currency: string
  hasRows: boolean
  now: number
}) {
  return (
    <section className="flex flex-col gap-2">
      <Typography variant="h5" affects="removePaddingMargin" className="font-mono">
        {group.featureSlug}
      </Typography>
      <div className="rounded-md border">
        <RowsTable rows={group.current} currency={currency} now={now}>
          {(row) =>
            row.effectiveTo === null ? (
              <CloseRowDialog cardId={cardId} row={row} hasRows={hasRows} />
            ) : null
          }
        </RowsTable>
      </div>
      {group.ended.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground text-xs">
            {group.ended.length} ended {group.ended.length === 1 ? "row" : "rows"}
          </summary>
          <div className="mt-2 rounded-md border opacity-80">
            <RowsTable rows={group.ended} currency={currency} now={now} />
          </div>
        </details>
      )}
    </section>
  )
}

function RowsTable({
  rows,
  currency,
  now,
  children,
}: {
  rows: readonly RateRow[]
  currency: string
  now: number
  children?: (row: RateRow) => React.ReactNode
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Match</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Applies</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-mono text-xs">{formatMatch(row.match)}</TableCell>
            <TableCell className="font-mono text-xs">
              {describeRatePrice(row.price, currency)}
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">
              {formatInterval(row, now)}
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">{row.source}</TableCell>
            <TableCell className="text-right">{children?.(row)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
