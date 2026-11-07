"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Event } from "@unprice/db/validators"
import { Badge } from "@unprice/ui/badge"
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
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { cn } from "@unprice/ui/utils"
import { CheckIcon, ChevronDown, Plus } from "lucide-react"
import { type ComponentProps, useId, useState } from "react"

import { FilterScroll } from "~/components/filter-scroll"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { eventCreateOption, eventMatches } from "./event-options"

/**
 * The project's events as a searchable picker. A typed name no event carries ends the list with
 * one entry that creates it: Enter or a click saves the event under that name and its derived
 * slug, with no properties, and picks it. `none` leads the list with a way to pick no event.
 */
export function EventPicker({
  selectedEventId,
  fallbackSlug,
  onPick,
  none,
  isDisabled,
  className,
  ...triggerProps
}: {
  selectedEventId?: string
  /** The stored slug, shown while the list has not resolved it or no longer carries it. */
  fallbackSlug?: string
  onPick: (event: Event) => void
  /** An entry before the events that picks none, such as "Not metered". */
  none?: { label: string; onSelect: () => void }
  isDisabled?: boolean
} & Omit<ComponentProps<typeof Button>, "onSelect" | "children" | "disabled">) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const popupId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const { data, isLoading } = useQuery(trpc.events.listByActiveProject.queryOptions())
  const events = data?.events ?? []
  const selected = events.find((event) => event.id === selectedEventId)
  const matches = events.filter((event) => eventMatches(query, event))
  const creatable = eventCreateOption(query, events)

  const close = () => {
    setOpen(false)
    setQuery("")
  }
  const pick = (event: Event) => {
    onPick(event)
    close()
  }

  const createEvent = useMutation(
    trpc.events.create.mutationOptions({
      onSuccess: ({ event }) => {
        queryClient.setQueryData(trpc.events.listByActiveProject.queryKey(), (cached) =>
          cached ? { ...cached, events: [...cached.events, event] } : cached
        )
        void queryClient.invalidateQueries({
          queryKey: trpc.events.listByActiveProject.queryKey(),
        })
        toastAction("saved", `Event ${event.slug} created`)
        pick(event)
      },
    })
  )

  return (
    <Popover
      modal={true}
      open={open}
      onOpenChange={(next) => {
        if (isDisabled) return
        if (next) setOpen(true)
        else close()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          // biome-ignore lint/a11y/useSemanticElements: Button trigger matches the shared searchable picker pattern used across the app.
          role="combobox"
          aria-expanded={open}
          aria-controls={popupId}
          disabled={isDisabled}
          className={cn("h-9 w-full justify-between gap-2 px-3 font-normal", className)}
          {...triggerProps}
        >
          {isLoading ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <LoadingAnimation className="size-4" variant="dots" />
              <span className="text-muted-foreground text-sm">Loading events...</span>
            </div>
          ) : selected ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="truncate">{selected.name}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {selected.slug}
              </span>
            </div>
          ) : fallbackSlug ? (
            <span className="truncate text-left font-mono text-sm">{fallbackSlug}</span>
          ) : none ? (
            <span className="truncate text-left text-sm">{none.label}</span>
          ) : (
            <span className="text-muted-foreground text-sm">Select or create an event</span>
          )}
          <ChevronDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={popupId}
        align="start"
        className="max-h-[--radix-popover-content-available-height] w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            className="h-9 py-2 text-sm"
            placeholder="Search or name a new event"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="overflow-hidden">
            {isLoading ? (
              <CommandLoading>Loading events...</CommandLoading>
            ) : (
              <CommandEmpty>No event matches.</CommandEmpty>
            )}
            <FilterScroll>
              <CommandGroup className="p-1">
                {none && !query.trim() && (
                  <CommandItem
                    value="__none"
                    className="gap-2 rounded-md px-2.5 py-2"
                    onSelect={() => {
                      none.onSelect()
                      close()
                    }}
                  >
                    <CheckIcon
                      className={cn(
                        "size-4 shrink-0",
                        !selectedEventId && !fallbackSlug ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate text-sm">{none.label}</span>
                  </CommandItem>
                )}
                {matches.map((event) => {
                  const propertyCount = (event.availableProperties ?? []).length
                  return (
                    <CommandItem
                      key={event.id}
                      value={event.id}
                      className="gap-2 rounded-md px-2.5 py-2"
                      onSelect={() => pick(event)}
                    >
                      <CheckIcon
                        className={cn(
                          "size-4 shrink-0",
                          event.id === selected?.id ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate font-medium text-sm">{event.name}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {event.slug}
                        </span>
                      </div>
                      {propertyCount > 0 && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 rounded-sm px-1.5 py-0 text-[10px]"
                        >
                          {propertyCount} {propertyCount === 1 ? "field" : "fields"}
                        </Badge>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </FilterScroll>
            {creatable && (
              <>
                <CommandSeparator />
                <CommandGroup className="p-1">
                  <CommandItem
                    value="__create"
                    disabled={createEvent.isPending}
                    className="gap-2 rounded-md px-2.5 py-2"
                    onSelect={() =>
                      createEvent.mutate({
                        name: creatable.name,
                        slug: creatable.slug,
                        availableProperties: [],
                      })
                    }
                  >
                    <Plus className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm">
                      {createEvent.isPending ? `Creating ${creatable.slug}...` : creatable.label}
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
