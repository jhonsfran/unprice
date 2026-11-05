import { TRPCError } from "@trpc/server"
import { buttonVariants } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { CreditCard } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { SuperLink } from "~/components/super-link"
import { HydrateClient, api, prefetch, trpc } from "~/trpc/server"
import { RateCardDetail } from "../_components/rate-card-detail"
import { cardCurrency, formatCardUnit, formatMarginPolicy } from "../_components/rate-card-format"

export const dynamic = "force-dynamic"

export default async function RateCardPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string; cardId: string }>
}) {
  const { workspaceSlug, projectSlug, cardId } = await props.params
  const listHref = `/${workspaceSlug}/${projectSlug}/rate-cards`
  const found = await api.rateCards.get({ id: cardId }).catch((error: unknown) => {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") return null
    throw error
  })

  if (!found) {
    return (
      <DashboardShell>
        <EmptyPlaceholder className="min-h-[360px]">
          <EmptyPlaceholder.Icon>
            <CreditCard className="h-8 w-8" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Rate card not found</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            It may belong to another project.
          </EmptyPlaceholder.Description>
          <EmptyPlaceholder.Action>
            <SuperLink href={listHref} className={buttonVariants({ variant: "outline" })}>
              All rate cards
            </SuperLink>
          </EmptyPlaceholder.Action>
        </EmptyPlaceholder>
      </DashboardShell>
    )
  }

  prefetch(trpc.rateCards.get.queryOptions({ id: cardId }))
  prefetch(trpc.features.listByActiveProject.queryOptions())

  // A version's own card is named `<plan slug> <version id> <currency>` (pricePlanVersion), so the
  // name says which version the card was made for; the procedure does not list its versions.
  const [planSlug, planVersionId, namedCurrency] = found.card.name.split(" ")
  const ownerHref =
    planSlug && planVersionId?.startsWith("pv_") && namedCurrency === cardCurrency(found.card.unit)
      ? `/${workspaceSlug}/${projectSlug}/plans/${planSlug}/${planVersionId}`
      : null

  return (
    <DashboardShell
      header={
        <div className="flex w-full flex-col gap-1.5">
          <Typography variant="h3">{found.card.name}</Typography>
          <span className="font-mono text-muted-foreground text-xs">
            {formatCardUnit(found.card.unit)} · {formatMarginPolicy(found.card.marginPolicy)} ·{" "}
            {found.live ? "live · priced by a published version" : "draft only"}
          </span>
          {ownerHref && (
            <span className="text-muted-foreground text-xs">
              Made for plan <span className="font-mono">{planSlug}</span>, version{" "}
              <span className="font-mono">{planVersionId}</span>.{" "}
              <SuperLink href={ownerHref} className="underline-offset-4 hover:underline">
                Open the version editor.
              </SuperLink>
            </span>
          )}
        </div>
      }
    >
      <HydrateClient>
        <RateCardDetail cardId={cardId} />
      </HydrateClient>
    </DashboardShell>
  )
}
