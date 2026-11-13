import { TRPCError } from "@trpc/server"
import { buttonVariants } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { CreditCard } from "lucide-react"
import { redirect } from "next/navigation"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { formatCardUnit } from "~/components/pricing/rate-card-format"
import { SuperLink } from "~/components/super-link"
import { HydrateClient, api, prefetch, trpc } from "~/trpc/server"
import { RateCardDetail } from "../_components/rate-card-detail"

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

  const owner = (await api.rateCards.list()).cards.find((card) => card.id === cardId)?.version
  if (owner) {
    redirect(
      `/${workspaceSlug}/${projectSlug}/plans/${owner.planSlug}/${owner.planVersionId}/prices`
    )
  }

  await Promise.all([
    prefetch(trpc.rateCards.get.queryOptions({ id: cardId })),
    prefetch(trpc.features.listByActiveProject.queryOptions()),
  ])

  return (
    <DashboardShell
      header={
        <div className="flex w-full flex-col gap-1.5">
          <Typography variant="h3">{found.card.name}</Typography>
          <span className="text-muted-foreground text-xs">
            Shared card in {formatCardUnit(found.card.unit)}: every version assigned to it charges
            these prices. {found.live ? "Live." : "Not live yet."}
          </span>
        </div>
      }
    >
      <HydrateClient>
        <RateCardDetail cardId={cardId} />
      </HydrateClient>
    </DashboardShell>
  )
}
