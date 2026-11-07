"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { COST_COMPONENT_NAMES, type Currency } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
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
import { HelpCircle } from "@unprice/ui/icons"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Plus } from "lucide-react"
import { useState } from "react"
import { InputWithAddons } from "~/components/input-addons"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import {
  catalogPolicyFor,
  markupPercent,
} from "../../../../rate-cards/_components/rate-card-format"

type Component = (typeof COST_COMPONENT_NAMES)[number]

const COMPONENT_LABEL: Record<Component, string> = {
  input: "Input",
  output: "Output",
  cache_read: "Cache read",
  cache_write: "Cache write",
}

const EMPTY: Record<Component, string> = { input: "", output: "", cache_read: "", cache_write: "" }

/** "1.2" at 20% as "1.44": what a cost becomes before the card's rounding. */
export function pricedAt(cost: string, percent: string): string | null {
  const value = Number(cost)
  const markup = Number(percent)
  if (cost.trim() === "" || !Number.isFinite(value) || value < 0 || !Number.isFinite(markup)) {
    return null
  }
  return String(Number((value * (1 + markup / 100)).toPrecision(6)))
}

/**
 * Adds a model to the project's own cost catalog: its id as events send it, and what it costs per
 * million tokens of each kind. It is then priced like every catalog model, cost plus the markup,
 * once the catalog change is applied. A model already added is edited by adding a newer cost.
 */
export function CustomModelDialog({
  planVersionId,
  currency,
  featureSlug,
}: {
  planVersionId: string
  currency: Currency
  featureSlug: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState("")
  const [provider, setProvider] = useState("custom")
  const [costs, setCosts] = useState<Record<Component, string>>(EMPTY)
  const [problem, setProblem] = useState<string | null>(null)

  const { data: pricing } = useQuery(trpc.rateCards.forPlanVersion.queryOptions({ planVersionId }))
  const { data: custom } = useQuery({
    ...trpc.rateCards.listCustomModels.queryOptions(),
    enabled: open,
  })
  const card = pricing?.cards.find((entry) => entry.currency === currency)
  const policy = card ? catalogPolicyFor(card.card.marginPolicy, featureSlug) : null
  const percent = policy ? markupPercent(policy.markup) : "0"
  // Only the token kinds the feature's events carry can be priced; the others would sit unused.
  const components = COST_COMPONENT_NAMES.filter((component) =>
    policy ? component in policy.componentMap : true
  )
  const existing = custom?.costs ?? []
  const editing = existing.some((cost) => cost.model === model.trim())

  const { mutate, isPending } = useMutation(
    trpc.rateCards.addCustomModel.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ cost }) => {
        toast.success(`${cost.model} is in your catalog. Apply its price below the model line.`)
        setOpen(false)
        void queryClient.invalidateQueries(trpc.rateCards.listCustomModels.pathFilter())
        void queryClient.invalidateQueries(trpc.rateCards.previewCostPlus.pathFilter())
      },
      onError: (error) => setProblem(error.message),
    })
  )

  const reset = () => {
    setModel("")
    setProvider("custom")
    setCosts(EMPTY)
    setProblem(null)
  }

  const submit = () => {
    setProblem(null)
    const filled = Object.fromEntries(
      components.flatMap((component) =>
        costs[component].trim() ? [[component, costs[component].trim()]] : []
      )
    )
    if (!model.trim()) return setProblem("Name the model as your events send it.")
    if (Object.keys(filled).length === 0) return setProblem("Set at least one cost.")
    mutate({ provider: provider.trim() || "custom", model: model.trim(), components: filled })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="ml-1 h-6 gap-1 px-2 text-xs">
          <Plus className="size-3" />
          Add a model
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add a model to your catalog</DialogTitle>
          <DialogDescription>
            For a fine-tune, a self-hosted model, one models.dev does not list yet, or a cost you
            negotiated. It is priced like every other model: its cost plus your {percent}% markup.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {existing.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">
                Your models (pick one to change its cost)
              </span>
              <div className="flex flex-wrap gap-1.5">
                {existing.map((cost) => (
                  <Button
                    key={`${cost.provider}/${cost.model}`}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 font-mono text-xs"
                    onClick={() => {
                      setModel(cost.model)
                      setProvider(cost.provider)
                      setCosts({
                        ...EMPTY,
                        ...Object.fromEntries(
                          Object.entries(cost.components).map(([component, amount]) => [
                            component,
                            formatAmount(amount),
                          ])
                        ),
                      })
                    }}
                  >
                    {cost.model}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                <Label htmlFor="custom-model">Model</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[260px]">
                    Exactly the value your events send in their model property. A model models.dev
                    also lists is then priced from this cost instead, for your project only.
                  </TooltipContent>
                </Tooltip>
              </div>
              <Input
                id="custom-model"
                className="font-mono text-xs"
                placeholder="acme-llama-70b"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="custom-provider">Provider</Label>
              <Input
                id="custom-provider"
                className="text-xs"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-medium text-sm">What it costs you, per 1M tokens</span>
            <div className="grid grid-cols-2 gap-3">
              {components.map((component) => {
                const price = pricedAt(costs[component], percent)
                return (
                  <div key={component} className="flex flex-col gap-1">
                    <Label htmlFor={`custom-${component}`} className="text-xs">
                      {COMPONENT_LABEL[component]}
                    </Label>
                    <InputWithAddons
                      id={`custom-${component}`}
                      inputMode="decimal"
                      className="font-mono text-xs tabular-nums"
                      leading="$"
                      placeholder="0.00"
                      value={costs[component]}
                      onChange={(event) =>
                        setCosts((current) => ({ ...current, [component]: event.target.value }))
                      }
                    />
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {price ? `Customers pay about $${price}` : "Leave empty if not charged"}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {problem && <p className="text-destructive text-sm">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {editing ? "Save new cost" : "Add model"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
