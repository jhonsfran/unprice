import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Separator } from "@unprice/ui/separator"
import { Typography } from "@unprice/ui/typography"
import { formatDate } from "~/lib/dates"
import { ExplainChargeSheet } from "./explain-charge-sheet"
import { formatInvoiceMoney } from "./format-invoice-money"

type InvoiceLine = RouterOutputs["customers"]["getInvoiceById"]["invoice"]["lines"][number]

const getLineStatus = (line: InvoiceLine) => {
  if (line.amount === 0 && !line.collectable) {
    return "No charge"
  }

  if (line.settlementStatus === "due") {
    return "Due"
  }

  if (line.settlementStatus === "paid") {
    return "Paid"
  }

  return "Included"
}

const getLineStatusVariant = (line: InvoiceLine) => {
  if (line.settlementStatus === "due") {
    return "default"
  }

  return "secondary"
}

export function InvoiceTable({
  invoice,
}: {
  invoice: RouterOutputs["customers"]["getInvoiceById"]["invoice"]
  workspaceSlug: string
  projectSlug: string
}) {
  const formatLedger = (amount: number) => formatInvoiceMoney(amount, invoice.currency)

  return (
    <div className="mb-8">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="font-semibold">Description</TableHead>
              <TableHead className="font-semibold">Status</TableHead>
              <TableHead className="text-right font-semibold">Qty</TableHead>
              <TableHead className="text-right font-semibold">Amount</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoice.lines.length === 0 ? (
              <TableRow>
                <TableCell className="space-y-2" colSpan={5}>
                  <Typography variant="h6" affects="removePaddingMargin">
                    No billable charges
                  </Typography>
                  <span className="block font-light text-muted-foreground text-xs">
                    Statement period{" "}
                    {formatDate(
                      invoice.statementStartAt,
                      invoice.subscription.timezone,
                      "MMMM d, yyyy hh:mm a"
                    )}{" "}
                    -{" "}
                    {formatDate(
                      invoice.statementEndAt,
                      invoice.subscription.timezone,
                      "MMMM d, yyyy hh:mm a"
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ) : (
              invoice.lines.map((line) => (
                <TableRow key={line.entryId}>
                  <TableCell className="space-y-2">
                    <Typography variant="h6" affects="removePaddingMargin">
                      {line.description ?? line.kind}
                    </Typography>
                    <span className="block font-light text-muted-foreground text-xs">
                      {formatDate(
                        new Date(line.createdAt).getTime(),
                        invoice.subscription.timezone,
                        "MMMM d, yyyy hh:mm a"
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getLineStatusVariant(line)}>{getLineStatus(line)}</Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {line.quantity ?? "-"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatLedger(line.amount)}
                  </TableCell>
                  <TableCell className="text-right">
                    <ExplainChargeSheet invoice={invoice} line={line} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="mt-12 px-2">
        <div className="ml-auto max-w-xs space-y-3">
          <Separator />
          <div className="flex justify-between text-base">
            <span className="font-semibold">Gross:</span>
            <span>{formatLedger(invoice.grossAmount)}</span>
          </div>
          <div className="flex justify-between text-base">
            <span className="font-semibold">Paid:</span>
            <span>{formatLedger(invoice.amountPaid)}</span>
          </div>
          <div className="flex justify-between text-base">
            <span className="font-semibold">Included:</span>
            <span>{formatLedger(invoice.amountIncluded)}</span>
          </div>
          <div className="flex justify-between text-base">
            <span className="font-semibold">Total Due:</span>
            <span className="font-bold text-xl">{formatLedger(invoice.amountDue)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
