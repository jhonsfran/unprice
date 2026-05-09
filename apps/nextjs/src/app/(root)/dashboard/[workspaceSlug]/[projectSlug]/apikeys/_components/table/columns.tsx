"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Checkbox } from "@unprice/ui/checkbox"

import { Typography } from "@unprice/ui/typography"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { formatDate } from "~/lib/dates"
import { DataTableRowActions } from "./data-table-row-actions"

export type ApiKey = RouterOutputs["apikeys"]["listByActiveProject"]["apikeys"][number]

export const columns: ColumnDef<ApiKey>[] = [
  {
    id: "select",
    size: 40,
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        disabled={
          table.getRowModel().rows.length === 0 ||
          table.getRowModel().rows.every((row) => row.original.revokedAt !== null)
        }
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
  },
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
    cell: ({ row }) => <div className="lowercase">{row.getValue("name")}</div>,
    enableSorting: true,
    enableHiding: false,
    enableResizing: true,
  },
  {
    accessorKey: "defaultCustomerId",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Default Customer" />,
    cell: ({ row }) => {
      if (!row.original.defaultCustomerId) {
        return <span className="text-muted-foreground">Not configured</span>
      }

      return row.original.defaultCustomerId
    },
    enableSorting: false,
    enableHiding: true,
  },
  {
    accessorKey: "createdAtM",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Created At" />,
    cell: ({ row }) => (
      <div className="flex items-center space-x-1 whitespace-nowrap">
        <Typography variant="p" affects="removePaddingMargin">
          {formatDate(row.getValue("createdAtM"))}
        </Typography>
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
  },
  {
    accessorKey: "expiresAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Expires At" />,
    cell: ({ row }) => {
      const expiresAt = row.original.expiresAt

      if (row.original.revokedAt !== null) {
        return (
          <div className="flex flex-col text-destructive">
            <span>Revoked</span>
            <span>{formatDate(row.original.revokedAt)}</span>
          </div>
        )
      }

      if (expiresAt === null) {
        return "Never expires"
      }

      if (expiresAt < Date.now()) {
        return (
          <div className="flex flex-col text-destructive">
            <span>Expired</span>
            <span>{formatDate(expiresAt)}</span>
          </div>
        )
      }
      return formatDate(expiresAt)
    },
    enableSorting: true,
    enableHiding: true,
  },
  {
    accessorKey: "lastUsed",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Last used" />,
    cell: ({ row }) => {
      const lastUsed = row.original.lastUsed
      if (lastUsed === null) {
        return "Never used"
      }
      return (
        <div className="flex items-center space-x-1 whitespace-nowrap">
          <Typography variant="p" affects="removePaddingMargin">
            {formatDate(lastUsed)}
          </Typography>
        </div>
      )
    },
    enableSorting: true,
    enableHiding: true,
  },
  {
    id: "actions",
    cell: function Cell({ row }) {
      return <DataTableRowActions row={row} />
    },
    size: 40,
  },
]
