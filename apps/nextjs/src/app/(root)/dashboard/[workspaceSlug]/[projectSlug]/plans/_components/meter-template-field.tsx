"use client"

import { useQuery } from "@tanstack/react-query"
import type { Event, MeterConfig } from "@unprice/db/validators"
import { FormControl } from "@unprice/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"

import { useTRPC } from "~/trpc/client"
import { DimensionChips } from "../[planSlug]/_components/dimension-chips"
import { EventPicker } from "../[planSlug]/_components/event-picker"
import { meterDefaultsFor } from "../[planSlug]/_components/meter-defaults"
import {
  type Measure,
  measureOf,
  measureOptions,
  withMeasure,
} from "../[planSlug]/_components/meter-template"

/**
 * A feature's meter template: not metered, or an event with the measure that fits it (Count, or
 * Sum of its first number) and the properties its price varies by. One line while not metered.
 */
export function MeterTemplateField({
  value,
  onChange,
}: {
  value: MeterConfig | null
  onChange: (next: MeterConfig | null) => void
}) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.events.listByActiveProject.queryOptions())
  const event = data?.events.find((entry) => entry.id === value?.eventId)
  const properties = event?.availableProperties ?? []

  const pickEvent = (picked: Event) => {
    const { groupBy } = value ?? {}
    onChange({
      eventId: picked.id,
      eventSlug: picked.slug,
      ...meterDefaultsFor(picked, {}),
      ...(groupBy?.length ? { groupBy } : {}),
    })
  }

  const setDimensions = (groupBy: string[]) => {
    if (!value) return
    const { groupBy: _dropped, ...rest } = value
    onChange(groupBy.length > 0 ? { ...rest, groupBy } : rest)
  }

  return (
    <div className="space-y-3">
      <div className={value ? "grid gap-3 md:grid-cols-2" : "grid gap-3"}>
        <FormControl>
          <EventPicker
            selectedEventId={value?.eventId}
            fallbackSlug={value?.eventSlug}
            onPick={pickEvent}
            none={{ label: "Not metered", onSelect: () => onChange(null) }}
          />
        </FormControl>
        {value && (
          <Select
            value={measureOf(value)}
            onValueChange={(measure) => onChange(withMeasure(value, measure as Measure))}
            disabled={properties.length === 0}
          >
            <SelectTrigger aria-label="Measure" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {measureOptions(properties).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {value && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground text-xs">
            Price varies by: event properties each version prices per value, such as model.
          </p>
          <DimensionChips value={value.groupBy ?? []} onChange={setDimensions} />
        </div>
      )}
    </div>
  )
}
