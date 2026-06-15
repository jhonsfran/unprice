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
import { useParams } from "next/navigation"
import { useRouter } from "next/navigation"
import { startTransition, useState } from "react"
import { z } from "zod"
import { PropagationStopper } from "~/components/prevent-propagation"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

type PlanVersion = RouterOutputs["plans"]["getSubscriptionsBySlug"]["subscriptions"][number]
const schemaPlanVersion = z.custom<PlanVersion>()

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const { customer, ...subscription } = schemaPlanVersion.parse(row.original)
  const router = useRouter()
  const { workspaceSlug, projectSlug } = useParams()
  const [open, setOpen] = useState(false)

  const trpc = useTRPC()
  const subscriptionId = subscription.id

  const machine = useMutation(
    trpc.subscriptions.machine.mutationOptions({
      onSuccess: () => {
        router.refresh()
      },
    })
  )

  function onGenerateInvoice() {
    startTransition(() => {
      toast.promise(
        machine.mutateAsync({
          subscriptionId: subscriptionId,
          event: "invoice",
        }),
        {
          loading: "Generating invoice...",
          success: "Invoices generated",
        }
      )
    })
  }

  function onRenewSubscription() {
    startTransition(() => {
      toast.promise(
        machine.mutateAsync({
          subscriptionId: subscriptionId,
          event: "renew",
        }),
        {
          loading: "Renewing subscription...",
          success: "Subscription renewed",
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
          <DropdownMenuItem asChild>
            <SuperLink
              href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/${subscriptionId}`}
            >
              See Details
            </SuperLink>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <SuperLink
              href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/${subscriptionId}`}
            >
              Add Phase
            </SuperLink>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault()
              onRenewSubscription()
              setOpen(false)
            }}
            disabled={machine.isPending}
          >
            Renew Subscription
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault()
              onGenerateInvoice()
              setOpen(false)
            }}
            disabled={machine.isPending}
          >
            Generate Invoices
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PropagationStopper>
  )
}
