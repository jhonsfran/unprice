"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RATE_CHANGE_NOTICE_MS, type RateCard, type RateRow } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Checkbox } from "@unprice/ui/checkbox"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Textarea } from "@unprice/ui/text-area"
import { type ReactNode, useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import {
  type PriceFields,
  type PriceKind,
  buildRatePrice,
  earliestStart,
  formatMatch,
  openRows,
  parseMatch,
  toDateTimeLocal,
} from "./rate-card-format"

const NOTICE_MINUTES = RATE_CHANGE_NOTICE_MS / 60_000

const PRICE_KINDS: { value: PriceKind; label: string }[] = [
  { value: "unit", label: "Per unit" },
  { value: "graduated", label: "Graduated tiers" },
  { value: "package", label: "Per package" },
  { value: "flat", label: "Flat (recurring)" },
]

const EMPTY_PRICE: PriceFields = {
  kind: "unit",
  amount: "",
  per: "1",
  property: "",
  tiers: "1000 0 0\n* 0.01 0",
}

/**
 * Publishes one row. A row with the same feature and match as an open row is its successor and
 * closes it where it starts; `closeRowIds` ends other open rows at the same time, so a regrouped
 * feature's new rows follow the old ones without a gap.
 */
export function PublishRowsDialog({
  card,
  rows,
  children,
}: {
  card: RateCard
  rows: readonly RateRow[]
  children: ReactNode
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [featureSlug, setFeatureSlug] = useState("")
  const [match, setMatch] = useState("")
  const [price, setPrice] = useState<PriceFields>(EMPTY_PRICE)
  const [effectiveFrom, setEffectiveFrom] = useState("")
  const [closeRowIds, setCloseRowIds] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const hasRows = rows.length > 0
  const closable = openRows(rows)

  const { data: features } = useQuery({
    ...trpc.features.listByActiveProject.queryOptions(),
    enabled: open,
  })
  const { mutate, isPending } = useMutation(
    trpc.rateCards.publishRows.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ inserted, closed, unchanged }) => {
        toast.success(
          inserted.length === 0
            ? `Nothing changed (${unchanged} unchanged)`
            : `Published ${inserted.length} row, closed ${closed.length}`
        )
        setOpen(false)
        void queryClient.invalidateQueries(trpc.rateCards.get.queryFilter({ id: card.id }))
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
      },
      onError: (error) => setProblem(error.message),
    })
  )

  const submit = () => {
    setProblem(null)
    const parsedMatch = parseMatch(match)
    if (!parsedMatch) {
      setProblem("Write the match as key=value pairs, separated by commas")
      return
    }
    const built = buildRatePrice(price)
    if (!built.ok) {
      setProblem(built.message)
      return
    }
    mutate({
      cardId: card.id,
      rows: [
        {
          featureSlug,
          match: parsedMatch,
          price: built.price,
          cost: null,
        },
      ],
      effectiveFrom: new Date(effectiveFrom).getTime(),
      ...(closeRowIds.length > 0 ? { closeRowIds } : {}),
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setProblem(null)
        if (next) {
          setEffectiveFrom(
            toDateTimeLocal(earliestStart(hasRows, Date.now(), RATE_CHANGE_NOTICE_MS))
          )
          setCloseRowIds([])
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Publish a row on {card.name}</DialogTitle>
          <DialogDescription>
            {hasRows
              ? `This card has rows, so the row starts at least ${NOTICE_MINUTES} minutes from now: budgets refresh their card every 5 minutes and never price with a stale one.`
              : "These are the card's first rows, so they can start at once."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Feature</Label>
              <Select value={featureSlug} onValueChange={setFeatureSlug}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a feature" />
                </SelectTrigger>
                <SelectContent>
                  {(features?.features ?? []).map((feature) => (
                    <SelectItem key={feature.id} value={feature.slug}>
                      {feature.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="publish-match">Match</Label>
              <Input
                id="publish-match"
                value={match}
                onChange={(event) => setMatch(event.target.value)}
                placeholder="empty for the default row, or model=gpt-4o"
              />
            </div>
          </div>

          <PriceFieldsInput value={price} onChange={setPrice} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="publish-from">Starts at</Label>
            <Input
              id="publish-from"
              type="datetime-local"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              required
            />
          </div>

          {closable.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-medium text-sm">
                Close where this row starts (a successor or a regroup)
              </legend>
              {closable.map((row) => (
                <div key={row.id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    id={`close-${row.id}`}
                    checked={closeRowIds.includes(row.id)}
                    onCheckedChange={(checked) =>
                      setCloseRowIds((current) =>
                        checked === true
                          ? [...current, row.id]
                          : current.filter((rowId) => rowId !== row.id)
                      )
                    }
                  />
                  <Label htmlFor={`close-${row.id}`} className="font-mono text-xs">
                    {row.featureSlug} · {formatMatch(row.match)}
                  </Label>
                </div>
              ))}
            </fieldset>
          )}

          {problem && <p className="text-destructive text-sm">{problem}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending || !featureSlug || !effectiveFrom}>
              Publish row
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PriceFieldsInput({
  value,
  onChange,
}: {
  value: PriceFields
  onChange: (next: PriceFields) => void
}) {
  const set = (patch: Partial<PriceFields>) => onChange({ ...value, ...patch })

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Price</Label>
          <Select value={value.kind} onValueChange={(kind) => set({ kind: kind as PriceKind })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRICE_KINDS.map((kind) => (
                <SelectItem key={kind.value} value={kind.value}>
                  {kind.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {value.kind !== "flat" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price-property">Counts event property</Label>
            <Input
              id="price-property"
              value={value.property}
              onChange={(event) => set({ property: event.target.value })}
              placeholder="empty for one per event"
            />
          </div>
        )}
      </div>
      {value.kind === "graduated" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="price-tiers">Tiers: "upTo rate flat" per line, last upTo "*"</Label>
          <Textarea
            id="price-tiers"
            className="font-mono text-xs"
            rows={4}
            value={value.tiers}
            onChange={(event) => set({ tiers: event.target.value })}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price-amount">{value.kind === "flat" ? "Amount" : "Rate"}</Label>
            <Input
              id="price-amount"
              inputMode="decimal"
              value={value.amount}
              onChange={(event) => set({ amount: event.target.value })}
              placeholder="0.02"
              required
            />
          </div>
          {value.kind !== "flat" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price-per">{value.kind === "package" ? "Package size" : "Per"}</Label>
              <Input
                id="price-per"
                inputMode="numeric"
                value={value.per}
                onChange={(event) => set({ per: event.target.value })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
