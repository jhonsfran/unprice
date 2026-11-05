"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RATE_CHANGE_NOTICE_MS, type RateCard } from "@unprice/db/validators"
import { describeRatePrice } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Skeleton } from "@unprice/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { Typography } from "@unprice/ui/typography"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { cardCurrency, earliestStart, formatMatch, toDateTimeLocal } from "./rate-card-format"

type Draft = RouterOutputs["rateCards"]["previewCostPlus"]["draft"]

/**
 * The card's cost-plus revision at now: each model's proposed price against its current row. A
 * publish recomputes the revision and refuses one that changed since this preview.
 */
export function CostPlusDraft({ card }: { card: RateCard }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    toDateTimeLocal(earliestStart(true, Date.now(), RATE_CHANGE_NOTICE_MS))
  )
  const { data, isLoading, refetch, isFetching } = useQuery(
    trpc.rateCards.previewCostPlus.queryOptions({ cardId: card.id })
  )
  const { mutate, isPending } = useMutation(
    trpc.rateCards.publishCostPlus.mutationOptions({
      onSuccess: ({ inserted, closed }) => {
        toast.success(`Published ${inserted.length} rows, closed ${closed.length}`)
        void queryClient.invalidateQueries(trpc.rateCards.get.queryFilter({ id: card.id }))
        void queryClient.invalidateQueries(trpc.rateCards.previewCostPlus.pathFilter())
      },
    })
  )

  if (isLoading) return <Skeleton className="h-32 w-full" />
  if (!data) return null

  const writes = data.draft.changes.filter(
    (change) => change.type === "added" || change.type === "changed"
  )

  return (
    <section className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Typography variant="h5" affects="removePaddingMargin">
          Cost-plus draft
        </Typography>
        <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          Refresh preview
        </Button>
      </div>
      <CostPlusChanges draft={data.draft} currency={cardCurrency(card.unit)} />
      {writes.length > 0 && data.draftHash && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            mutate({
              cardId: card.id,
              draftHash: data.draftHash ?? "",
              effectiveFrom: new Date(effectiveFrom).getTime(),
            })
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cost-plus-from">Starts at</Label>
            <Input
              id="cost-plus-from"
              type="datetime-local"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={isPending}>
            Publish {writes.length} {writes.length === 1 ? "change" : "changes"}
          </Button>
        </form>
      )}
    </section>
  )
}

const CHANGE_BADGE = {
  added: "success",
  changed: "warning",
  unchanged: "secondary",
  retiring: "secondary",
} as const

/** The draft's changes, controlled so a test can render them. */
export function CostPlusChanges({ draft, currency }: { draft: Draft; currency: string }) {
  if (draft.changes.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        The cost catalog has no model for this card's feature yet.
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Match</TableHead>
          <TableHead>Change</TableHead>
          <TableHead>Current</TableHead>
          <TableHead>Proposed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {draft.changes.map((change) => (
          <TableRow key={formatMatch(change.proposed.match)}>
            <TableCell className="font-mono text-xs">
              {formatMatch(change.proposed.match)}
            </TableCell>
            <TableCell>
              <Badge variant={CHANGE_BADGE[change.type]}>{change.type}</Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">
              {"current" in change ? describeRatePrice(change.current.price, currency) : "—"}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {describeRatePrice(change.proposed.price, currency)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
