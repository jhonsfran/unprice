"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { formatRelative } from "date-fns"

import type { RouterOutputs } from "@unprice/trpc/routes"

import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { DataTableRowActions } from "./data-table-row-actions"

export type Member = RouterOutputs["workspaces"]["listInvitesByActiveWorkspace"]["invites"][number]

function formatRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()
}

export const columns: ColumnDef<Member>[] = [
  {
    accessorKey: "email",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
    cell: ({ row }) => <div className="font-mono text-xs">{row.original.email}</div>,
  },
  {
    accessorKey: "role",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
    cell: ({ row }) => <div>{formatRole(row.getValue("role"))}</div>,
    enableSorting: false,
    enableHiding: true,
  },
  {
    accessorKey: "createdAtM",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Created at" />,
    cell: ({ row }) => (
      <div className="font-mono text-muted-foreground text-xs">
        {formatRelative(row.getValue("createdAtM"), new Date())}
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
  },
  {
    accessorKey: "acceptedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Accepted at" />,
    cell: ({ row }) => (
      <div className="font-mono text-muted-foreground text-xs">
        {row.getValue("acceptedAt")
          ? formatRelative(row.getValue("acceptedAt"), new Date())
          : "Pending"}
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
  },
  {
    id: "actions",
    cell: ({ row }) => <DataTableRowActions row={row} />,
  },
]
