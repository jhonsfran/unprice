import { TRPCError } from "@trpc/server"
import { buttonVariants } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { CreditCard } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { SuperLink } from "~/components/super-link"
import { HydrateClient, api, prefetch, trpc } from "~/trpc/server"
import { RateCardDetail } from "../_components/rate-card-detail"
import { formatCardUnit, formatMarginPolicy } from "../_components/rate-card-format"

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

  return (
    <DashboardShell
      header={
        <div className="flex w-full flex-col gap-1.5">
          <Typography variant="h3">{found.card.name}</Typography>
          <span className="font-mono text-muted-foreground text-xs">
            {formatCardUnit(found.card.unit)} · {formatMarginPolicy(found.card.marginPolicy)} ·{" "}
            {found.live ? "live · priced by a published version" : "draft only"}
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
