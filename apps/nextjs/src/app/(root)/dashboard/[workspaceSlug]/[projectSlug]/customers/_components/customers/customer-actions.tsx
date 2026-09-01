"use client"

import { ChevronDown } from "lucide-react"
import { useParams } from "next/navigation"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@unprice/ui/responsive-dialog"
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
    <ResponsiveDialog>
      <div className="button-primary flex items-center space-x-1 rounded-md">
        <ResponsiveDialogTrigger asChild>
          <Button variant={"custom"}>Edit Customer</Button>
        </ResponsiveDialogTrigger>

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
      <ResponsiveDialogContent className="md:max-w-xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Customer details</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Update the economic actor that holds subscriptions, wallet credits, runs, and invoices.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <CustomerForm defaultValues={customer} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
