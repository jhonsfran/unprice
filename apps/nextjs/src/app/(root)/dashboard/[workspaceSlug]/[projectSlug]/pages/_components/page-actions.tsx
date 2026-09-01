"use client"

import { useState } from "react"

import { Button } from "@unprice/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { ChevronDown, ExternalLink } from "lucide-react"

import { SITES_BASE_DOMAIN } from "@unprice/config"
import type { Page } from "@unprice/db/validators"
import { SuperLink } from "~/components/super-link"
import { PageForm } from "./page-form"
import { PagePublish } from "./page-publish"

export function PageActions({
  page,
}: {
  page: Page
}) {
  const isHTTPS = process.env.NODE_ENV === "production"
  const domain = page.customDomain
    ? `${isHTTPS ? "https" : "http"}://${page.customDomain}`
    : `${isHTTPS ? "https" : "http"}://${page.subdomain}.${SITES_BASE_DOMAIN}`

  const [isOpen, setIsOpen] = useState(false)
  const [isOpenDialog, setIsOpenDialog] = useState(false)

  return (
    <ResponsiveDialog onOpenChange={setIsOpenDialog} open={isOpenDialog}>
      <DropdownMenu onOpenChange={setIsOpen} open={isOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant={"custom"}>
            <span className="sr-only">Actions</span>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44" align="end">
          <ResponsiveDialogTrigger asChild>
            <DropdownMenuItem>Edit page</DropdownMenuItem>
          </ResponsiveDialogTrigger>
          <ResponsiveDialogTrigger asChild>
            <DropdownMenuItem asChild>
              <PagePublish
                pageId={page.id}
                variant="custom"
                onConfirmAction={() => setIsOpen(false)}
                classNames="w-full relative flex cursor-pointer justify-start select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-background-bgHover hover:text-background-textContrast font-normal"
              />
            </DropdownMenuItem>
          </ResponsiveDialogTrigger>

          <DropdownMenuItem>
            <SuperLink href={`${domain}`} target="_blank" className="flex items-center">
              See page
              <ExternalLink className="ml-2 h-4 w-4" />
            </SuperLink>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Plan Form</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>Modify the plan details below.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <PageForm defaultValues={page} setDialogOpen={setIsOpenDialog} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
