"use client"
import { useSuspenseQuery } from "@tanstack/react-query"
import { Avatar, AvatarFallback, AvatarImage } from "@unprice/ui/avatar"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@unprice/ui/command"
import { Check, ChevronsUpDown, PlusCircle } from "@unprice/ui/icons"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { revalidateAppPath } from "~/actions/revalidate"
import { FilterScroll } from "~/components/filter-scroll"
import { SuperLink } from "~/components/super-link"
import { useFlags } from "~/hooks/use-flags"
import { useTRPC } from "~/trpc/client"
import { WorkspaceSwitcherSkeleton } from "./workspace-switcher-skeleton"

export function WorkspaceSwitcher({
  workspaceSlug,
}: {
  workspaceSlug: string
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const [switcherOpen, setSwitcherOpen] = useState(false)

  const isProEnabled = useFlags("ACCESS_PRO")

  const { data: dataWorkspaces } = useSuspenseQuery(
    trpc.workspaces.listWorkspacesByActiveUser.queryOptions(undefined, {
      staleTime: 1000 * 60 * 60, // 1 hour
    })
  )

  const activeWorkspace = dataWorkspaces?.workspaces.find(
    (workspace) => workspace.slug === workspaceSlug
  )

  const personalWorkspace = dataWorkspaces?.workspaces.find((wk) => wk.isPersonal)
  const teams = dataWorkspaces?.workspaces.filter((wk) => !wk.isPersonal)

  if (!activeWorkspace) {
    return <WorkspaceSwitcherSkeleton />
  }

  return (
    <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          // biome-ignore lint/a11y/useSemanticElements: <explanation>
          role="combobox"
          aria-expanded={switcherOpen}
          aria-controls="workspace-switcher-popup"
          aria-label="Select a workspace"
          className="w-36 sm:w-full"
        >
          <Avatar className="mr-2 h-5 w-5">
            <AvatarImage
              src={
                activeWorkspace.imageUrl && activeWorkspace.imageUrl !== ""
                  ? activeWorkspace.imageUrl
                  : `https://avatar.vercel.sh/${activeWorkspace.id}`
              }
              alt={`user-${activeWorkspace.name}`}
            />
            <AvatarFallback>{activeWorkspace.slug?.substring(0, 2)}</AvatarFallback>
          </Avatar>
          <span className="truncate font-semibold">
            {activeWorkspace.name}
            <Badge
              className={cn("ml-2 font-mono font-normal", {
                "border-destructive": activeWorkspace.isMain,
              })}
              variant={activeWorkspace.isMain ? "destructive" : "outline"}
            >
              {activeWorkspace.isInternal
                ? `${activeWorkspace.plan} - INTERNAL`
                : activeWorkspace.plan}
            </Badge>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent id="workspace-switcher-popup" className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search workspace..." />
          <CommandList className="overflow-hidden">
            <CommandEmpty>No workspace found.</CommandEmpty>
            <FilterScroll>
              {personalWorkspace && (
                <CommandGroup heading="Personal workspace">
                  <CommandItem
                    key={personalWorkspace.id}
                    value={personalWorkspace.id}
                    onSelect={() => {
                      setSwitcherOpen(false)
                      revalidateAppPath(`/${personalWorkspace.slug}`, "page")
                      router.push(`/${personalWorkspace.slug}`)
                    }}
                    className={cn(
                      "cursor-pointer font-semibold text-sm",
                      activeWorkspace.id === personalWorkspace.id
                        ? "bg-background-bgActive"
                        : "bg-transparent"
                    )}
                  >
                    <Avatar className="mr-2 h-5 w-5">
                      <AvatarImage
                        src={
                          personalWorkspace.imageUrl && personalWorkspace.imageUrl !== ""
                            ? personalWorkspace.imageUrl
                            : `https://avatar.vercel.sh/${personalWorkspace.id}`
                        }
                        alt={`user-${personalWorkspace.name}`}
                      />
                      <AvatarFallback>{personalWorkspace.slug?.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <span className="z-10 truncate font-semibold">{personalWorkspace.name}</span>
                    <Check
                      className={cn(
                        "ml-auto h-4 w-4",
                        activeWorkspace.id === personalWorkspace.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </CommandItem>
                </CommandGroup>
              )}

              {teams && teams.length > 0 && (
                <CommandGroup heading="Workspaces">
                  {teams?.map((workspace) => (
                    <CommandItem
                      key={workspace.id}
                      value={workspace.id}
                      onSelect={() => {
                        setSwitcherOpen(false)
                        router.push(`/${workspace.slug}`)
                      }}
                      className={cn(
                        "cursor-pointer font-semibold text-sm",
                        activeWorkspace?.id === workspace.id
                          ? "bg-background-bgActive"
                          : "bg-transparent"
                      )}
                    >
                      <Avatar className="mr-2 h-5 w-5">
                        <AvatarImage
                          src={
                            workspace.imageUrl && workspace.imageUrl !== ""
                              ? workspace.imageUrl
                              : `https://avatar.vercel.sh/${workspace.id}`
                          }
                          alt={`user-${workspace.name}`}
                        />
                        <AvatarFallback>{workspace.slug.substring(0, 2)}</AvatarFallback>
                      </Avatar>
                      <span className="z-10 truncate font-semibold">{workspace.name}</span>
                      <Check
                        className={cn(
                          "ml-auto h-4 w-4",
                          activeWorkspace?.id === workspace.id ? "opacity-100" : "opacity-0"
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </FilterScroll>
          </CommandList>
          <CommandSeparator />
          <CommandList>
            <CommandGroup>
              {!isProEnabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SuperLink href="#" className="cursor-not-allowed">
                      <CommandItem className="cursor-not-allowed" disabled>
                        <PlusCircle className="mr-2 size-4" />
                        Create Workspace
                      </CommandItem>
                    </SuperLink>
                  </TooltipTrigger>
                  <TooltipContent align="start" side="bottom" sideOffset={10} alignOffset={-5}>
                    <div className="flex max-w-[200px] flex-col gap-4 py-2">
                      <Typography variant="p" className="text-center">
                        {"This feature is not available on your current plan"}
                      </Typography>
                      <Button variant="primary" size="sm" className="mx-auto w-2/3">
                        Upgrade
                      </Button>
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <SuperLink href="/new">
                  <CommandItem className="cursor-pointer">
                    <PlusCircle className="mr-2 size-4" />
                    Create Workspace
                  </CommandItem>
                </SuperLink>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
