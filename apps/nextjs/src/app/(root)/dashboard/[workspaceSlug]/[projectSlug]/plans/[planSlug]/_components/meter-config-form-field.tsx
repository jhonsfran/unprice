"use client"

import { useEffect, useMemo, useState } from "react"
import type { UseFormReturn } from "react-hook-form"

import { useQuery } from "@tanstack/react-query"
import { AGGREGATION_METHODS, AGGREGATION_METHODS_MAP } from "@unprice/db/utils"
import type { AggregationMethod, Event, PlanVersionFeatureInsert } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { HelpCircle, Pencil, Plus } from "lucide-react"
import { useTRPC } from "~/trpc/client"
import { DimensionChips } from "./dimension-chips"
import { EventFormDialog } from "./event-dialog"
import { EventPicker } from "./event-picker"
import { aggregationFieldFor, meterDefaultsFor, requiresAggregationField } from "./meter-defaults"

export function MeterConfigFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
}) {
  const trpc = useTRPC()
  const [isEventDialogOpen, setIsEventDialogOpen] = useState(false)
  const meterConfig = form.watch("meterConfig")
  const { data: eventsData } = useQuery(trpc.events.listByActiveProject.queryOptions())
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
  const [isVaryingOpen, setIsVaryingOpen] = useState(false)
  // The common case first, then the event's own properties other than the one it measures.
  const dimensionSuggestions = [
    ...new Set([
      "model",
      ...selectedEventProperties.filter((property) => property !== meterConfig?.aggregationField),
    ]),
  ].slice(0, 6)

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
                      The event your app sends when the feature is used, such as one API call or one
                      model response.
                    </TooltipContent>
                  </Tooltip>
                </div>
                {selectedEvent?.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsEventDialogOpen(true)}
                  >
                    <Pencil className="mr-1.5 size-3" />
                    {isDisabled ? "View event" : "Edit event"}
                  </Button>
                )}
              </div>

              <FormControl>
                <EventPicker
                  selectedEventId={meterConfig?.eventId}
                  fallbackSlug={meterConfig?.eventSlug}
                  onPick={handleEventChosen}
                  isDisabled={isDisabled}
                />
              </FormControl>

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
                  <FormLabel>Measure</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[320px]">
                      How the events add up to usage: count them, or sum a number they carry.
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
                    <FormLabel>Of property</FormLabel>
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
                          onClick={() => setIsEventDialogOpen(true)}
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
          render={({ field }) => {
            const dimensions = field.value ?? []
            if (dimensions.length === 0 && !isVaryingOpen) {
              return (
                <FormItem className="flex flex-row items-center justify-between gap-3 space-y-0 rounded-md border border-dashed px-3 py-2">
                  <span className="text-muted-foreground text-xs">One price for every event.</span>
                  {!isDisabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-xs"
                      onClick={() => setIsVaryingOpen(true)}
                    >
                      <Plus className="size-3" />
                      Price per model or property
                    </Button>
                  )}
                </FormItem>
              )
            }
            return (
              <FormItem className="flex flex-col">
                <div className="mb-2 flex items-center gap-1">
                  <FormLabel>Price varies by</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[320px]">
                      Give each value of an event property its own price, such as one price per
                      model. Prices are then set per unit, with no included units.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <FormControl>
                  <DimensionChips
                    value={dimensions}
                    onChange={handleDimensionsChange}
                    isDisabled={isDisabled}
                    suggestions={dimensionSuggestions}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )
          }}
        />
      </div>

      <EventFormDialog
        open={isEventDialogOpen}
        onOpenChange={setIsEventDialogOpen}
        event={selectedEvent}
        onSaved={handleEventSaved}
        isLocked={isDisabled}
      />
    </>
  )
}
