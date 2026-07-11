"use client"

import { ChevronDown } from "lucide-react"
import { useParams } from "next/navigation"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { Separator } from "@unprice/ui/separator"
import { SuperLink } from "~/components/super-link"
import { CustomerForm } from "./customer-form"

export function CustomerActions({
  customer,
}: {
  customer: RouterOutputs["customers"]["getById"]["customer"]
}) {
  const { workspaceSlug, projectSlug } = useParams<{
    workspaceSlug: string
    projectSlug: string
  }>()

  const addSubscriptionHref = `/${workspaceSlug}/${projectSlug}/customers/subscriptions/new?customerId=${customer.id}`

  return (
    <Dialog>
      <div className="button-primary flex items-center space-x-1 rounded-md">
        <DialogTrigger asChild>
          <Button variant={"custom"}>Edit Customer</Button>
        </DialogTrigger>

        <Separator orientation="vertical" className="h-[20px] p-0" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={"custom"}>
              <span className="sr-only">More actions</span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>More actions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <SuperLink href={addSubscriptionHref}>Add subscription</SuperLink>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DialogContent className="md:max-w-xl">
        <DialogHeader>
          <DialogTitle>Customer details</DialogTitle>
          <DialogDescription>
            Update the economic actor that holds subscriptions, wallet credits, runs, and invoices.
          </DialogDescription>
        </DialogHeader>
        <CustomerForm defaultValues={customer} />
      </DialogContent>
    </Dialog>
  )
}
