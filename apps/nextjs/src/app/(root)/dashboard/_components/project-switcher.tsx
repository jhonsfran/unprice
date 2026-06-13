"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@unprice/ui/command"
import { Check, ChevronsUpDown, LayoutGrid } from "@unprice/ui/icons"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { cn } from "@unprice/ui/utils"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { revalidateAppPath } from "~/actions/revalidate"
import { SuperLink } from "~/components/super-link"
import { useTRPC } from "~/trpc/client"

export function ProjectSwitcher() {
  const trpc = useTRPC()
  const router = useRouter()
  const params = useParams()

  const projectSlug = params.projectSlug as string
  const workspaceSlug = params.workspaceSlug as string

  const { data: dataProjects } = useSuspenseQuery(
    trpc.projects.listByActiveWorkspace.queryOptions(undefined, {
      staleTime: 1000 * 60 * 60, // 1 hour
    })
  )

  const { data: dataWorkspaces } = useSuspenseQuery(
    trpc.workspaces.listWorkspacesByActiveUser.queryOptions(undefined, {
      staleTime: 1000 * 60 * 60, // 1 hour
    })
  )

  const activeWorkspace = dataWorkspaces?.workspaces.find(
    (workspace) => workspace.slug === workspaceSlug
  )

  const [switcherOpen, setSwitcherOpen] = useState(false)

  const activeProject = dataProjects?.projects.find((p) => p.slug === projectSlug)

  if (!projectSlug || !activeProject || !activeWorkspace) return null

  return (
    <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          // biome-ignore lint/a11y/useSemanticElements: <explanation>
          role="combobox"
          aria-expanded={switcherOpen}
          aria-controls="project-switcher-popup"
          aria-label="Select a project"
          className="w-36 sm:w-full"
        >
          <span className="truncate font-semibold">
            {activeProject.name}
            <Badge
              className={cn("ml-2 font-normal", {
                "border-destructive": activeProject.isMain,
              })}
              variant={activeProject.isInternal ? "destructive" : "outline"}
            >
              {activeProject.isInternal
                ? `${activeWorkspace.plan} - INTERNAL`
                : activeWorkspace.plan}
            </Badge>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent id="project-switcher-popup" className="w-56 p-0" align="start">
        <Command>
          <CommandList>
            <CommandInput placeholder="Search project..." />
            <CommandGroup heading="All projects">
              {dataProjects?.projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.slug}
                  onSelect={() => {
                    setSwitcherOpen(false)
                    revalidateAppPath(`/${project.workspace.slug}/${project.slug}`, "page")
                    router.push(`/${project.workspace.slug}/${project.slug}/dashboard`)
                  }}
                  className={cn(
                    "cursor-pointer font-semibold text-sm",
                    project.id === activeProject?.id ? "bg-background-bgActive" : "bg-transparent"
                  )}
                >
                  <div className="absolute inset-1 truncate opacity-25" />
                  {project.name}
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      project.id === activeProject?.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <CommandSeparator />
          <CommandList>
            <CommandGroup>
              <SuperLink href={`/${workspaceSlug}`}>
                <CommandItem className="cursor-pointer">
                  <LayoutGrid className="mr-2 size-4" />
                  Browse projects
                </CommandItem>
              </SuperLink>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
