"use client"

import type { ColumnDef } from "@tanstack/react-table"

import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Checkbox } from "@unprice/ui/checkbox"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { format } from "date-fns"
import { InfoIcon } from "lucide-react"
import { useParams } from "next/navigation"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { DataTableRowActions } from "./data-table-row-actions"

type InvoiceCustomer =
  RouterOutputs["customers"]["getSubscriptions"]["customer"]["invoices"][number]

export const columns: ColumnDef<InvoiceCustomer>[] = [
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
    accessorKey: "id",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Invoice" />,
    cell: ({ row }) => {
      const { workspaceSlug, projectSlug, customerId } = useParams()
      return (
        <div className="whitespace-nowrap text-sm">
          <SuperLink
            href={`/${workspaceSlug}/${projectSlug}/customers/${customerId}/invoices/${row.original.id}`}
            className="hover:underline"
          >
            {row.original.id}
          </SuperLink>
        </div>
      )
    },
    size: 40,
    filterFn: (row, _, filterValue) => {
      // search by id
      const searchValue = filterValue.toLowerCase()
      const id = row.original.id.toLowerCase()

      if (id.includes(searchValue)) {
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
        <Badge variant={["void", "paid"].includes(row.original.status) ? "success" : "destructive"}>
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
    accessorKey: "provider",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Provider" />,
    cell: ({ row }) => <Badge className="text-xs">{row.original.paymentProvider}</Badge>,
    size: 20,
  },
  {
    accessorKey: "total",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Amount" />,
    cell: ({ row }) => (
      <Badge>
        {formatMoney(
          toDecimal(fromLedgerMinor(row.original.totalAmount, row.original.currency)),
          row.original.currency
        )}
      </Badge>
    ),
    size: 20,
  },
  {
    accessorKey: "startDate",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Start date" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap">
        {format(new Date(row.original.statementStartAt), "PPpp")}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "endDate",
    header: ({ column }) => <DataTableColumnHeader column={column} title="End date" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap">
        {format(new Date(row.original.statementEndAt), "PPpp")}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "dueAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Due date" />,
    cell: ({ row }) => {
      const dueAt = row.original.dueAt
      const metadata = row.original.metadata
      return (
        <div className="flex items-center space-x-1 whitespace-nowrap">
          <Typography variant="p" affects="removePaddingMargin">
            {format(new Date(dueAt), "PPpp")}
          </Typography>
          {metadata && Object.keys(metadata).length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-4 font-light text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="w-52" align="end" sideOffset={-20} alignOffset={10}>
                <div className="flex flex-col gap-1">
                  <pre className="whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-muted-foreground text-xs">
                    {JSON.stringify(metadata, null, 2)}
                  </pre>
                </div>
              </TooltipContent>
            </Tooltip>
          )}
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
