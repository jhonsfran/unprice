import { pricingShape } from "@unprice/services/pricing"
import { featurePricingOf } from "@unprice/services/rate-cards"
import { Typography } from "@unprice/ui/typography"
import { Rows3 } from "lucide-react"
import { notFound } from "next/navigation"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { HydrateClient, api, prefetch, trpc } from "~/trpc/server"
import { cardLabel } from "../../../_components/plan-prices"
import { SharedCardPicker } from "../_components/plan-version-rate-card"
import { VersionPrices } from "../_components/version-prices"

export const dynamic = "force-dynamic"

function meterPropertyOf(
  slug: string,
  meterConfig: Parameters<typeof featurePricingOf>[0]["meterConfig"]
): string | null {
  const parsed = featurePricingOf({ slug, meterConfig })
  return parsed.ok ? parsed.pricing.meterProperty : null
}

type PlanFeature = NonNullable<
  Awaited<ReturnType<typeof api.planVersions.getById>>["planVersion"]
>["planFeatures"][number]

/**
 * How a feature is charged, in words beside its price, so "$49" reads as "Fixed, monthly".
 * The price sheet knows rates; the package (fixed, tiered, metered, a bundle) knows what they mean.
 */
function describeCharge(planFeature: PlanFeature, units: string): string {
  const cycle = planFeature.billingConfig.name
  const unit = units.replace(/s$/, "")
  switch (planFeature.featureType) {
    case "flat":
      return `Fixed, ${cycle}`
    case "tier":
      return `Per ${unit} picked at signup, ${cycle}`
    case "package":
      return `Bundles of ${planFeature.config?.units ?? 1} ${units}, ${cycle}`
    case "usage": {
      const included = Number(planFeature.included ?? 0)
      const mode = planFeature.config?.usageMode
      const how =
        mode === "tier"
          ? `Metered per ${unit}, tiered`
          : mode === "package"
            ? `Metered in bundles of ${planFeature.config?.units ?? 1}`
            : `Metered per ${unit}`
      return included > 0 ? `${how}, first ${included.toLocaleString("en")} free` : how
    }
    default:
      return cycle
  }
}

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
  const features = planVersion.planFeatures.map((planFeature) => {
    const unit = planFeature.unitOfMeasure ?? planFeature.feature.unitOfMeasure ?? "units"
    return {
      slug: planFeature.feature.slug,
      title: planFeature.feature.title,
      unit,
      charge: describeCharge(planFeature, unit),
      pricing: {
        shape: pricingShape({
          featureType: planFeature.featureType,
          usageMode: planFeature.config?.usageMode,
        }),
        // The server's own rule for what a usage row counts (`featurePricingOf`); none for fixed.
        property:
          planFeature.featureType === "usage"
            ? meterPropertyOf(planFeature.feature.slug, planFeature.meterConfig)
            : null,
        size: planFeature.config?.units ?? null,
      },
    }
  })

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
        <VersionPrices
          cardId={entry.card.id}
          planVersionId={planVersion.id}
          currency={planVersion.currency}
          features={features}
        />
        {planVersion.status !== "published" && (
          <SharedCardPicker planVersionId={planVersion.id} currency={planVersion.currency} />
        )}
      </HydrateClient>
    </div>
  )
}
