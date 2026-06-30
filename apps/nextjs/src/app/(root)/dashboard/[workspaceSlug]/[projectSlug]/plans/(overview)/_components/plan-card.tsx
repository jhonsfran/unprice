import { GalleryHorizontalEnd, MoreVertical, Settings } from "lucide-react"

import type { RouterOutputs } from "@unprice/trpc/routes"
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
import { SuperLink } from "~/components/super-link"
import { PlanForm } from "../../_components/plan-form"

export function PlanCard(props: {
  workspaceSlug: string
  projectSlug: string
  plan: RouterOutputs["plans"]["listByActiveProject"]["plans"][number]
}) {
  const { plan } = props
  const { versions, ...rest } = plan

  return (
    <Card className="relative overflow-hidden hover:border-background-borderHover">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <SuperLink
          href={`/${props.workspaceSlug}/${props.projectSlug}/plans/${plan.slug}`}
          className="min-w-0 flex-1 after:absolute after:inset-0"
        >
          <CardTitle className="line-clamp-1">
            <div className="flex items-center space-x-3">
              <span>{plan.title}</span>
              {plan.defaultPlan && (
                <div className="inline-flex items-center font-mono font-semibold text-info text-xs">
                  <span className="flex h-2 w-2 rounded-full bg-info" />
                  <span className="ml-1">{"default"}</span>
                </div>
              )}
              {plan.enterprisePlan && (
                <div className="inline-flex items-center font-mono font-semibold text-info text-xs">
                  <span className="flex h-2 w-2 rounded-full bg-info" />
                  <span className="ml-1">{"enterprise"}</span>
                </div>
              )}
            </div>
          </CardTitle>
          <CardDescription className="line-clamp-2 h-10">{plan.description}</CardDescription>
        </SuperLink>
        <Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="relative z-10 size-8">
                <MoreVertical className="size-4" aria-hidden="true" />
                <span className="sr-only">Open plan actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[200px]" forceMount>
              <DropdownMenuLabel>Plan Actions</DropdownMenuLabel>
              <DropdownMenuSeparator />

              <DialogTrigger asChild>
                <DropdownMenuItem>
                  <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
                  Edit plan
                </DropdownMenuItem>
              </DialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>

          <DialogContent className="max-h-screen overflow-y-scroll">
            <DialogHeader>
              <DialogTitle>Plan Form</DialogTitle>

              <DialogDescription>Modify the plan details below.</DialogDescription>
            </DialogHeader>
            <PlanForm defaultValues={rest} />
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardFooter className="flex flex-row justify-between space-x-4 text-muted-foreground text-sm">
        <div className="flex items-center text-muted-foreground text-xs">
          <GalleryHorizontalEnd className="mr-2 h-3 w-3" aria-hidden="true" />
          {versions.length === 0 ? "no" : versions.length} versions published
        </div>
      </CardFooter>
    </Card>
  )
}

export function PlanCardSkeleton(props: { pulse?: boolean }) {
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
