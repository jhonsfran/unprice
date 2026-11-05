import type { AggregationMethod, Event } from "@unprice/db/validators"

const METHODS_WITHOUT_FIELD: ReadonlySet<AggregationMethod> = new Set(["count"])

export function requiresAggregationField(method?: AggregationMethod): boolean {
  return Boolean(method && !METHODS_WITHOUT_FIELD.has(method))
}

/**
 * The event property `method` aggregates: the current one when the event still carries it, else
 * the event's first; undefined when the method counts events or the event has no property.
 */
export function aggregationFieldFor(
  properties: readonly string[],
  method: AggregationMethod,
  current?: string
): string | undefined {
  if (!requiresAggregationField(method) || properties.length === 0) return undefined
  return current && properties.includes(current) ? current : properties[0]
}

/**
 * The meter an event gets when it is picked: Count when the event carries no numeric property,
 * since nothing else can be aggregated; otherwise the current method (Sum for a new meter) over
 * the current property, or the event's first one.
 */
export function meterDefaultsFor(
  event: Pick<Event, "availableProperties">,
  current: { aggregationMethod?: AggregationMethod; aggregationField?: string }
): { aggregationMethod: AggregationMethod; aggregationField?: string } {
  const properties = event.availableProperties ?? []
  if (properties.length === 0) return { aggregationMethod: "count" }
  const aggregationMethod = current.aggregationMethod ?? "sum"
  const aggregationField = aggregationFieldFor(
    properties,
    aggregationMethod,
    current.aggregationField
  )
  return aggregationField ? { aggregationMethod, aggregationField } : { aggregationMethod }
}
