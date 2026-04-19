import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"

import { formatMoney } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Separator } from "@unprice/ui/separator"
import { Typography } from "@unprice/ui/typography"
import { PricingItem } from "~/components/forms/pricing-item"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"

export function InvoiceTable({
  invoice,
  workspaceSlug,
  projectSlug,
}: {
  invoice: RouterOutputs["customers"]["getInvoiceById"]["invoice"]
  workspaceSlug: string
  projectSlug: string
}) {
  const basePath = `/${workspaceSlug}/${projectSlug}`

  if (invoice.invoiceItems.length === 0) {
    return null
  }

  return (
    <div className="mb-8">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="font-semibold">Description</TableHead>
              <TableHead className="text-right font-semibold">Qty</TableHead>
              <TableHead className="text-right font-semibold">Proration</TableHead>
              <TableHead className="text-right font-semibold">Amount</TableHead>
              <TableHead className="text-right font-semibold">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoice.invoiceItems.map((item) => {
              if (!item) {
                return null
              }

              return (
                <TableRow key={item.id}>
                  <TableCell className="space-y-2">
                    <span className="flex flex-row items-center gap-2">
                      {item.featurePlanVersion?.planVersion?.plan?.slug &&
                      item.featurePlanVersion?.planVersion?.id ? (
                        <SuperLink
                          href={`${basePath}/plans/${item.featurePlanVersion?.planVersion?.plan?.slug}/${item.featurePlanVersion?.planVersion?.id}`}
                          className="hover:underline"
                        >
                          <Typography variant="h6" affects="removePaddingMargin">
                            {item.description}
                          </Typography>
                        </SuperLink>
                      ) : (
                        <Typography variant="h6" affects="removePaddingMargin">
                          {item.description}
                        </Typography>
                      )}

                      {item.featurePlanVersion ? (
                        <PricingItem
                          feature={item.featurePlanVersion}
                          withCalculator={false}
                          noCheckIcon={true}
                          withQuantity={false}
                          noTitle={true}
                        />
                      ) : null}
                    </span>
                    <div className="flex flex-col">
                      <span className="block font-light text-muted-foreground text-xs">
                        {`From ${formatDate(item.cycleStartAt, invoice.subscription.timezone, "MMMM d, yyyy hh:mm a")}`}
                      </span>
                      <span className="block font-light text-muted-foreground text-xs">
                        {`To ${formatDate(item.cycleEndAt, invoice.subscription.timezone, "MMMM d, yyyy hh:mm a")}`}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {item.quantity}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {Intl.NumberFormat("en-US", {
                      style: "decimal",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).format(item.prorationFactor)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoney((item.amountSubtotal / 100).toString(), invoice.currency)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoney((item.amountTotal / 100).toString(), invoice.currency)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <div className="mt-12 px-2">
        <div className="ml-auto max-w-xs space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Subtotal:</span>
            <span className="font-medium">
              {formatMoney((invoice.subtotalCents / 100).toString(), invoice.currency)}
            </span>
          </div>
          <Separator />
          <div className="flex justify-between text-base">
            <span className="font-semibold">Total Due:</span>
            <span className="font-bold text-xl">
              {formatMoney((invoice.totalCents / 100).toString(), invoice.currency)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
