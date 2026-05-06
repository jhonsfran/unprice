import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"

import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Separator } from "@unprice/ui/separator"
import { Typography } from "@unprice/ui/typography"
import { formatDate } from "~/lib/dates"

export function InvoiceTable({
  invoice,
}: {
  invoice: RouterOutputs["customers"]["getInvoiceById"]["invoice"]
  workspaceSlug: string
  projectSlug: string
}) {
  const formatLedger = (amount: number) =>
    formatMoney(toDecimal(fromLedgerMinor(amount, invoice.currency)), invoice.currency)

  return (
    <div className="mb-8">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="font-semibold">Description</TableHead>
              <TableHead className="font-semibold">Kind</TableHead>
              <TableHead className="text-right font-semibold">Qty</TableHead>
              <TableHead className="text-right font-semibold">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoice.lines.length === 0 ? (
              <TableRow>
                <TableCell className="space-y-2" colSpan={4}>
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
                  <TableCell className="text-muted-foreground">{line.kind}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {line.quantity ?? "-"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatLedger(line.amount)}
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
            <span className="font-semibold">Total Due:</span>
            <span className="font-bold text-xl">{formatLedger(invoice.totalAmount)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
