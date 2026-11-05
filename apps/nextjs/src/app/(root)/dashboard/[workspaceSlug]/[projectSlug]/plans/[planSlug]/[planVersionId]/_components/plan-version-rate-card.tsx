"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Currency } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { cardLabel } from "../../../_components/plan-prices"
import { CollapsibleSection } from "../../_components/section-label"

/**
 * The rate card a plan version prices with (ADR-0008 D2). Prices are set per feature in the
 * editor and land on the version's own card; a draft can instead share a card with other
 * versions, and a published version keeps the cards it was published with.
 */
export function PlanVersionRateCard({
  planVersionId,
  currency,
  isPublished,
}: {
  planVersionId: string
  currency: Currency
  isPublished: boolean
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const params = useParams<{ workspaceSlug: string; projectSlug: string; planSlug: string }>()
  // The pick is kept with the currency it was made for, so a currency change drops it.
  const [picked, setPicked] = useState<{ currency: Currency; cardId: string } | null>(null)
  const [isShareOpen, setIsShareOpen] = useState(false)

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
        setPicked(null)
        void queryClient.invalidateQueries(trpc.rateCards.forPlanVersion.pathFilter())
        void queryClient.invalidateQueries({ queryKey: trpc.planVersions.getById.queryKey() })
        router.refresh()
      },
      onError: (error) => {
        toast.error(error.message)
      },
    })
  )

  if (isLoading) return <Skeleton className="h-20 w-full" />

  const cards = assigned?.cards ?? []
  const candidates = (listed?.cards ?? []).filter((card) => card.unit === `money:${currency}`)
  const cardId =
    picked?.currency === currency && candidates.some((card) => card.id === picked.cardId)
      ? picked.cardId
      : ""

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border bg-card">
        {cards.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground text-xs">
            No rate card yet. Prices are set per feature in the editor, and the first saved price
            creates this version's card.
          </p>
        ) : (
          cards.map((entry, index) => {
            const label = cardLabel(
              entry.card.name,
              params?.planSlug
                ? { planSlug: params.planSlug, planVersionId, currency: entry.currency }
                : null
            )
            return (
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
                  className={cn(
                    "truncate underline-offset-4 hover:underline",
                    !label.isOwn && "font-mono"
                  )}
                >
                  {label.text}
                </SuperLink>
              </div>
            )
          })
        )}
      </div>
      {cards.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Prices are set per feature in the editor and land on this card.
        </p>
      )}

      {!isPublished && (
        <CollapsibleSection
          label="Use a shared card"
          summary="optional"
          open={isShareOpen}
          onOpenChange={setIsShareOpen}
        >
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs">
              Price this version with a card other versions use too. Its rows replace the prices set
              in the editor.
            </p>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="flex h-8 items-center rounded-md border px-3 font-mono text-xs">
                {currency}
              </span>
              <Select
                value={cardId}
                onValueChange={(value) => setPicked({ currency, cardId: value })}
              >
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
        </CollapsibleSection>
      )}
    </div>
  )
}
