import { MoreHorizontal, PlusIcon, Settings } from "lucide-react"

import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@unprice/ui/card"
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
import { cn } from "@unprice/ui/utils"

import { SITES_BASE_DOMAIN } from "@unprice/config"
import { PropagationStopper } from "~/components/prevent-propagation"
import { SuperLink } from "~/components/super-link"
import { getStatusTone, statusToneClasses } from "~/lib/status-tones"
import { PageForm } from "./page-form"

export function PageCard(props: {
  workspaceSlug: string
  projectSlug: string
  page: RouterOutputs["pages"]["listByActiveProject"]["pages"][number]
}) {
  const { page } = props
  const domain = page.customDomain ? page.customDomain : `${page.subdomain}.${SITES_BASE_DOMAIN}`
  const publishedToneClass = statusToneClasses[getStatusTone("published")]

  return (
    <SuperLink href={`/${props.workspaceSlug}/${props.projectSlug}/pages/${page.id}`}>
      <Card className="overflow-hidden hover:border-background-borderHover">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-4">
            <CardTitle className={"line-clamp-1"}>
              <div className="flex items-center space-x-3">
                <span>{page.name}</span>
                {page.published && (
                  <Badge variant={publishedToneClass.badgeVariant} className="gap-1.5">
                    <span className={cn("size-1.5 rounded-full", publishedToneClass.dot)} />
                    <span>{"published"}</span>
                  </Badge>
                )}
              </div>
            </CardTitle>
            <CardDescription className="line-clamp-2 h-10">{page.description}</CardDescription>
          </div>
          <div className="flex items-center space-x-1">
            <PropagationStopper>
              <Dialog>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant={"ghost"}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[200px]" forceMount>
                    <DropdownMenuLabel>Page Actions</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>
                      <SuperLink
                        href={`/${props.workspaceSlug}/${props.projectSlug}/pages/${page.id}`}
                        className="flex items-center"
                      >
                        <PlusIcon className="mr-2 h-4 w-4" />
                        Publish
                      </SuperLink>
                    </DropdownMenuItem>

                    <DialogTrigger asChild>
                      <DropdownMenuItem>
                        <Settings className="mr-2 h-4 w-4" />
                        Settings
                      </DropdownMenuItem>
                    </DialogTrigger>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Page Form</DialogTitle>

                    <DialogDescription>Modify the page details below.</DialogDescription>
                  </DialogHeader>
                  <PageForm defaultValues={page} />
                </DialogContent>
              </Dialog>
            </PropagationStopper>
          </div>
        </CardHeader>
        <CardFooter className="flex flex-row justify-between space-x-4 text-muted-foreground text-sm">
          {domain}
        </CardFooter>
      </Card>
    </SuperLink>
  )
}

export function PageCardSkeleton(props: { pulse?: boolean }) {
  const { pulse = true } = props
  return (
    <Card>
      <div className={cn("h-20 bg-muted", pulse && "animate-pulse")} />
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className={cn("flex-1 bg-muted", pulse && "animate-pulse")}>&nbsp;</span>
        </CardTitle>
        <CardDescription className={cn("bg-muted", pulse && "animate-pulse")}>
          &nbsp;
        </CardDescription>
      </CardHeader>
    </Card>
  )
}
