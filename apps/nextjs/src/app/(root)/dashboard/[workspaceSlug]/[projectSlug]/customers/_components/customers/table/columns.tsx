"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { Customer } from "@unprice/db/validators"
import { Typography } from "@unprice/ui/typography"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { DataTableRowActions } from "./data-table-row-actions"

export const columns: ColumnDef<Customer>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
    cell: ({ row }) => (
      <SuperLink href={`./customers/${row.original.id}`} scroll={false}>
        <div className="whitespace-nowrap text-sm">{row.original.name}</div>
      </SuperLink>
    ),
    enableResizing: true,
  },
  {
    accessorKey: "email",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
    cell: ({ row }) => (
      <SuperLink href={`./customers/${row.original.id}`} scroll={false}>
        <div className="whitespace-nowrap font-mono text-xs">{row.original.email}</div>
      </SuperLink>
    ),
    enableSorting: false,
    enableHiding: false,
    enableResizing: true,
    filterFn: (row, _, filterValue) => {
      // search by name, email or customer id
      const searchValue = filterValue.toLowerCase()
      const name = row.original.name.toLowerCase()
      const email = row.original.email.toLowerCase()
      const id = row.original.id.toLowerCase()

      if (name.includes(searchValue) || email.includes(searchValue) || id.includes(searchValue)) {
        return true
      }

      return false
    },
  },
  {
    accessorKey: "defaultCurrency",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Currency" />,
    cell: ({ row }) => (
      <span className="font-mono text-muted-foreground text-xs">
        {row.original.defaultCurrency}
      </span>
    ),
    filterFn: (row, id, value) => {
      return Array.isArray(value) && value.includes(row.getValue(id))
    },
    size: 20,
  },
  {
    accessorKey: "active",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    // the healthy state stays quiet; only the exception earns a chip
    cell: ({ row }) =>
      row.original.active ? (
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className="size-1.5 rounded-full bg-success-solid" aria-hidden="true" />
          Active
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className="size-1.5 rounded-full bg-danger-solid" aria-hidden="true" />
          Inactive
        </span>
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
    accessorKey: "createdAtM",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Creation Date" />,
    cell: ({ row }) => (
      <div className="flex items-center space-x-1 whitespace-nowrap">
        <Typography
          variant="p"
          affects="removePaddingMargin"
          className="font-mono text-xs tabular-nums"
        >
          {formatDate(row.original.createdAtM, row.original.timezone)}
        </Typography>
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
  },
  {
    id: "actions",
    cell: ({ row }) => <DataTableRowActions row={row} />,
    size: 40,
  },
]
