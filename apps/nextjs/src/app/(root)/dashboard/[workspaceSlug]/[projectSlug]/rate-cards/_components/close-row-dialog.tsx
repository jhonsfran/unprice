"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RATE_CHANGE_NOTICE_MS, type RateRow } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import { useState } from "react"
import { earliestStart, formatMatch } from "~/components/pricing/rate-card-format"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { ScheduleField } from "./schedule-field"

const NOTICE_MINUTES = RATE_CHANGE_NOTICE_MS / 60_000

/** Ends one open row; an end is a price change, so on a live card it takes the notice. */
export function CloseRowDialog({
  cardId,
  row,
  live,
}: {
  cardId: string
  row: RateRow
  /** A published version prices with the card, so a change takes the notice. */
  live: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [schedule, setSchedule] = useState(false)
  const [effectiveTo, setEffectiveTo] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const { mutate, isPending } = useMutation(
    trpc.rateCards.closeRows.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: () => {
        toast.success(`Closed the ${row.featureSlug} row`)
        setOpen(false)
        void queryClient.invalidateQueries(trpc.rateCards.get.queryFilter({ id: cardId }))
      },
      onError: (error) => setProblem(error.message),
    })
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setProblem(null)
        if (next) {
          setSchedule(false)
          setEffectiveTo(earliestStart(live, Date.now(), RATE_CHANGE_NOTICE_MS))
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          End…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            End this price? {row.featureSlug} · {formatMatch(row.match)}
          </DialogTitle>
          <DialogDescription>
            From that time the price no longer applies. Usage it would match is refused as not
            priced unless another price covers it.{" "}
            {live
              ? `A published version charges this price, so the end takes effect at least ${NOTICE_MINUTES} minutes after you confirm.`
              : "No published version charges this price yet, so it can end now."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setProblem(null)
            mutate({
              cardId,
              rowIds: [row.id],
              ...(schedule && effectiveTo !== null ? { effectiveTo } : {}),
            })
          }}
        >
          <ScheduleField
            id={`close-${row.id}`}
            label="Ends at"
            nowText="Ends now, or as soon as the card allows."
            schedule={schedule}
            onScheduleChange={setSchedule}
            value={effectiveTo}
            onChange={setEffectiveTo}
          />
          {problem && <p className="text-destructive text-sm">{problem}</p>}
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              disabled={isPending || (schedule && effectiveTo === null)}
            >
              End price
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
