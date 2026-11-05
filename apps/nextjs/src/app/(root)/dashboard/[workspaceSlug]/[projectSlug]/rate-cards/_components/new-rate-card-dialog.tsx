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

/**
 * Creates a shared money card with hand-written rows. A plan version gets its own card from its
 * feature editor; catalog (cost-plus) pricing is set there too, per feature.
 */
export function NewRateCardDialog({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const router = useRouter()
  const params = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [currency, setCurrency] = useState<Currency>("USD")
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
            A shared card holds prices several plan versions can use in one currency. A version you
            price from its editor gets its own card automatically.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setProblem(null)
            mutate({ name, unit: `money:${currency}`, marginPolicy: { type: "manual" } })
          }}
        >
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
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
            <div className="flex flex-col gap-1.5">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={(value) => setCurrency(value as Currency)}>
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
