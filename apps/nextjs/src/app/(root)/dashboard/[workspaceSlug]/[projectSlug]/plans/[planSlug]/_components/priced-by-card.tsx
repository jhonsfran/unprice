"use client"

import { useQuery } from "@tanstack/react-query"
import { describeRatePrice } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Skeleton } from "@unprice/ui/skeleton"
import { CreditCard } from "lucide-react"
import { useParams } from "next/navigation"
import { SuperLink } from "~/components/super-link"
import { useTRPC } from "~/trpc/client"

type PlanVersionCard = RouterOutputs["rateCards"]["forPlanVersion"]["cards"][number]

/**
 * A plan feature's price, read from the card its plan version prices with (ADR-0008 D2). The
 * feature stores none: prices change on the card, never in this form.
 */
export function PricedByCard({
  planVersionId,
  featureSlug,
  currency,
  unit,
}: {
  planVersionId: string
  featureSlug: string
  currency: string
  unit: string
}) {
  const trpc = useTRPC()
  const { data, isLoading } = useQuery(
    trpc.rateCards.forPlanVersion.queryOptions({ planVersionId })
  )

  if (isLoading) return <Skeleton className="h-16 w-full" />

  const card = data?.cards.find((entry) => entry.currency === currency)
  return <PricedByCardView card={card} featureSlug={featureSlug} currency={currency} unit={unit} />
}

/** The note itself, controlled so a test can render each state. */
export function PricedByCardView({
  card,
  featureSlug,
  currency,
  unit,
}: {
  card: PlanVersionCard | undefined
  featureSlug: string
  currency: string
  unit: string
}) {
  const params = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const rows = card?.rows.filter((row) => row.featureSlug === featureSlug) ?? []

  return (
    <div className="space-y-2 rounded-md border bg-background-bgSubtle/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-sm">
          <CreditCard className="size-3.5 text-muted-foreground" />
          Priced by card
        </span>
        {card && (
          <SuperLink
            href={`/${params?.workspaceSlug}/${params?.projectSlug}/rate-cards/${card.card.id}`}
            className="text-muted-foreground text-xs underline-offset-4 hover:underline"
          >
            {card.card.name}
          </SuperLink>
        )}
      </div>
      {!card ? (
        <p className="text-muted-foreground text-xs">
          This version has no {currency} rate card. Assign one in the version settings.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          The card has no current row for this feature, so its usage is refused as not priced. Add
          one on the card.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">
                {Object.entries(row.match)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(", ") || "Default"}
              </span>
              <span className="font-mono">{describeRatePrice(row.price, currency, unit)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
