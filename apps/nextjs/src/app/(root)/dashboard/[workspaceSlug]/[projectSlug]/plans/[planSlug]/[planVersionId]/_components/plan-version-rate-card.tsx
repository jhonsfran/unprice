"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type Currency, currencySchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Skeleton } from "@unprice/ui/skeleton"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

/**
 * The rate card a plan version prices with in each currency (ADR-0008 D2). A draft version can
 * assign or replace a card per currency; a published version keeps the cards it was published with.
 */
export function PlanVersionRateCard({
  planVersionId,
  currency: versionCurrency,
  isPublished,
}: {
  planVersionId: string
  currency: Currency
  isPublished: boolean
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const params = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const [currency, setCurrency] = useState<Currency>(versionCurrency)
  const [cardId, setCardId] = useState<string>("")

  const { data: assigned, isLoading } = useQuery(
    trpc.rateCards.forPlanVersion.queryOptions({ planVersionId })
  )
  const { data: listed } = useQuery({
    ...trpc.rateCards.list.queryOptions(),
    enabled: !isPublished,
  })
  const { mutate, isPending } = useMutation(
    trpc.rateCards.assignToPlanVersion.mutationOptions({
      onSuccess: ({ assignment }) => {
        toast.success(`Pricing ${assignment.currency} with the card`)
        setCardId("")
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
        void queryClient.invalidateQueries({ queryKey: trpc.planVersions.getById.queryKey() })
        router.refresh()
      },
    })
  )

  if (isLoading) return <Skeleton className="h-20 w-full" />

  const cards = assigned?.cards ?? []
  const candidates = (listed?.cards ?? []).filter((card) => card.unit === `money:${currency}`)

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border bg-card">
        {cards.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground text-xs">
            No rate card yet: recurring features bill nothing and usage is refused as not priced.
          </p>
        ) : (
          cards.map((entry, index) => (
            <div
              key={entry.currency}
              className={
                index < cards.length - 1
                  ? "flex items-center justify-between border-b px-3 py-2 text-xs"
                  : "flex items-center justify-between px-3 py-2 text-xs"
              }
            >
              <span className="font-mono text-foreground/70">{entry.currency}</span>
              <SuperLink
                href={`/${params?.workspaceSlug}/${params?.projectSlug}/rate-cards/${entry.card.id}`}
                className="truncate font-mono underline-offset-4 hover:underline"
              >
                {entry.card.name}
              </SuperLink>
            </div>
          ))
        )}
      </div>

      {!isPublished && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
            <Select value={currency} onValueChange={(value) => setCurrency(value as Currency)}>
              <SelectTrigger className="h-8 text-xs" aria-label="Currency">
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
            <Select value={cardId} onValueChange={setCardId}>
              <SelectTrigger className="h-8 text-xs" aria-label="Rate card">
                <SelectValue
                  placeholder={
                    candidates.length === 0 ? `No money:${currency} cards` : "Pick a card"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((card) => (
                  <SelectItem key={card.id} value={card.id}>
                    {card.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!cardId || isPending}
            onClick={() => mutate({ planVersionId, currency, cardId })}
          >
            Assign card
          </Button>
        </div>
      )}
    </div>
  )
}
