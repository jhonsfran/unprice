import { notFound } from "next/navigation"
import HeaderTab from "~/components/layout/header-tab"
import { api } from "~/trpc/server"
import { InvoiceActions } from "../../../_components/invoices/invoice-actions"
import { InvoiceDetails } from "../../../_components/invoices/invoice-details"
import { InvoiceTable } from "../../../_components/invoices/invoice-table"

export default async function InvoicePage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
    invoiceId: string
  }
}) {
  const { invoice } = await api.customers.getInvoiceById({
    customerId: params.customerId,
    invoiceId: params.invoiceId,
  })

  if (!invoice) {
    notFound()
  }

  return (
    <>
      <HeaderTab
        title={"INVOICE"}
        description={`Invoice date: ${invoice.statementDateString}`}
        label={invoice.status}
        id={invoice.id}
        action={<InvoiceActions invoice={invoice} />}
      />
      <div className="mt-4 flex flex-col gap-4 px-1 py-4">
        <InvoiceDetails invoice={invoice} />
        <InvoiceTable
          invoice={invoice}
          workspaceSlug={params.workspaceSlug}
          projectSlug={params.projectSlug}
        />
      </div>
    </>
  )
}
