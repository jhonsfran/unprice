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
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { earliestStart, formatMatch, toDateTimeLocal } from "./rate-card-format"

const NOTICE_MINUTES = RATE_CHANGE_NOTICE_MS / 60_000

/** Ends one open row; an end is a price change, so it takes the card's notice. */
export function CloseRowDialog({
  cardId,
  row,
  hasRows,
}: {
  cardId: string
  row: RateRow
  hasRows: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
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
          setEffectiveTo(toDateTimeLocal(earliestStart(hasRows, Date.now(), RATE_CHANGE_NOTICE_MS)))
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
            unless another row covers it. An end takes effect at least {NOTICE_MINUTES} minutes
            after you close it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setProblem(null)
            mutate({ cardId, rowIds: [row.id], effectiveTo: new Date(effectiveTo).getTime() })
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`close-${row.id}`}>Ends at</Label>
            <Input
              id={`close-${row.id}`}
              type="datetime-local"
              value={effectiveTo}
              onChange={(event) => setEffectiveTo(event.target.value)}
              required
            />
          </div>
          {problem && <p className="text-destructive text-sm">{problem}</p>}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={isPending || !effectiveTo}>
              Close row
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
