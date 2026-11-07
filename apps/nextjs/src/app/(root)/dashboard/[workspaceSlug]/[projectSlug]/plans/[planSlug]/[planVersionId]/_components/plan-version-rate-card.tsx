"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Currency } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Skeleton } from "@unprice/ui/skeleton"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { RateCardDetail } from "../../../../rate-cards/_components/rate-card-detail"
import { cardLabel } from "../../../_components/plan-prices"
import { CollapsibleSection } from "../../_components/section-label"

/**
 * Where a plan version's prices come from, for the rail: nothing to say while the version prices
 * with its own card (the Prices tab shows it), the card's name when it shares one (ADR-0008 D2).
 */
export function PlanVersionRateCard({ planVersionId }: { planVersionId: string }) {
  const trpc = useTRPC()
  const params = useParams<{ workspaceSlug: string; projectSlug: string; planSlug: string }>()
  const { data: assigned, isLoading } = useQuery(
    trpc.rateCards.forPlanVersion.queryOptions({ planVersionId })
  )

  if (isLoading) return <Skeleton className="h-10 w-full" />

  const shared = (assigned?.cards ?? []).filter(
    (entry) =>
      !cardLabel(
        entry.card.name,
        params?.planSlug
          ? { planSlug: params.planSlug, planVersionId, currency: entry.currency }
          : null
      ).isOwn
  )
  if (shared.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-card px-3 py-2 text-xs">
      {shared.map((entry) => (
        <p key={entry.currency} className="text-muted-foreground">
          {entry.currency} prices come from the shared card{" "}
          <SuperLink
            href={`/${params?.workspaceSlug}/${params?.projectSlug}/rate-cards/${entry.card.id}`}
            className="font-mono text-foreground underline-offset-4 hover:underline"
          >
            {entry.card.name}
          </SuperLink>
          , used by other versions too.
        </p>
      ))}
    </div>
  )
}

/**
 * Prices a draft with a rate card other versions use too, instead of the prices set in its own
 * editor. Rare, so it sits collapsed at the end of the Prices tab.
 */
export function SharedCardPicker({
  planVersionId,
  currency,
}: {
  planVersionId: string
  currency: Currency
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  // The pick is kept with the currency it was made for, so a currency change drops it.
  const [picked, setPicked] = useState<{ currency: Currency; cardId: string } | null>(null)
  const [isOpen, setIsOpen] = useState(false)

  const { data: listed } = useQuery({ ...trpc.rateCards.list.queryOptions(), enabled: isOpen })
  const { data: plans } = useQuery({
    // Drafts too: their prices can be shared as well, and the default lists published only.
    ...trpc.plans.listByActiveProject.queryOptions({ published: false }),
    enabled: isOpen,
  })
  // A version's own card is named "<plan> <version id> <currency>"; name it as people know it.
  const versions = new Map(
    (plans?.plans ?? []).flatMap((plan) =>
      plan.versions.map((version) => [version.id, `${plan.title} · v${version.version}`] as const)
    )
  )
  const labelOf = (name: string) => {
    const versionId = name.split(" ")[1]
    const version = versionId ? versions.get(versionId) : undefined
    return version ? `${version} prices` : name
  }
  const { mutate, isPending } = useMutation(
    trpc.rateCards.assignToPlanVersion.mutationOptions({
      onSuccess: ({ assignment }) => {
        toast.success(`Pricing ${assignment.currency} with the shared card`)
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

  // Its own card is what it prices with now, so it is not a card to switch to.
  const candidates = (listed?.cards ?? [])
    .filter((card) => card.unit === `money:${currency}` && !card.name.includes(planVersionId))
    .map((card) => ({ ...card, label: labelOf(card.name) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const pickedCard = candidates.find((card) => card.id === picked?.cardId)
  const cardId =
    picked?.currency === currency && candidates.some((card) => card.id === picked.cardId)
      ? picked.cardId
      : ""

  return (
    <CollapsibleSection
      label="Advanced: share prices with other versions"
      summary="optional"
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-xs">
          Charge this version from another version's prices instead of its own. Both then read one
          price list, so a change to it reaches both. The {currency} prices above stop applying.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={cardId} onValueChange={(value) => setPicked({ currency, cardId: value })}>
            <SelectTrigger className="h-8 w-64 text-xs" aria-label="Prices to use">
              <SelectValue
                placeholder={
                  candidates.length === 0
                    ? `No other ${currency} prices yet`
                    : "Pick whose prices to use"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((card) => (
                <SelectItem key={card.id} value={card.id}>
                  {card.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!cardId || isPending}
            onClick={() => mutate({ planVersionId, currency, cardId })}
          >
            Use these prices
          </Button>
        </div>
        {pickedCard && cardId && (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <p className="font-medium text-xs">Preview: {pickedCard.label}</p>
            <RateCardDetail cardId={cardId} readOnly />
          </div>
        )}
      </div>
    </CollapsibleSection>
  )
}
