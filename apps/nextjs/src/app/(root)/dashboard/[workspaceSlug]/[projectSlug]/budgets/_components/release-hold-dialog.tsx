"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { budgetOperatorReasonSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Checkbox } from "@unprice/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import { Label } from "@unprice/ui/label"
import { Textarea } from "@unprice/ui/text-area"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { formatBudgetAmount, formatUnit } from "./budget-format"

const REASON_MAX = 500

export type ReleasableHold = { id: string; amount: string; idempotencyKey: string }

/** The trigger and dialog that release one open hold for an OWNER or ADMIN. */
export function ReleaseHoldDialog({
  budgetId,
  hold,
  unit,
}: {
  budgetId: string
  hold: ReleasableHold
  unit: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [attested, setAttested] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.budgets.inspect.pathFilter()),
      queryClient.invalidateQueries(trpc.budgets.audit.queryFilter({ id: budgetId })),
    ])
  const { mutate, isPending } = useMutation(
    trpc.budgets.releaseHold.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: () => {
        toast.success(
          `Released ${hold.id} (${formatBudgetAmount(hold.amount, unit)} ${formatUnit(unit)})`
        )
        setOpen(false)
        void refresh()
      },
      onError: (error) => {
        setProblem(error.message)
        void refresh()
      },
    })
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setProblem(null)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Release…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release {hold.id}</DialogTitle>
          <DialogDescription>
            Returns the whole hold to the budget. Only release work that never ran.
          </DialogDescription>
        </DialogHeader>
        <ReleaseHoldForm
          hold={hold}
          unit={unit}
          reason={reason}
          attested={attested}
          problem={problem}
          pending={isPending}
          onReasonChange={setReason}
          onAttestedChange={setAttested}
          onSubmit={() => {
            setProblem(null)
            mutate({ id: budgetId, holdId: hold.id, reason: reason.trim(), confirm: true })
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

export function canReleaseWith(reason: string, attested: boolean): boolean {
  return attested && budgetOperatorReasonSchema.safeParse(reason).success
}

/** The dialog's body, controlled by its parent so a test can render each state. */
export function ReleaseHoldForm({
  hold,
  unit,
  reason,
  attested,
  problem,
  pending,
  onReasonChange,
  onAttestedChange,
  onSubmit,
}: {
  hold: ReleasableHold
  unit: string
  reason: string
  attested: boolean
  problem: string | null
  pending: boolean
  onReasonChange: (reason: string) => void
  onAttestedChange: (attested: boolean) => void
  onSubmit: () => void
}) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canReleaseWith(reason, attested)) onSubmit()
      }}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Hold</dt>
        <dd className="font-mono">{hold.id}</dd>
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="font-mono tabular-nums">
          {formatBudgetAmount(hold.amount, unit)} {formatUnit(unit)}
        </dd>
        <dt className="text-muted-foreground">Idempotency key</dt>
        <dd className="truncate font-mono" title={hold.idempotencyKey}>
          {hold.idempotencyKey}
        </dd>
      </dl>

      <div className="flex flex-col gap-2">
        <Label htmlFor="release-reason">Reason</Label>
        <Textarea
          id="release-reason"
          value={reason}
          maxLength={REASON_MAX}
          placeholder="The worker crashed before calling the model."
          onChange={(event) => onReasonChange(event.target.value)}
        />
        <span className="self-end text-muted-foreground text-xs tabular-nums">
          {reason.trim().length}/{REASON_MAX} · at least 10
        </span>
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id="release-attest"
          checked={attested}
          onCheckedChange={(checked) => onAttestedChange(checked === true)}
        />
        <Label htmlFor="release-attest" className="font-normal text-sm leading-snug">
          This work stopped and used nothing. If it used anything, ask its owner to settle the
          actual amount instead.
        </Label>
      </div>

      {problem && (
        <p role="alert" className="text-danger-text text-sm">
          {problem}
        </p>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending || !canReleaseWith(reason, attested)}>
          {pending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Release
        </Button>
      </DialogFooter>
    </form>
  )
}
