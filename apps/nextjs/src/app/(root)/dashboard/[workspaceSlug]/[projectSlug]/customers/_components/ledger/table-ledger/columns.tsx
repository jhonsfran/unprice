"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { formatLedgerMoney } from "@unprice/money"
import type { LedgerParty } from "@unprice/services/use-cases"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { ArrowRight, InfoIcon } from "lucide-react"
import { useParams } from "next/navigation"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { accountLabel, activityLabel, partyLabel } from "./labels"

type Movement = RouterOutputs["customers"]["getLedger"]["movements"][number] & {
  currency: RouterOutputs["customers"]["getLedger"]["currency"]
}

/**
 * Sign and colour follow the effect on spendable balance, not the raw double
 * entry: a settled hold is `internal` because the money already left when the
 * hold was taken, so it must not read as a second charge.
 */
function AmountCell({ movement }: { movement: Movement }) {
  const amount = formatLedgerMoney(movement.amount, movement.currency)

  if (movement.direction === "internal") {
    return (
      <span className="whitespace-nowrap font-mono text-muted-foreground text-xs tabular-nums">
        {amount}
      </span>
    )
  }

  const incoming = movement.direction === "in"

  return (
    <span
      className={cn(
        "whitespace-nowrap font-mono text-xs tabular-nums",
        incoming ? "text-success" : "text-danger-text"
      )}
    >
      {incoming ? "+" : "−"}
      {amount}
    </span>
  )
}

/** The run that caused this movement, linked into the runs tab's search. */
function MovementContext({ movement }: { movement: Movement }) {
  const { workspaceSlug, projectSlug, customerId } = useParams<{
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }>()

  if (movement.runId) {
    return (
      <SuperLink
        href={`/${workspaceSlug}/${projectSlug}/customers/${customerId}/runs?search=${movement.runId}`}
        className="truncate font-mono text-muted-foreground text-xs underline-offset-4 hover:underline"
      >
        {movement.runId}
      </SuperLink>
    )
  }

  const fallback = movement.statementKey ?? movement.reservationId

  return <span className="truncate font-mono text-muted-foreground text-xs">{fallback ?? "—"}</span>
}

/**
 * The customer accounts a movement touches — one when the counterparty is a
 * platform funding account, two when the money moved between the customer's
 * own accounts. Backs both faceting and the `account` filter.
 */
function customerAccountsOf(movement: Movement): string[] {
  const accounts = [movement.from, movement.to]
    .filter((party) => party.side === "customer")
    .map((party) => (party as Extract<LedgerParty, { side: "customer" }>).account)

  return [...new Set(accounts)]
}

function PartyChip({ label }: { label: string }) {
  return <Badge variant="secondary">{label}</Badge>
}

export const columns: ColumnDef<Movement>[] = [
  {
    // hidden by default — gives the search box a home and keeps the raw id one
    // click away in the View menu for support work
    id: "id",
    accessorKey: "id",
    header: "Transfer",
    enableSorting: false,
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="whitespace-nowrap font-mono text-xs"
      >
        {row.original.id}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "eventAt",
    header: "When",
    enableSorting: false,
    cell: ({ row }) => {
      const metadata = row.original.metadata

      return (
        <div className="flex items-center gap-1 whitespace-nowrap">
          <Typography
            variant="p"
            affects="removePaddingMargin"
            className="font-mono text-xs tabular-nums"
          >
            {formatDate(new Date(row.original.eventAt).getTime(), "UTC", "MMM d, HH:mm:ss")}
          </Typography>
          {metadata && Object.keys(metadata).length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="w-72" align="start">
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-muted-foreground text-xs">
                  {JSON.stringify(metadata, null, 2)}
                </pre>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )
    },
    size: 32,
  },
  {
    id: "activity",
    // faceting reads through the accessor, and `filterFn` must exist even
    // though filtering runs server-side — without both, the faceted filter
    // throws when it asks this column for its unique values
    accessorFn: (movement) => movement.flow ?? "",
    filterFn: (row, _id, value) =>
      Array.isArray(value) && value.includes(row.original.flow as string),
    header: "Activity",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex min-w-0 flex-col gap-1">
        <Typography variant="p" affects="removePaddingMargin" className="truncate text-sm">
          {activityLabel(row.original.flow, row.original.direction)}
        </Typography>
        <MovementContext movement={row.original} />
      </div>
    ),
    size: 44,
  },
  {
    id: "account",
    accessorFn: (movement) => customerAccountsOf(movement),
    // a movement can sit on two accounts, so each is faceted separately
    getUniqueValues: (movement) => customerAccountsOf(movement),
    filterFn: (row, _id, value) =>
      Array.isArray(value) &&
      customerAccountsOf(row.original).some((account) => value.includes(account)),
    header: "Accounts",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <PartyChip label={partyLabel(row.original.from)} />
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
        <PartyChip label={partyLabel(row.original.to)} />
      </div>
    ),
    size: 40,
  },
  {
    accessorKey: "amount",
    header: "Amount",
    enableSorting: false,
    // money is tabular text, not a chip
    cell: ({ row }) => <AmountCell movement={row.original} />,
    size: 24,
  },
  {
    id: "balanceAfter",
    accessorFn: (movement) => movement.balanceAfter?.amount ?? 0,
    header: "Balance after",
    enableSorting: false,
    cell: ({ row }) => {
      const balance = row.original.balanceAfter

      if (!balance) {
        return <span className="text-muted-foreground text-xs">—</span>
      }

      return (
        <div className="flex flex-col gap-0.5 whitespace-nowrap">
          <span className="font-mono text-xs tabular-nums">
            {formatLedgerMoney(balance.amount, row.original.currency)}
          </span>
          <span className="text-muted-foreground text-xs">{accountLabel(balance.account)}</span>
        </div>
      )
    },
    size: 28,
  },
]
