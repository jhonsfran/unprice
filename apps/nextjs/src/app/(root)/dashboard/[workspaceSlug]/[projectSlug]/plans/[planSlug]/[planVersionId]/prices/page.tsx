import { Typography } from "@unprice/ui/typography"
import { Rows3 } from "lucide-react"
import { notFound } from "next/navigation"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { HydrateClient, api, prefetch, trpc } from "~/trpc/server"
import { RateCardDetail } from "../../../../rate-cards/_components/rate-card-detail"
import { cardLabel } from "../../../_components/plan-prices"

export const dynamic = "force-dynamic"

/**
 * Every price this version charges, with its history (ADR-0008 D2): the rows of the card the
 * version prices with in its currency. Prices are set in the feature table; this page reads them
 * as a price sheet and takes the catalog's updates.
 */
export default async function PlanVersionPricesPage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    planSlug: string
    planVersionId: string
  }>
}) {
  const params = await props.params
  const [{ planVersion }, { cards }] = await Promise.all([
    api.planVersions.getById({ id: params.planVersionId }),
    api.rateCards.forPlanVersion({ planVersionId: params.planVersionId }),
  ])

  if (!planVersion) notFound()

  const entry = cards.find((card) => card.currency === planVersion.currency)
  if (!entry) {
    return (
      <EmptyPlaceholder className="min-h-[320px]">
        <EmptyPlaceholder.Icon>
          <Rows3 className="h-8 w-8" />
        </EmptyPlaceholder.Icon>
        <EmptyPlaceholder.Title>No prices yet</EmptyPlaceholder.Title>
        <EmptyPlaceholder.Description>
          Set a price in the feature table. The first saved price creates this version's card, and
          every price after it lands here with its history.
        </EmptyPlaceholder.Description>
      </EmptyPlaceholder>
    )
  }

  // Awaited, so the server renders the list and the client hydrates it as is; the header's
  // publish button reads the version's cards from the same cache.
  await Promise.all([
    prefetch(trpc.rateCards.get.queryOptions({ id: entry.card.id })),
    prefetch(trpc.rateCards.forPlanVersion.queryOptions({ planVersionId: params.planVersionId })),
  ])
  const label = cardLabel(entry.card.name, {
    planSlug: params.planSlug,
    planVersionId: params.planVersionId,
    currency: planVersion.currency,
  })
  const features = planVersion.planFeatures.map((planFeature) => ({
    slug: planFeature.feature.slug,
    title: planFeature.feature.title,
    unit: planFeature.unitOfMeasure ?? planFeature.feature.unitOfMeasure ?? "units",
  }))

  return (
    <div className="hide-scrollbar flex min-h-0 flex-col gap-4 overscroll-contain pb-8 lg:flex-1 lg:overflow-y-auto">
      {!label.isOwn && (
        <Typography
          variant="p"
          affects="removePaddingMargin"
          className="text-muted-foreground text-sm"
        >
          This version prices with the shared card{" "}
          <span className="font-mono">{entry.card.name}</span>, so these prices apply to every
          version assigned to it.
        </Typography>
      )}
      <HydrateClient>
        <RateCardDetail cardId={entry.card.id} features={features} />
      </HydrateClient>
    </div>
  )
}
