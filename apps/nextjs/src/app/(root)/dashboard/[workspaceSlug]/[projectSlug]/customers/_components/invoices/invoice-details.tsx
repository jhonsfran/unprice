import type { RouterOutputs } from "@unprice/trpc/routes"
import { formatDate } from "~/lib/dates"

export function InvoiceDetails({
  invoice,
}: {
  invoice: RouterOutputs["customers"]["getInvoiceById"]["invoice"]
}) {
  return (
    <div className="mb-12 grid grid-cols-1 gap-8">
      {/* Invoice Info */}
      <div className="col-span-1">
        <h2 className="mb-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
          Invoice Details
        </h2>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Issue Date:</span>
            <span className="font-medium font-mono text-foreground text-xs tabular-nums">
              {invoice.issueDate
                ? formatDate(
                    invoice.issueDate,
                    invoice.subscription.timezone,
                    "MMMM d, yyyy hh:mm a"
                  )
                : "Not issued yet"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Due Date:</span>
            <span className="font-medium font-mono text-foreground text-xs tabular-nums">
              {formatDate(invoice.dueAt, invoice.subscription.timezone, "MMMM d, yyyy hh:mm a")}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Plan:</span>
            <span className="font-medium font-mono text-foreground text-xs tabular-nums">
              {invoice.subscription.planSlug}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Currency:</span>
            <span className="font-medium font-mono text-foreground text-xs tabular-nums">
              {invoice.currency}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Collection Method:</span>
            <span className="font-medium font-mono text-foreground text-xs tabular-nums">
              {invoice.collectionMethod}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Payment Provider:</span>
            <span className="font-medium font-mono text-foreground text-xs tabular-nums">
              {invoice.paymentProvider}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
