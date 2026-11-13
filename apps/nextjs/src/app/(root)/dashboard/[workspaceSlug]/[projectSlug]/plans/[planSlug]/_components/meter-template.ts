import { AGGREGATION_METHODS_MAP } from "@unprice/db/utils"
import type { AggregationMethod, MeterConfig } from "@unprice/db/validators"

type Meter = Pick<MeterConfig, "eventSlug" | "aggregationMethod" | "aggregationField" | "groupBy">

/** "Count of image_jobs", "Sum of input_tokens on ai_completion", "… · varies by model". */
export function meterSummary(meter: Meter): string {
  const label = AGGREGATION_METHODS_MAP[meter.aggregationMethod].label
  const measure =
    meter.aggregationMethod === "count" || !meter.aggregationField
      ? `${label} of ${meter.eventSlug}`
      : `${label} of ${meter.aggregationField} on ${meter.eventSlug}`
  const dimensions = meter.groupBy ?? []
  return dimensions.length > 0 ? `${measure} · varies by ${dimensions.join(", ")}` : measure
}

/** Whether a version's meter snapshot still measures what the feature's template measures. */
export function meterMatchesTemplate(
  snapshot: Meter | null | undefined,
  template: Meter | null | undefined
): boolean {
  if (!snapshot || !template) return false
  const dimensions = (meter: Meter) => [...(meter.groupBy ?? [])].sort().join(",")
  return (
    snapshot.eventSlug === template.eventSlug &&
    snapshot.aggregationMethod === template.aggregationMethod &&
    (snapshot.aggregationField ?? null) === (template.aggregationField ?? null) &&
    dimensions(snapshot) === dimensions(template)
  )
}

/** One choice for method and property together: "count", or "sum:input_tokens". */
export type Measure = "count" | `${Exclude<AggregationMethod, "count">}:${string}`

const FIELD_METHODS = (Object.keys(AGGREGATION_METHODS_MAP) as AggregationMethod[]).filter(
  (method): method is Exclude<AggregationMethod, "count"> => method !== "count"
)

/** Every measure an event's numeric properties allow, Count first. */
export function measureOptions(properties: readonly string[]): { value: Measure; label: string }[] {
  return [
    { value: "count", label: "Count of events" },
    ...FIELD_METHODS.flatMap((method) =>
      properties.map((property) => ({
        value: `${method}:${property}` as const,
        label: `${AGGREGATION_METHODS_MAP[method].label} of ${property}`,
      }))
    ),
  ]
}

export function measureOf(meter: Pick<Meter, "aggregationMethod" | "aggregationField">): Measure {
  return meter.aggregationMethod === "count" || !meter.aggregationField
    ? "count"
    : `${meter.aggregationMethod}:${meter.aggregationField}`
}

/** The meter with the chosen measure; the event and the dimensions stay. */
export function withMeasure(meter: MeterConfig, measure: Measure): MeterConfig {
  const { aggregationField: _dropped, ...rest } = meter
  if (measure === "count") return { ...rest, aggregationMethod: "count" }
  const [method, field] = measure.split(":") as [Exclude<AggregationMethod, "count">, string]
  return { ...rest, aggregationMethod: method, aggregationField: field }
}
