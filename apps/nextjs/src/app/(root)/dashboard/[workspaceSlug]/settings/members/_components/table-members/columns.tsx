"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { formatRelative } from "date-fns"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Avatar, AvatarFallback, AvatarImage } from "@unprice/ui/avatar"

import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { DataTableRowActions } from "./data-table-row-actions"

export type Member = RouterOutputs["workspaces"]["listMembersByActiveWorkspace"]["members"][number]

function formatRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()
}

export const columns: ColumnDef<Member>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Avatar>
          <AvatarImage src={row.original.user.image ?? ""} alt={row.original.user.name ?? ""} />
          <AvatarFallback>{row.original.user.name?.substring(0, 2)}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col">
          <span>{row.original.user.name}</span>
          <span className="font-mono text-muted-foreground text-xs">{row.original.user.email}</span>
        </div>
      </div>
    ),
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
    header: ({ column }) => <DataTableColumnHeader column={column} title="Joined at" />,
    cell: ({ row }) => (
      <div className="font-mono text-muted-foreground text-xs">
        {formatRelative(row.getValue("createdAtM"), new Date())}
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
