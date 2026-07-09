"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Separator } from "@unprice/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { useParams } from "next/navigation"
import type { ReactNode } from "react"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { DataTableRowActions } from "./data-table-row-actions"

type Subscription = RouterOutputs["subscriptions"]["listByActiveProject"]["subscriptions"][number]

const DATE_ONLY_FORMAT = "yyyy-MM-dd"
const DATE_TIME_FORMAT = "yyyy-MM-dd HH:mm"

function SubscriptionCustomerCell({ row }: { row: { original: Subscription } }) {
  const { workspaceSlug, projectSlug } = useParams()
  return (
    <SuperLink href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/${row.original.id}`}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{row.original.customer.name}</span>
        <span className="truncate font-mono text-muted-foreground text-xs">
          {row.original.customer.email}
        </span>
      </div>
    </SuperLink>
  )
}

function shouldShowDateTime(subscription: Subscription) {
  return subscription.billingConfig?.billingInterval === "minute"
}

function formatSubscriptionDate(timestamp: number, subscription: Subscription) {
  return formatDate(
    timestamp,
    subscription.timezone,
    shouldShowDateTime(subscription) ? DATE_TIME_FORMAT : DATE_ONLY_FORMAT
  )
}

// the date text itself is the tooltip trigger: timezone detail on demand
// without an icon repeated in every cell
function SubscriptionDateTooltip({
  subscription,
  timestamp,
  children,
}: {
  subscription: Subscription
  timestamp: number
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-2">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent align="start" side="bottom" sideOffset={10} alignOffset={-5}>
        <div className="flex flex-col gap-1">
          <Typography variant="p" affects="removePaddingMargin" className="font-semibold">
            Timezone: {subscription.timezone}
          </Typography>
          <Separator className="my-1" />
          <Typography variant="p" affects="removePaddingMargin" className="text-xs">
            <span className="font-semibold">Local time: </span>
            <span className="font-mono tabular-nums">
              {format(toZonedTime(timestamp, subscription.timezone), "PPpp")}
            </span>
          </Typography>

          <Typography variant="p" affects="removePaddingMargin" className="text-xs">
            <span className="font-semibold">Customer time: </span>
            <span className="font-mono tabular-nums">{format(new Date(timestamp), "PPpp")}</span>
          </Typography>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export const columns: ColumnDef<Subscription>[] = [
  {
    accessorKey: "customerId",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
    cell: ({ row }) => <SubscriptionCustomerCell row={row} />,
    size: 40,
    filterFn: (row, _, filterValue) => {
      // search by name, email or customer id
      const searchValue = filterValue.toLowerCase()
      const name = row.original.customer.name.toLowerCase()
      const email = row.original.customer.email.toLowerCase()
      const id = row.original.customer.id.toLowerCase()
      const planSlug = row.original.planSlug.toLowerCase()

      if (
        name.includes(searchValue) ||
        email.includes(searchValue) ||
        id.includes(searchValue) ||
        planSlug.includes(searchValue)
      ) {
        return true
      }

      return false
    },
  },
  {
    accessorKey: "status",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    // the healthy state stays quiet; exceptional statuses earn the chip
    cell: ({ row }) => {
      if (row.original.status === "active") {
        return (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs">
            <span className="size-1.5 rounded-full bg-success-solid" aria-hidden="true" />
            Active
          </span>
        )
      }

      return (
        <Badge variant={row.original.active ? "success" : "destructive"}>
          {row.original.status}
        </Badge>
      )
    },
    size: 20,
    filterFn: (row, _id, value) => {
      const status = row.original.status.toLowerCase()
      return Array.isArray(value) && value.includes(status)
    },
  },
  {
    accessorKey: "planSlug",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Plan" />,
    cell: ({ row }) => (
      <span className="font-mono text-muted-foreground text-xs">{row.original.planSlug}</span>
    ),
    size: 20,
  },
  {
    accessorKey: "timezone",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Timezone" />,
    cell: ({ row }) => (
      <span className="font-mono text-muted-foreground text-xs">{row.original.timezone}</span>
    ),
    size: 20,
  },
  {
    accessorKey: "currentCycleStartAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Current cycle" />,
    cell: ({ row }) => (
      <div className="whitespace-nowrap font-mono text-xs tabular-nums">
        <SubscriptionDateTooltip
          subscription={row.original}
          timestamp={row.original.currentCycleStartAt}
        >
          {formatSubscriptionDate(row.original.currentCycleStartAt, row.original)}
        </SubscriptionDateTooltip>
        <span className="text-muted-foreground"> – </span>
        <SubscriptionDateTooltip
          subscription={row.original}
          timestamp={row.original.currentCycleEndAt}
        >
          {formatSubscriptionDate(row.original.currentCycleEndAt, row.original)}
        </SubscriptionDateTooltip>
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
    size: 40,
  },
  {
    id: "renewalDate",
    accessorFn: (row) => row.renewAt ?? row.currentCycleEndAt,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Renews" />,
    cell: ({ row }) => {
      const timestamp = row.original.renewAt ?? row.original.currentCycleEndAt

      if (timestamp === null || timestamp === undefined) {
        return (
          <Typography variant="p" affects="removePaddingMargin">
            Not scheduled
          </Typography>
        )
      }

      return (
        <div className="whitespace-nowrap font-mono text-xs tabular-nums">
          <SubscriptionDateTooltip subscription={row.original} timestamp={timestamp}>
            {formatSubscriptionDate(timestamp, row.original)}
          </SubscriptionDateTooltip>
        </div>
      )
    },
    enableSorting: true,
    enableHiding: true,
    size: 40,
  },
  {
    id: "actions",
    cell: function Cell({ row }) {
      return <DataTableRowActions row={row} />
    },
    size: 30,
  },
]
