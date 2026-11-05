"use client"

import { useMutation } from "@tanstack/react-query"
import { type Currency, currencySchema } from "@unprice/db/validators"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { useParams, useRouter } from "next/navigation"
import { type ReactNode, useState } from "react"
import { useTRPC } from "~/trpc/client"
import { parseMatch } from "./rate-card-format"

type Policy = "manual" | "costPlus"

/**
 * Creates a money card. A manual card takes hand-written rows; a cost-plus card prices one
 * feature's models from the cost catalog (USD only), published from its draft.
 */
export function NewRateCardDialog({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const router = useRouter()
  const params = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [currency, setCurrency] = useState<Currency>("USD")
  const [policy, setPolicy] = useState<Policy>("manual")
  const [costPlus, setCostPlus] = useState({
    featureSlug: "",
    dimension: "model",
    markup: "0.3",
    roundTo: "0.000001",
    componentMap: "input=input_tokens, output=output_tokens",
  })
  const [problem, setProblem] = useState<string | null>(null)

  const { mutate, isPending } = useMutation(
    trpc.rateCards.create.mutationOptions({
      meta: { suppressGlobalError: true },
      onSuccess: ({ card }) => {
        setOpen(false)
        router.push(`/${params.workspaceSlug}/${params.projectSlug}/rate-cards/${card.id}`)
      },
      onError: (error) => setProblem(error.message),
    })
  )

  const submit = () => {
    setProblem(null)
    if (policy === "manual") {
      mutate({ name, unit: `money:${currency}`, marginPolicy: { type: "manual" } })
      return
    }
    const componentMap = parseMatch(costPlus.componentMap)
    if (!componentMap) {
      setProblem("Map each cost component to an event property: input=input_tokens")
      return
    }
    mutate({
      name,
      unit: "money:USD",
      marginPolicy: {
        type: "costPlus",
        featureSlug: costPlus.featureSlug,
        dimension: costPlus.dimension,
        markup: costPlus.markup,
        roundTo: costPlus.roundTo,
        componentMap,
      },
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setProblem(null)
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New rate card</DialogTitle>
          <DialogDescription>
            A card holds the prices a plan version charges in one currency.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rate-card-name">Name</Label>
            <Input
              id="rate-card-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Pro USD"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Margin policy</Label>
              <Select value={policy} onValueChange={(value) => setPolicy(value as Policy)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="costPlus">Cost-plus</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Currency</Label>
              <Select
                value={policy === "costPlus" ? "USD" : currency}
                onValueChange={(value) => setCurrency(value as Currency)}
                disabled={policy === "costPlus"}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencySchema.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {policy === "costPlus" && (
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ["featureSlug", "Feature", "tokens"],
                  ["dimension", "Model dimension", "model"],
                  ["markup", "Markup (0.3 = 30%)", "0.3"],
                  ["roundTo", "Round up to", "0.000001"],
                ] as const
              ).map(([key, label, placeholder]) => (
                <div key={key} className="flex flex-col gap-1.5">
                  <Label htmlFor={`cost-plus-${key}`}>{label}</Label>
                  <Input
                    id={`cost-plus-${key}`}
                    value={costPlus[key]}
                    placeholder={placeholder}
                    onChange={(event) =>
                      setCostPlus((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </div>
              ))}
              <div className="col-span-2 flex flex-col gap-1.5">
                <Label htmlFor="cost-plus-components">Cost component to event property</Label>
                <Input
                  id="cost-plus-components"
                  value={costPlus.componentMap}
                  onChange={(event) =>
                    setCostPlus((current) => ({ ...current, componentMap: event.target.value }))
                  }
                />
              </div>
            </div>
          )}
          {problem && <p className="text-destructive text-sm">{problem}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending || name.trim().length === 0}>
              Create card
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
