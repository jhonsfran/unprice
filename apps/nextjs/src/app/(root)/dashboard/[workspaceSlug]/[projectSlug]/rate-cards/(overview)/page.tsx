import { Button } from "@unprice/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { CreditCard } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { api } from "~/trpc/server"
import { NewRateCardDialog } from "../_components/new-rate-card-dialog"
import {
  RATE_CARDS_DESCRIPTION,
  formatCardUnit,
  formatMarginPolicy,
} from "../_components/rate-card-format"

export const dynamic = "force-dynamic"

export default async function RateCardsPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
}) {
  const { workspaceSlug, projectSlug } = await props.params
  const { cards } = await api.rateCards.list()
  const baseHref = `/${workspaceSlug}/${projectSlug}/rate-cards`

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Rate cards"
          description={RATE_CARDS_DESCRIPTION}
          action={
            <NewRateCardDialog>
              <Button size="sm">New rate card</Button>
            </NewRateCardDialog>
          }
        />
      }
    >
      {cards.length === 0 ? (
        <EmptyPlaceholder className="min-h-[360px]">
          <EmptyPlaceholder.Icon>
            <CreditCard className="h-8 w-8" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No rate cards yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Create a card, publish a row per feature, then assign it to a plan version.
          </EmptyPlaceholder.Description>
          <EmptyPlaceholder.Action>
            <NewRateCardDialog>
              <Button size="sm">New rate card</Button>
            </NewRateCardDialog>
          </EmptyPlaceholder.Action>
        </EmptyPlaceholder>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Margin policy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cards.map((card) => (
                <TableRow key={card.id}>
                  <TableCell>
                    <SuperLink
                      href={`${baseHref}/${card.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {card.name}
                    </SuperLink>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{formatCardUnit(card.unit)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatMarginPolicy(card.marginPolicy)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </DashboardShell>
  )
}
