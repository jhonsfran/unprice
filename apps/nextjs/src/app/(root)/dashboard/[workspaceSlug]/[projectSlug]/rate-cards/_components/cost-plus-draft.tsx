"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RATE_CHANGE_NOTICE_MS, type RateCard } from "@unprice/db/validators"
import { describeRatePrice } from "@unprice/services/pricing"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Skeleton } from "@unprice/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { Typography } from "@unprice/ui/typography"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import {
  type CostPlusDraftWire,
  cardCurrency,
  countWrites,
  earliestStart,
  formatMatch,
  toDateTimeLocal,
} from "./rate-card-format"
import { ScheduleField } from "./schedule-field"

/**
 * The card's cost-plus revision at now: each model's proposed price against its current row. A
 * publish recomputes the revision and refuses one that changed since this preview.
 */
export function CostPlusDraft({ card, live }: { card: RateCard; live: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [schedule, setSchedule] = useState(false)
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    toDateTimeLocal(earliestStart(live, Date.now(), RATE_CHANGE_NOTICE_MS))
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

  const writes = countWrites(data.draft)

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
      {writes > 0 && data.draftHash && (
        <form
          className="flex flex-col gap-3"
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
            id="cost-plus-from"
            label="Starts at"
            schedule={schedule}
            onScheduleChange={setSchedule}
            value={effectiveFrom}
            onChange={setEffectiveFrom}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={isPending || (schedule && !effectiveFrom)}>
              Publish {writes} {writes === 1 ? "change" : "changes"}
            </Button>
          </div>
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
export function CostPlusChanges({
  draft,
  currency,
}: {
  draft: CostPlusDraftWire
  currency: string
}) {
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
