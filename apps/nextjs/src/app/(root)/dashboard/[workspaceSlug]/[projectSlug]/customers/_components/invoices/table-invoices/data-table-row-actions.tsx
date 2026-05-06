"use client"

import type { Row } from "@tanstack/react-table"
import { Button } from "@unprice/ui/button"

import { useMutation } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { MoreVertical } from "lucide-react"
import { useRouter } from "next/navigation"
import { startTransition, useState } from "react"
import { z } from "zod"
import { PropagationStopper } from "~/components/prevent-propagation"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

type SubscriptionInvoice =
  RouterOutputs["customers"]["getSubscriptions"]["customer"]["invoices"][number]
const schemaSubscriptionInvoice = z.custom<SubscriptionInvoice>()

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const invoice = schemaSubscriptionInvoice.parse(row.original)
  const [open, setOpen] = useState(false)

  const router = useRouter()
  const trpc = useTRPC()
  const subscriptionId = invoice.subscriptionId
  const invoiceId = invoice.id
  const canFinalize = invoice.status === "draft" && invoice.dueAt <= Date.now()
  const finalizeReadyAt = new Date(invoice.dueAt).toLocaleString()
  const finalizeBlockedMessage =
    invoice.status === "draft"
      ? `Invoice is not ready to finalize yet. Try again after ${finalizeReadyAt}.`
      : "Only draft invoices can be finalized."

  const machine = useMutation(trpc.subscriptions.machine.mutationOptions({}))

  function onFinalizeInvoice() {
    startTransition(() => {
      toast.promise(
        machine
          .mutateAsync({
            subscriptionId: subscriptionId,
            event: "finalize_invoice",
            invoiceId: invoiceId,
          })
          .then(() => {
            router.refresh()
          }),
        {
          loading: "Finalizing invoice...",
          success: "Invoice finalized",
        }
      )
    })
  }

  function onCollectPayment() {
    startTransition(() => {
      toast.promise(
        machine
          .mutateAsync({
            subscriptionId: subscriptionId,
            event: "collect_payment",
            invoiceId: invoiceId,
          })
          .then(() => {
            router.refresh()
          }),
        {
          loading: "Collecting payment...",
          success: "Payment collected",
        }
      )
    })
  }

  return (
    <PropagationStopper>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button aria-haspopup="true" size="icon" variant="ghost">
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Toggle menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault()

              if (!canFinalize) {
                toast.error(finalizeBlockedMessage)
                setOpen(false)
                return
              }

              onFinalizeInvoice()
              setOpen(false)
            }}
            disabled={machine.isPending}
          >
            Finalize Invoice
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault()
              onCollectPayment()
              setOpen(false)
            }}
            disabled={machine.isPending}
          >
            Collect Payment
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PropagationStopper>
  )
}
