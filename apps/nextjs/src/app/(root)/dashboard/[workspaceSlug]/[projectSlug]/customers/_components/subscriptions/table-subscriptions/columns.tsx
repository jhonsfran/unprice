"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Checkbox } from "@unprice/ui/checkbox"
import { Separator } from "@unprice/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { AlertCircle } from "lucide-react"
import { useParams } from "next/navigation"
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
      <div className="whitespace-nowrap text-sm">
        {row.original.customer.email} - {row.original.customer.name}
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

function SubscriptionDateCell({
  subscription,
  timestamp,
  emptyLabel = "Forever",
  tooltipSide = "bottom",
}: {
  subscription: Subscription
  timestamp: number | null | undefined
  emptyLabel?: string
  tooltipSide?: "bottom" | "right"
}) {
  if (timestamp === null || timestamp === undefined) {
    return (
      <Typography variant="p" affects="removePaddingMargin">
        {emptyLabel}
      </Typography>
    )
  }

  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      <Typography variant="p" affects="removePaddingMargin">
        {formatSubscriptionDate(timestamp, subscription)}
      </Typography>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertCircle className="size-4 font-light text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent align="start" side={tooltipSide} sideOffset={10} alignOffset={-5}>
          <div className="flex flex-col gap-1">
            <Typography variant="p" affects="removePaddingMargin" className="font-semibold">
              Timezone: {subscription.timezone}
            </Typography>
            <Separator className="my-1" />
            <Typography variant="p" affects="removePaddingMargin" className="text-xs">
              <span className="font-semibold">Local time: </span>
              {format(toZonedTime(timestamp, subscription.timezone), "PPpp")}
            </Typography>

            <Typography variant="p" affects="removePaddingMargin" className="text-xs">
              <span className="font-semibold">Customer time: </span>
              {format(new Date(timestamp), "PPpp")}
            </Typography>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export const columns: ColumnDef<Subscription>[] = [
  {
    id: "select",
    size: 50,
    accessorKey: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        disabled={table.getRowModel().rows.length === 0}
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
        className="translate-y-0.5"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
        className="translate-y-0.5"
      />
    ),
    enableSorting: false,
    enableHiding: false,
    enableResizing: false,
  },
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
    cell: ({ row }) => {
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
    cell: ({ row }) => <Badge className="text-xs">{row.original.planSlug}</Badge>,
    size: 20,
  },
  {
    accessorKey: "timezone",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Timezone" />,
    cell: ({ row }) => <Badge>{row.original.timezone}</Badge>,
    size: 20,
  },
  {
    accessorKey: "currentCycleStartAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Start current cycle" />,
    cell: ({ row }) => (
      <SubscriptionDateCell
        subscription={row.original}
        timestamp={row.original.currentCycleStartAt}
        tooltipSide="right"
      />
    ),
    enableSorting: true,
    enableHiding: true,
    size: 40,
  },
  {
    accessorKey: "currentCycleEndAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="End current cycle" />,
    cell: ({ row }) => (
      <SubscriptionDateCell
        subscription={row.original}
        timestamp={row.original.currentCycleEndAt}
      />
    ),
    enableSorting: true,
    enableHiding: true,
    size: 40,
  },
  {
    id: "renewalDate",
    accessorFn: (row) => row.renewAt ?? row.currentCycleEndAt,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Renewal date" />,
    cell: ({ row }) => (
      <SubscriptionDateCell
        subscription={row.original}
        timestamp={row.original.renewAt ?? row.original.currentCycleEndAt}
        emptyLabel="Not scheduled"
      />
    ),
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
