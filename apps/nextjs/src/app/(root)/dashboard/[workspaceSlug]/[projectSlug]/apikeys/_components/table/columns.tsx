"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { RouterOutputs } from "@unprice/trpc/routes"

import { Typography } from "@unprice/ui/typography"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { formatDate } from "~/lib/dates"
import { DataTableRowActions } from "./data-table-row-actions"

export type ApiKey = RouterOutputs["apikeys"]["listByActiveProject"]["apikeys"][number]

export const columns: ColumnDef<ApiKey>[] = [
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
    header: ({ column }) => <DataTableColumnHeader column={column} title="Default customer" />,
    cell: ({ row }) => {
      if (!row.original.defaultCustomerId) {
        return (
          <span aria-label="No default customer" className="text-muted-foreground">
            —
          </span>
        )
      }

      return (
        <span className="whitespace-nowrap font-mono text-xs">
          {row.original.defaultCustomerId}
        </span>
      )
    },
    enableSorting: false,
    enableHiding: true,
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
          {formatDate(row.getValue("createdAtM"))}
        </Typography>
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
  },
  {
    accessorKey: "expiresAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Expires" />,
    cell: ({ row }) => {
      const expiresAt = row.original.expiresAt

      if (row.original.revokedAt !== null) {
        return (
          <div className="flex flex-col text-destructive">
            <span>Revoked</span>
            <span className="font-mono text-xs tabular-nums">
              {formatDate(row.original.revokedAt)}
            </span>
          </div>
        )
      }

      if (expiresAt === null) {
        // a key that never expires is the risky configuration, not the neutral one
        return <span className="text-warning-text">Never expires</span>
      }

      if (expiresAt < Date.now()) {
        return (
          <div className="flex flex-col text-destructive">
            <span>Expired</span>
            <span className="font-mono text-xs tabular-nums">{formatDate(expiresAt)}</span>
          </div>
        )
      }
      return <span className="font-mono text-xs tabular-nums">{formatDate(expiresAt)}</span>
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
          <Typography
            variant="p"
            affects="removePaddingMargin"
            className="font-mono text-xs tabular-nums"
          >
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
