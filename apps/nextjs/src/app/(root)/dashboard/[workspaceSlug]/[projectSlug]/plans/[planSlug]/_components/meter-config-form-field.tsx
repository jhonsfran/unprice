"use client"

import { useEffect, useMemo, useState } from "react"
import type { UseFormReturn } from "react-hook-form"
import { useFieldArray } from "react-hook-form"
import { z } from "zod"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { slugify } from "@unprice/db/utils"
import { AGGREGATION_METHODS, AGGREGATION_METHODS_MAP } from "@unprice/db/utils"
import type { AggregationMethod, Event, PlanVersionFeatureInsert } from "@unprice/db/validators"
import { eventInsertBaseSchema } from "@unprice/db/validators"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@unprice/ui/dialog"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { CheckIcon, ChevronDown, HelpCircle, Pencil, Plus, XCircle } from "lucide-react"
import { FilterScroll } from "~/components/filter-scroll"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"
import { SectionLabel } from "./section-label"

const AGGREGATION_METHODS_WITHOUT_FIELD = new Set<AggregationMethod>(["count"])
const EVENT_PICKER_SEARCH_THRESHOLD = 6

const eventFormSchema = z.object({
  name: eventInsertBaseSchema.shape.name,
  slug: eventInsertBaseSchema.shape.slug,
  availableProperties: z.array(
    z.object({
      value: z
        .string()
        .min(1, "Property name is required")
        .regex(/^[a-z0-9._-]+$/, {
          message:
            "Property names must contain only lowercase letters, numbers, dots, dashes, and underscores",
        }),
    })
  ),
})

type EventFormValues = z.infer<typeof eventFormSchema>

function requiresAggregationField(method?: AggregationMethod) {
  return Boolean(method && !AGGREGATION_METHODS_WITHOUT_FIELD.has(method))
}

function toEventFormValues(event?: Event, suggestedProperty?: string): EventFormValues {
  const properties =
    event?.availableProperties?.map((value) => ({ value })) ??
    (suggestedProperty ? [{ value: suggestedProperty }] : [])

  return {
    name: event?.name ?? "",
    slug: event?.slug ?? "",
    availableProperties: properties,
  }
}

function toAvailableProperties(values: EventFormValues["availableProperties"]) {
  return Array.from(new Set(values.map((property) => property.value.trim()).filter(Boolean)))
}

function getNextAggregationField({
  currentValue,
  event,
  method,
}: {
  currentValue?: string
  event?: Event
  method?: AggregationMethod
}) {
  if (!requiresAggregationField(method)) {
    return undefined
  }

  const properties = event?.availableProperties ?? []

  if (!properties.length) {
    return undefined
  }

  if (currentValue && properties.includes(currentValue)) {
    return currentValue
  }

  return properties.length === 1 ? properties[0] : undefined
}

function EventFormDialog({
  open,
  onOpenChange,
  mode,
  event,
  suggestedProperty,
  onSaved,
  isDisabled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  event?: Event
  suggestedProperty?: string
  onSaved: (event: Event) => Promise<void> | void
  isDisabled?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const createEvent = useMutation(trpc.events.create.mutationOptions())
  const updateEvent = useMutation(trpc.events.update.mutationOptions())
  const form = useZodForm({
    schema: eventFormSchema,
    defaultValues: toEventFormValues(event, suggestedProperty),
  })
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "availableProperties",
  })
  const immutablePropertyCount = mode === "edit" ? (event?.availableProperties?.length ?? 0) : 0

  useEffect(() => {
    if (!open) {
      return
    }

    form.reset(toEventFormValues(event, suggestedProperty))
  }, [event?.id, form, open, suggestedProperty])

  const isPending = createEvent.isPending || updateEvent.isPending

  const onSubmit = async (data: EventFormValues) => {
    const availableProperties = toAvailableProperties(data.availableProperties)

    const result =
      mode === "create"
        ? await createEvent.mutateAsync({
            name: data.name,
            slug: data.slug,
            availableProperties,
          })
        : await updateEvent.mutateAsync({
            id: event!.id,
            name: data.name,
            availableProperties,
          })

    await queryClient.invalidateQueries({
      queryKey: trpc.events.listByActiveProject.queryKey(),
    })

    toastAction(mode === "create" ? "saved" : "updated")
    await onSaved(result.event)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader className="space-y-2">
          <DialogTitle>{mode === "create" ? "Create event" : "Edit event"}</DialogTitle>
          <DialogDescription>
            Events are reusable across features. Add the SDK slug once, then list any numeric
            payload fields you may want to aggregate later.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <FormLabel>Name</FormLabel>
                    <FormDescription>Internal label shown in the dashboard.</FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="AI completion"
                        disabled={isDisabled || isPending}
                        onChange={(e) => {
                          field.onChange(e)

                          if (mode === "create") {
                            form.setValue("slug", slugify(e.target.value))
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <FormLabel>SDK Slug</FormLabel>
                    <FormDescription>Slugs are immutable after creation.</FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        className="font-mono"
                        placeholder="ai_completion"
                        disabled={isDisabled || isPending || mode === "edit"}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-3 rounded-lg bg-background-bgSubtle/30 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-sm">Numeric properties</p>
                  <p className="text-muted-foreground text-xs">
                    Add payload fields you may aggregate later, like `value`, `input_tokens`, or
                    `active_seats`.
                    {mode === "edit" ? " Existing properties cannot be removed." : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={isDisabled || isPending}
                  onClick={() => append({ value: "" })}
                >
                  <Plus className="mr-2 size-3.5" />
                  Add property
                </Button>
              </div>

              {fields.length ? (
                <div className="space-y-2">
                  {fields.map((field, index) => {
                    const isImmutableProperty = mode === "edit" && index < immutablePropertyCount

                    return (
                      <div key={field.id} className="flex items-start gap-2">
                        <FormField
                          control={form.control}
                          name={`availableProperties.${index}.value`}
                          render={({ field }) => (
                            <FormItem className="flex-1 space-y-1">
                              <FormControl>
                                <Input
                                  {...field}
                                  className="font-mono"
                                  placeholder="input_tokens"
                                  disabled={isDisabled || isPending || isImmutableProperty}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mt-0.5 shrink-0"
                          disabled={isDisabled || isPending || isImmutableProperty}
                          onClick={() => remove(index)}
                        >
                          <XCircle className="size-4" />
                          <span className="sr-only">
                            {isImmutableProperty
                              ? "Existing properties cannot be removed"
                              : "Remove property"}
                          </span>
                        </Button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
                  No numeric properties yet. You can still save a count-based event now and add
                  properties later if you need sum, max, or latest aggregation.
                </div>
              )}
            </div>

            <DialogFooter className="pt-2">
              <SubmitButton
                isSubmitting={form.formState.isSubmitting}
                isDisabled={isDisabled || isPending}
                label={mode === "create" ? "Create event" : "Save event"}
              />
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

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

  const [draftAggregationMethod, setDraftAggregationMethod] = useState<AggregationMethod>(
    meterConfig?.aggregationMethod ?? "sum"
  )

  useEffect(() => {
    setDraftAggregationMethod(meterConfig?.aggregationMethod ?? "sum")
  }, [meterConfig?.aggregationMethod])

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
      getNextAggregationField({
        currentValue: meterConfig?.aggregationField,
        event,
        method: aggregationMethod,
      })

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
      },
      {
        shouldDirty: true,
        shouldValidate: true,
      }
    )
  }

  const handleAggregationMethodChange = (value: AggregationMethod) => {
    setDraftAggregationMethod(value)

    if (!selectedEvent?.id) {
      return
    }

    setMeterConfigValue({
      event: selectedEvent,
      aggregationMethod: value,
      aggregationField: getNextAggregationField({
        currentValue: meterConfig?.aggregationField,
        event: selectedEvent,
        method: value,
      }),
    })
  }

  const handleEventSaved = async (event: Event) => {
    setMeterConfigValue({
      event,
      aggregationMethod: selectedAggregationMethod,
      aggregationField: getNextAggregationField({
        currentValue: meterConfig?.aggregationField,
        event,
        method: selectedAggregationMethod,
      }),
    })
  }

  useEffect(() => {
    if (!selectedEvent?.id || !needsAggregationField || selectedEventProperties.length !== 1) {
      return
    }

    const onlyProperty = selectedEventProperties[0]

    if (meterConfig?.aggregationField === onlyProperty) {
      return
    }

    form.setValue(
      "meterConfig",
      {
        eventId: selectedEvent.id,
        eventSlug: selectedEvent.slug,
        aggregationMethod: selectedAggregationMethod,
        aggregationField: onlyProperty,
      },
      {
        shouldDirty: false,
        shouldValidate: true,
      }
    )
  }, [
    form,
    meterConfig?.aggregationField,
    needsAggregationField,
    selectedAggregationMethod,
    selectedEvent?.id,
    selectedEvent?.slug,
    selectedEventProperties,
  ])

  const suggestedProperty = needsAggregationField
    ? (meterConfig?.aggregationField ?? "value")
    : undefined

  return (
    <>
      <div className="space-y-3">
        <SectionLabel tooltip="Pick a reusable event and define how this feature measures usage from that event.">
          Meter
        </SectionLabel>

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
                    disabled={isDisabled}
                    onClick={() => {
                      setEventDialogMode("edit")
                      setIsEventDialogOpen(true)
                    }}
                  >
                    <Pencil className="mr-1.5 size-3" />
                    Edit event
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
                  align="start"
                  className="max-h-[--radix-popover-content-available-height] w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    {shouldShowEventSearch ? (
                      <CommandInput className="h-9 py-2 text-sm" placeholder="Search events..." />
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
                                  setMeterConfigValue({
                                    event,
                                    aggregationMethod: selectedAggregationMethod,
                                  })
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
                          disabled={isDisabled}
                          className="h-auto px-0 text-xs"
                          onClick={() => {
                            setEventDialogMode("edit")
                            setIsEventDialogOpen(true)
                          }}
                        >
                          <Pencil className="mr-1.5 size-3.5" />
                          Edit event
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
      </div>

      <EventFormDialog
        open={isEventDialogOpen}
        onOpenChange={setIsEventDialogOpen}
        mode={eventDialogMode}
        event={eventDialogMode === "edit" ? selectedEvent : undefined}
        suggestedProperty={suggestedProperty}
        onSaved={handleEventSaved}
        isDisabled={isDisabled}
      />
    </>
  )
}
