"use client"

import { useEffect, useMemo, useState } from "react"
import type { UseFormReturn } from "react-hook-form"

import { useQuery } from "@tanstack/react-query"
import { AGGREGATION_METHODS, AGGREGATION_METHODS_MAP } from "@unprice/db/utils"
import type { AggregationMethod, Event, PlanVersionFeatureInsert } from "@unprice/db/validators"
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
} from "@unprice/ui/command"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { CheckIcon, ChevronDown, HelpCircle, Pencil, Plus } from "lucide-react"
import { FilterScroll } from "~/components/filter-scroll"
import { useTRPC } from "~/trpc/client"
import { DimensionChips } from "./dimension-chips"
import { EventFormDialog } from "./event-dialog"
import { aggregationFieldFor, meterDefaultsFor, requiresAggregationField } from "./meter-defaults"

const EVENT_PICKER_SEARCH_THRESHOLD = 6

export function MeterConfigFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
}) {
  const trpc = useTRPC()
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [eventDialogMode, setEventDialogMode] = useState<"create" | "edit">("create")
  const [isEventDialogOpen, setIsEventDialogOpen] = useState(false)
  const meterConfig = form.watch("meterConfig")
  const { data: eventsData, isLoading } = useQuery(trpc.events.listByActiveProject.queryOptions())
  const events = eventsData?.events ?? []

  const selectedEvent = useMemo(() => {
    return (
      events.find((event) => event.id === meterConfig?.eventId) ??
      events.find((event) => event.slug === meterConfig?.eventSlug)
    )
  }, [events, meterConfig?.eventId, meterConfig?.eventSlug])

  // The method picked before an event is, since the meter cannot be written without one.
  const [draftAggregationMethod, setDraftAggregationMethod] = useState<AggregationMethod>(
    meterConfig?.aggregationMethod ?? "sum"
  )

  const selectedAggregationMethod = meterConfig?.aggregationMethod ?? draftAggregationMethod
  const needsAggregationField = requiresAggregationField(selectedAggregationMethod)
  const selectedEventProperties = selectedEvent?.availableProperties ?? []
  const selectedAggregationConfig = AGGREGATION_METHODS_MAP[selectedAggregationMethod]
  const shouldShowEventSearch = events.length > EVENT_PICKER_SEARCH_THRESHOLD

  const setMeterConfigValue = (next: {
    event?: Event
    aggregationMethod?: AggregationMethod
    aggregationField?: string
  }) => {
    const event = next.event ?? selectedEvent
    const aggregationMethod = next.aggregationMethod ?? selectedAggregationMethod
    const aggregationField =
      next.aggregationField ??
      aggregationFieldFor(
        event?.availableProperties ?? [],
        aggregationMethod,
        meterConfig?.aggregationField
      )

    if (!event?.id) {
      return
    }

    form.setValue(
      "meterConfig",
      {
        eventId: event.id,
        eventSlug: event.slug,
        aggregationMethod,
        ...(aggregationField ? { aggregationField } : {}),
        ...(meterConfig?.groupBy?.length ? { groupBy: meterConfig.groupBy } : {}),
      },
      {
        shouldDirty: true,
        shouldValidate: true,
      }
    )
  }

  const handleDimensionsChange = (groupBy: string[]) => {
    form.setValue("meterConfig.groupBy", groupBy.length > 0 ? groupBy : undefined, {
      shouldDirty: true,
      shouldValidate: true,
    })
    // A row with dimensions is a unit price, so tiers and packages need a meter without them.
    if (groupBy.length > 0 && form.getValues("config.usageMode") !== "unit") {
      form.setValue("config.usageMode", "unit", { shouldDirty: true, shouldValidate: true })
    }
  }

  const handleAggregationMethodChange = (value: AggregationMethod) => {
    setDraftAggregationMethod(value)

    if (!selectedEvent?.id) {
      return
    }

    setMeterConfigValue({
      event: selectedEvent,
      aggregationMethod: value,
      aggregationField: aggregationFieldFor(
        selectedEventProperties,
        value,
        meterConfig?.aggregationField
      ),
    })
  }

  // Picking or creating an event sets the meter that fits it: Count for an event without a
  // number, else the current method over the event's property.
  const handleEventChosen = (event: Event) => {
    const defaults = meterDefaultsFor(event, {
      aggregationMethod: selectedAggregationMethod,
      aggregationField: meterConfig?.aggregationField,
    })
    setDraftAggregationMethod(defaults.aggregationMethod)
    setMeterConfigValue({ event, ...defaults })
  }

  const handleEventSaved = async (event: Event) => {
    if (isDisabled) {
      return
    }

    handleEventChosen(event)
  }

  // A stored meter whose field the event no longer carries (or never did) aggregates the event's
  // first property, so the form validates against what the event can send.
  useEffect(() => {
    if (!selectedEvent?.id || !needsAggregationField || selectedEventProperties.length === 0) {
      return
    }

    const field = aggregationFieldFor(
      selectedEventProperties,
      selectedAggregationMethod,
      meterConfig?.aggregationField
    )

    if (!field || meterConfig?.aggregationField === field) {
      return
    }

    form.setValue(
      "meterConfig",
      {
        eventId: selectedEvent.id,
        eventSlug: selectedEvent.slug,
        aggregationMethod: selectedAggregationMethod,
        aggregationField: field,
        ...(meterConfig?.groupBy?.length ? { groupBy: meterConfig.groupBy } : {}),
      },
      {
        shouldDirty: false,
        shouldValidate: true,
      }
    )
  }, [
    form,
    meterConfig?.aggregationField,
    meterConfig?.groupBy,
    needsAggregationField,
    selectedAggregationMethod,
    selectedEvent?.id,
    selectedEvent?.slug,
    selectedEventProperties,
  ])

  return (
    <>
      <div className="space-y-3">
        <FormField
          control={form.control}
          name="meterConfig.eventId"
          render={() => (
            <FormItem className="flex flex-col">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1">
                  <FormLabel>Event</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[250px]">
                      The SDK event this feature listens to. The event slug is snapshotted into the
                      plan version feature for fast routing later.
                    </TooltipContent>
                  </Tooltip>
                </div>
                {selectedEvent?.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEventDialogMode("edit")
                      setIsEventDialogOpen(true)
                    }}
                  >
                    <Pencil className="mr-1.5 size-3" />
                    {isDisabled ? "View event" : "Edit event"}
                  </Button>
                )}
              </div>

              <Popover
                modal={true}
                open={isPickerOpen}
                onOpenChange={(open) => {
                  if (isDisabled) {
                    return
                  }

                  setIsPickerOpen(open)
                }}
              >
                <PopoverTrigger asChild>
                  <FormControl>
                    <Button
                      type="button"
                      variant="outline"
                      // biome-ignore lint/a11y/useSemanticElements: Button trigger matches the shared searchable picker pattern used across the app.
                      role="combobox"
                      aria-expanded={isPickerOpen}
                      aria-controls="meter-event-picker-popup"
                      disabled={isDisabled}
                      className="h-9 w-full justify-between gap-2 px-3 font-normal"
                    >
                      {isLoading ? (
                        <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          <LoadingAnimation className="size-4" variant="dots" />
                          <span className="text-muted-foreground text-sm">Loading events...</span>
                        </div>
                      ) : selectedEvent ? (
                        <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          <span className="truncate">{selectedEvent.name}</span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {selectedEvent.slug}
                          </span>
                        </div>
                      ) : meterConfig?.eventSlug ? (
                        <span className="truncate text-left font-mono text-sm">
                          {meterConfig.eventSlug}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">
                          Select or create an event
                        </span>
                      )}
                      <ChevronDown className="ml-2 size-4 shrink-0 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent
                  id="meter-event-picker-popup"
                  align="start"
                  className="max-h-[--radix-popover-content-available-height] w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    {shouldShowEventSearch ? (
                      <CommandInput className="h-9 py-2 text-sm" placeholder="Search events" />
                    ) : null}
                    <CommandList className="overflow-hidden">
                      <CommandEmpty>No events found.</CommandEmpty>
                      <FilterScroll>
                        <CommandGroup className="p-1">
                          {isLoading && <CommandLoading>Loading...</CommandLoading>}
                          {events.map((event) => {
                            const propertyCount = (event.availableProperties ?? []).length

                            return (
                              <CommandItem
                                key={event.id}
                                value={`${event.name} ${event.slug} ${(event.availableProperties ?? []).join(" ")}`}
                                className="gap-2 rounded-md px-2.5 py-2"
                                onSelect={() => {
                                  handleEventChosen(event)
                                  setIsPickerOpen(false)
                                }}
                              >
                                <CheckIcon
                                  className={cn(
                                    "size-4 shrink-0",
                                    event.id === selectedEvent?.id ? "opacity-100" : "opacity-0"
                                  )}
                                />
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="truncate font-medium text-sm">{event.name}</span>
                                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                                    {event.slug}
                                  </span>
                                </div>
                                {propertyCount > 0 ? (
                                  <Badge
                                    variant="secondary"
                                    className="shrink-0 rounded-sm px-1.5 py-0 text-[10px]"
                                  >
                                    {propertyCount} {propertyCount === 1 ? "field" : "fields"}
                                  </Badge>
                                ) : null}
                              </CommandItem>
                            )
                          })}
                        </CommandGroup>
                      </FilterScroll>
                    </CommandList>
                  </Command>
                  <div className="border-t p-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-full justify-start px-2"
                      disabled={isDisabled}
                      onClick={() => {
                        setEventDialogMode("create")
                        setIsEventDialogOpen(true)
                        setIsPickerOpen(false)
                      }}
                    >
                      <Plus className="mr-2 size-4" />
                      Create event
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>

              <FormMessage />
            </FormItem>
          )}
        />

        <div
          className={cn(
            "grid gap-4",
            selectedEvent?.id && needsAggregationField ? "md:grid-cols-2" : "md:grid-cols-1"
          )}
        >
          <FormField
            control={form.control}
            name="meterConfig.aggregationMethod"
            render={() => (
              <FormItem className="flex flex-col">
                <div className="mb-2 flex items-center gap-1">
                  <FormLabel>Aggregation method</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[320px]">
                      Choose how this feature interprets matched events. Count-based methods do not
                      need a numeric field; sum, max, and latest do.
                    </TooltipContent>
                  </Tooltip>
                </div>

                <Select
                  value={selectedAggregationMethod ?? ""}
                  onValueChange={(value) =>
                    handleAggregationMethodChange(value as AggregationMethod)
                  }
                  disabled={isDisabled}
                >
                  <FormControl>
                    <SelectTrigger disabled={isDisabled}>
                      <SelectValue placeholder="Select aggregation method" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="text-xs">
                    {AGGREGATION_METHODS.map((mode) => (
                      <SelectItem
                        value={mode}
                        key={mode}
                        description={AGGREGATION_METHODS_MAP[mode].description}
                      >
                        {AGGREGATION_METHODS_MAP[mode].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <FormMessage />
              </FormItem>
            )}
          />

          {selectedEvent?.id && needsAggregationField && (
            <FormField
              control={form.control}
              name="meterConfig.aggregationField"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <div className="mb-2 flex items-center gap-1">
                    <FormLabel>Aggregation field</FormLabel>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="size-3.5 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[250px]">
                        Pick the numeric property from the event payload to aggregate, like
                        input_tokens or value.
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {selectedEventProperties.length > 1 ? (
                    <Select
                      value={field.value ?? ""}
                      onValueChange={(value) => {
                        if (!selectedEvent?.id) {
                          return
                        }

                        setMeterConfigValue({
                          event: selectedEvent,
                          aggregationMethod: selectedAggregationMethod,
                          aggregationField: value,
                        })
                      }}
                      disabled={isDisabled}
                    >
                      <FormControl>
                        <SelectTrigger disabled={isDisabled}>
                          <SelectValue placeholder="Select event property" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {selectedEventProperties.map((property) => (
                          <SelectItem key={property} value={property}>
                            {property}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : selectedEventProperties.length === 1 ? (
                    <div className="rounded-md border bg-background-bgSubtle/40 px-3 py-1.5">
                      <p className="font-medium font-mono text-sm">{selectedEventProperties[0]}</p>
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-muted-foreground text-xs">
                          Add a numeric property to use{" "}
                          {selectedAggregationConfig.label.toLowerCase()}.
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto px-0 text-xs"
                          onClick={() => {
                            setEventDialogMode("edit")
                            setIsEventDialogOpen(true)
                          }}
                        >
                          <Pencil className="mr-1.5 size-3.5" />
                          {isDisabled ? "View event" : "Edit event"}
                        </Button>
                      </div>
                    </div>
                  )}

                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        <FormField
          control={form.control}
          name="meterConfig.groupBy"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <div className="mb-2 flex items-center gap-1">
                <FormLabel>Price varies by</FormLabel>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[320px]">
                    Event properties a price can depend on, such as model. Each value gets its own
                    row on the version's card; the catalog prices models. A feature with a dimension
                    is priced per unit and has no included units.
                  </TooltipContent>
                </Tooltip>
              </div>
              <FormControl>
                <DimensionChips
                  value={field.value ?? []}
                  onChange={handleDimensionsChange}
                  isDisabled={isDisabled}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <EventFormDialog
        open={isEventDialogOpen}
        onOpenChange={setIsEventDialogOpen}
        mode={eventDialogMode}
        event={eventDialogMode === "edit" ? selectedEvent : undefined}
        onSaved={handleEventSaved}
        isDisabled={isDisabled}
        isPlanVersionLocked={isDisabled}
      />
    </>
  )
}
