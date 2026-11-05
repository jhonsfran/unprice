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
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { earliestStart, formatMatch, toDateTimeLocal } from "./rate-card-format"
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
  const [effectiveTo, setEffectiveTo] = useState("")
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
          setEffectiveTo(toDateTimeLocal(earliestStart(live, Date.now(), RATE_CHANGE_NOTICE_MS)))
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Close…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Close {row.featureSlug} · {formatMatch(row.match)}
          </DialogTitle>
          <DialogDescription>
            From this time the row prices nothing. Usage it would match is refused as not priced
            unless another row covers it.{" "}
            {live
              ? `A published version prices with this card, so an end takes effect at least ${NOTICE_MINUTES} minutes after you close it.`
              : "No published version prices with this card yet, so the row can end now."}
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
              ...(schedule ? { effectiveTo: new Date(effectiveTo).getTime() } : {}),
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
              disabled={isPending || (schedule && !effectiveTo)}
            >
              Close row
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
