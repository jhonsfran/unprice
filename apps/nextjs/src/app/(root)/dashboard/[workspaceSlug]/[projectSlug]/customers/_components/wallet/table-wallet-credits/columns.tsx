"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { format } from "date-fns"
import { InfoIcon } from "lucide-react"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { formatWalletMoney } from "../format-wallet-money"

type WalletCredit = RouterOutputs["customers"]["getWallet"]["wallet"]["credits"][number] & {
  currency: RouterOutputs["customers"]["getWallet"]["wallet"]["currency"]
}

function statusVariant(status: WalletCredit["status"]) {
  return status === "active" ? "success" : "destructive"
}

function formatWalletDate(date: WalletCredit["expiresAt"] | WalletCredit["createdAt"]) {
  if (!date) {
    return "Never"
  }

  return format(new Date(date), "PPpp")
}

export const columns: ColumnDef<WalletCredit>[] = [
  {
    accessorKey: "id",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Wallet credit" className="pl-4" />
    ),
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="whitespace-nowrap pl-3 font-mono text-sm"
      >
        {row.original.id}
      </Typography>
    ),
    size: 48,
    filterFn: (row, _, filterValue) => {
      const searchValue = String(filterValue).toLowerCase()
      return row.original.id.toLowerCase().includes(searchValue)
    },
  },
  {
    accessorKey: "source",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
    cell: ({ row }) => <Badge variant="outline">{row.original.source}</Badge>,
    size: 28,
    filterFn: (row, _id, value) => {
      return Array.isArray(value) && value.includes(row.original.source)
    },
  },
  {
    accessorKey: "status",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>
    ),
    size: 28,
    filterFn: (row, _id, value) => {
      return Array.isArray(value) && value.includes(row.original.status)
    },
  },
  {
    accessorKey: "issuedAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Issued" />,
    cell: ({ row }) => (
      <Badge>{formatWalletMoney(row.original.issuedAmount, row.original.currency)}</Badge>
    ),
    size: 28,
  },
  {
    accessorKey: "consumedAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Consumed" />,
    cell: ({ row }) => (
      <Badge variant="outline">
        {formatWalletMoney(row.original.consumedAmount, row.original.currency)}
      </Badge>
    ),
    size: 28,
  },
  {
    accessorKey: "usableAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Available" />,
    cell: ({ row }) => (
      <Badge variant={row.original.status === "active" ? "secondary" : "outline"}>
        {formatWalletMoney(row.original.usableAmount, row.original.currency)}
      </Badge>
    ),
    size: 28,
  },
  {
    accessorKey: "expiresAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Expires" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap text-sm">
        {formatWalletDate(row.original.expiresAt)}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
    cell: ({ row }) => {
      const metadata = row.original.metadata

      return (
        <div className="flex items-center gap-1 whitespace-nowrap">
          <Typography variant="p" affects="removePaddingMargin" className="text-sm">
            {formatWalletDate(row.original.createdAt)}
          </Typography>
          {metadata && Object.keys(metadata).length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="w-52" align="end">
                <pre className="whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-muted-foreground text-xs">
                  {JSON.stringify(metadata, null, 2)}
                </pre>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )
    },
    size: 40,
  },
]
