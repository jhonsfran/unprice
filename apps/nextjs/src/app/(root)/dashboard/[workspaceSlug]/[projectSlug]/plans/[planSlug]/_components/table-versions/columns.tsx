"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { cn } from "@unprice/ui/utils"

import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
import { usePathname } from "next/navigation"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { getStatusTone, statusToneClasses } from "~/lib/status-tones"
import { DataTableRowActions } from "./data-table-row-actions"

export type PlanVersion = RouterOutputs["plans"]["getVersionsBySlug"]["plan"]["versions"][number]

function PlanVersionTitleCell({ row }: { row: { original: PlanVersion } }) {
  const pathname = usePathname()
  const latestToneClass = statusToneClasses[getStatusTone("latest")]

  return (
    <SuperLink href={`${pathname}/${row.original.id}`} prefetch={false}>
      <div className="flex items-center gap-2">
        <Typography variant="h6" className="truncate">
          {row.original.title}
        </Typography>

        {row.original.latest && (
          <div
            className={cn(
              "inline-flex items-center gap-1 font-medium text-xs",
              latestToneClass.text
            )}
          >
            <span className={cn("size-1.5 rounded-full", latestToneClass.dot)} />
            <span>latest</span>
          </div>
        )}
      </div>

      {row.original.description && (
        <div className="line-clamp-1 hidden text-muted-foreground text-xs md:inline">
          {row.original.description.length > 40
            ? `${row.original.description.slice(0, 40)}…`
            : row.original.description}
        </div>
      )}
    </SuperLink>
  )
}

export const columns: ColumnDef<PlanVersion>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Title" />,
    cell: ({ row }) => <PlanVersionTitleCell row={row} />,
    enableSorting: true,
    enableHiding: false,
    enableResizing: true,
    filterFn: (row, _, filterValue) => {
      // search by title and description
      const searchValue = filterValue.toLowerCase()
      const title = row.original.title.toLowerCase()
      const version = row.original.version.toString().toLowerCase()
      const description = row.original.description?.toLowerCase() ?? ""

      if (
        title.includes(searchValue) ||
        version.includes(searchValue) ||
        description.includes(searchValue)
      ) {
        return true
      }

      return false
    },
  },
  {
    accessorKey: "subs",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Subscribers" />,
    cell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums">{row.original.subscriptions}</span>
    ),
    size: 20,
  },
  {
    accessorKey: "interval",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Billing interval" />,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-mono text-muted-foreground text-xs">
        {row.original.billingConfig.name}
      </span>
    ),
    size: 20,
  },
  {
    accessorKey: "version",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Version" />,
    cell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums">v{row.original.version}</span>
    ),
    size: 20,
  },
  {
    accessorKey: "active",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Active" />,
    // active stays a quiet dot; the status chip is the one lifecycle signal
    cell: ({ row }) => {
      const status = row.original.active ? "active" : "inactive"
      const toneClass = statusToneClasses[getStatusTone(status)]

      return (
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className={cn("size-1.5 rounded-full", toneClass.dot)} aria-hidden="true" />
          {status}
        </span>
      )
    },
    size: 20,
  },
  {
    accessorKey: "status",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => {
      const toneClass = statusToneClasses[getStatusTone(row.original.status)]

      return <Badge variant={toneClass.badgeVariant}>{row.original.status}</Badge>
    },
    filterFn: (row, id, value) => {
      return Array.isArray(value) && value.includes(row.getValue(id))
    },
    size: 40,
  },
  {
    accessorKey: "currency",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Currency" />,
    cell: ({ row }) => (
      <span className="font-mono text-muted-foreground text-xs">{row.original.currency}</span>
    ),
    filterFn: (row, id, value) => {
      return Array.isArray(value) && value.includes(row.getValue(id))
    },
    size: 40,
  },
  {
    accessorKey: "paymentProvider",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Provider" />,
    cell: ({ row }) => (
      <span className="font-mono text-muted-foreground text-xs">
        {row.original.paymentProvider}
      </span>
    ),
    size: 40,
  },
  {
    accessorKey: "planType",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Plan type" />,
    cell: ({ row }) => (
      <span className="font-mono text-muted-foreground text-xs">
        {row.original.billingConfig.planType}
      </span>
    ),
    size: 40,
  },
  {
    accessorKey: "createdAtM",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
    cell: ({ row }) => (
      <div className="flex items-center space-x-1 whitespace-nowrap">
        <Typography
          variant="p"
          affects="removePaddingMargin"
          className="font-mono text-xs tabular-nums"
        >
          {formatDate(row.original.createdAtM)}
        </Typography>
      </div>
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
