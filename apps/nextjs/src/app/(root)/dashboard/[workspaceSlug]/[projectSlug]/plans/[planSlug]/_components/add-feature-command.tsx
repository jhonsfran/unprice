"use client"

import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useState } from "react"

import { slugify } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
  CommandSeparator,
} from "@unprice/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"

import { useDebounce } from "~/hooks/use-debounce"
import { useTRPC } from "~/trpc/client"
import { FeatureDialog } from "../../_components/feature-dialog"
import { useAttachFeature } from "./use-attach-feature"

type PlanVersion = RouterOutputs["planVersions"]["getById"]["planVersion"]
type LibraryFeature = RouterOutputs["features"]["searchBy"]["features"][number]

/**
 * "Add feature": a palette over the project's features. Enter or a click attaches one to the open
 * draft; the last entry creates what was typed and attaches it on create.
 */
export function AddFeatureCommand({ planVersion }: { planVersion: PlanVersion }) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const search = useDebounce(query.trim(), 300)
  const { attach, attachedFeatureIds } = useAttachFeature(planVersion)

  const { data, isFetching } = useQuery({
    ...trpc.features.searchBy.queryOptions({ search }),
    enabled: open,
  })
  const features = (data?.features ?? []).filter(
    (feature) => !attachedFeatureIds.includes(feature.id)
  )

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Plus className="size-3.5" strokeWidth={1.5} />
            Add feature
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[360px] p-0">
          <AddFeatureCommandView
            query={query}
            onQueryChange={setQuery}
            features={features}
            isLoading={isFetching && data === undefined}
            onPick={(feature) => {
              attach(feature)
              setOpen(false)
              setQuery("")
            }}
            onCreate={() => {
              setOpen(false)
              setCreating(true)
            }}
          />
        </PopoverContent>
      </Popover>
      <FeatureDialog
        open={creating}
        onOpenChange={(next) => {
          setCreating(next)
          if (!next) setQuery("")
        }}
        defaultValues={{ title: query.trim(), slug: slugify(query.trim()), description: "" }}
        onCreated={attach}
      />
    </>
  )
}

/** The palette with fixed data: the matches, then the entry that creates what was typed. */
export function AddFeatureCommandView({
  query,
  onQueryChange,
  features,
  isLoading,
  onPick,
  onCreate,
}: {
  query: string
  onQueryChange: (query: string) => void
  features: readonly LibraryFeature[]
  isLoading: boolean
  onPick: (feature: LibraryFeature) => void
  onCreate: () => void
}) {
  const trimmed = query.trim()

  return (
    <Command shouldFilter={false}>
      <CommandInput
        className="h-9 text-sm"
        placeholder="Search features"
        value={query}
        onValueChange={onQueryChange}
        autoFocus
      />
      <CommandList>
        {isLoading ? (
          <CommandLoading>Loading features</CommandLoading>
        ) : (
          <CommandEmpty>
            {trimmed ? `No feature matches "${trimmed}".` : "Every feature is attached."}
          </CommandEmpty>
        )}
        {features.length > 0 && (
          <CommandGroup>
            {features.map((feature) => (
              <CommandItem
                key={feature.id}
                value={feature.id}
                className="cursor-pointer gap-2"
                onSelect={() => onPick(feature)}
              >
                <span className="truncate text-sm">{feature.title}</span>
                <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
                  {feature.slug}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {/* Mounted only once the matches are in: while they load it would be the only item, cmdk
            would keep it selected when they arrive, and Enter would create instead of attaching. */}
        {!isLoading && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__create" className="cursor-pointer gap-2" onSelect={onCreate}>
                <Plus className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                <span className="truncate text-sm">
                  {trimmed ? `Create "${trimmed}"` : "Create a feature"}
                </span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  )
}
