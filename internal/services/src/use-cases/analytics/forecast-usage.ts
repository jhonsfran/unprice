import type { Analytics, FeatureUsagePeriodRow } from "@unprice/analytics"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { z } from "zod"
import { aiAnswerEnvelopeSchema, aiEvidenceSchema } from "./ai-contracts"

const DAY_MS = 86_400_000
const OBSERVATION_DAYS = 14

export const forecastUsageInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
  featureSlug: z.string(),
  periodKey: z.string().optional(),
  horizonDays: z.number().int().min(1).max(31).optional().default(14),
})

export const forecastUsageOutputSchema = aiAnswerEnvelopeSchema.extend({
  project_id: z.string(),
  customer_id: z.string(),
  feature_slug: z.string(),
  horizonDays: z.number().int(),
  projectedUsage: z.number(),
  observedDays: z.number().int(),
  baselineUsage: z.number(),
  trendPerDay: z.number(),
  periodKey: z.string().optional(),
  evidence: z.array(aiEvidenceSchema),
})

export type ForecastUsageInput = z.input<typeof forecastUsageInputSchema>
export type ForecastUsageOutput = z.infer<typeof forecastUsageOutputSchema>

export type ForecastUsageAnalytics = Pick<Analytics, "getFeaturesUsagePeriod">

export type ForecastUsageDeps = {
  analytics: ForecastUsageAnalytics
  now?: () => number
}

type ForecastUsageFailure = FetchError

type ObservationWindow = {
  dayIndex: number
  start: number
  end: number
  dayKey: string
}

type Observation = ObservationWindow & {
  cumulativeUsage: number
}

type DeltaObservation = ObservationWindow & {
  usageDelta: number
}

export async function forecastUsage(
  deps: ForecastUsageDeps,
  rawInput: ForecastUsageInput
): Promise<Result<ForecastUsageOutput, ForecastUsageFailure>> {
  const input = forecastUsageInputSchema.parse(rawInput)
  const generatedAt = deps.now?.() ?? Date.now()
  const observationEnd = startOfUtcDay(generatedAt)
  const observationStart = observationEnd - OBSERVATION_DAYS * DAY_MS
  const windows = buildObservationWindows(observationStart)

  const analyticsResult = await wrapResult(
    Promise.all(
      windows.map((window) =>
        deps.analytics.getFeaturesUsagePeriod({
          project_id: input.projectId,
          customer_id: input.customerId,
          feature_slugs: [input.featureSlug],
          start: window.start,
          end: window.end,
          ...(input.periodKey ? { period_key: input.periodKey } : {}),
        })
      )
    ),
    (error) =>
      new FetchError({
        message: error.message,
        retry: true,
        context: {
          url: "tinybird:v1_forecast_usage",
          method: "GET",
          projectId: input.projectId,
          customerId: input.customerId,
          featureSlug: input.featureSlug,
        },
      })
  )

  if (analyticsResult.err) {
    return Err(analyticsResult.err)
  }

  const observations = buildObservations({
    responses: analyticsResult.val,
    windows,
    featureSlug: input.featureSlug,
  })
  const deltaObservations = buildDeltaObservations(observations)
  const projection = projectUsage({
    observations: deltaObservations,
    horizonDays: input.horizonDays,
  })

  const output: ForecastUsageOutput = {
    answer: buildAnswer({
      customerId: input.customerId,
      featureSlug: input.featureSlug,
      horizonDays: input.horizonDays,
      projectedUsage: projection.projectedUsage,
    }),
    confidence: buildConfidence(deltaObservations.length),
    freshness: {
      generatedAt,
      dataFrom: observationStart,
      dataTo: observationEnd,
    },
    evidence: deltaObservations.map((observation) => ({
      type: "meter_fact",
      id: buildEvidenceId({
        projectId: input.projectId,
        customerId: input.customerId,
        featureSlug: input.featureSlug,
        periodKey: input.periodKey,
        dayKey: observation.dayKey,
      }),
      source: "tinybird",
      timestamp: observation.end,
    })),
    warnings: buildWarnings(deltaObservations.length),
    nextActions: buildNextActions(deltaObservations.length),
    project_id: input.projectId,
    customer_id: input.customerId,
    feature_slug: input.featureSlug,
    horizonDays: input.horizonDays,
    projectedUsage: projection.projectedUsage,
    observedDays: deltaObservations.length,
    baselineUsage: projection.baselineUsage,
    trendPerDay: projection.trendPerDay,
    ...(input.periodKey ? { periodKey: input.periodKey } : {}),
  }

  return Ok(forecastUsageOutputSchema.parse(output))
}

function startOfUtcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS) * DAY_MS
}

function buildObservationWindows(observationStart: number): ObservationWindow[] {
  return Array.from({ length: OBSERVATION_DAYS }, (_, dayIndex) => {
    const start = observationStart + dayIndex * DAY_MS
    return {
      dayIndex,
      start,
      end: start + DAY_MS,
      dayKey: dayKey(start),
    }
  })
}

function buildObservations({
  responses,
  windows,
  featureSlug,
}: {
  responses: Array<{ data?: FeatureUsagePeriodRow[] }>
  windows: ObservationWindow[]
  featureSlug: string
}): Observation[] {
  return responses.flatMap((response, index) => {
    const row = response.data?.find((candidate) => candidate.feature_slug === featureSlug)
    const usage = row ? readUsage(row) : null

    if (usage === null) {
      return []
    }

    const window = windows[index]
    if (!window) {
      return []
    }

    return [
      {
        ...window,
        cumulativeUsage: usage,
      },
    ]
  })
}

function readUsage(row: FeatureUsagePeriodRow): number | null {
  const usage = row.usage ?? row.value_after
  return typeof usage === "number" && Number.isFinite(usage) ? usage : null
}

function buildDeltaObservations(observations: Observation[]): DeltaObservation[] {
  return observations.flatMap((observation, index) => {
    const previous = observations[index - 1]
    if (!previous || observation.dayIndex - previous.dayIndex !== 1) {
      return []
    }

    return [
      {
        ...observation,
        usageDelta: Math.max(0, observation.cumulativeUsage - previous.cumulativeUsage),
      },
    ]
  })
}

function projectUsage({
  observations,
  horizonDays,
}: {
  observations: DeltaObservation[]
  horizonDays: number
}): {
  projectedUsage: number
  baselineUsage: number
  trendPerDay: number
} {
  if (observations.length === 0) {
    return {
      projectedUsage: 0,
      baselineUsage: 0,
      trendPerDay: 0,
    }
  }

  const baselineUsage =
    observations.reduce((sum, observation) => sum + observation.usageDelta, 0) / observations.length
  const trendPerDay = linearSlope(observations)
  const intercept = baselineUsage - trendPerDay * mean(observations.map((row) => row.dayIndex))
  const firstFutureDayIndex = observations.at(-1)?.dayIndex ?? OBSERVATION_DAYS - 1
  const projectedUsage = Array.from({ length: horizonDays }, (_, index) => {
    const dayIndex = firstFutureDayIndex + index + 1
    return Math.max(0, intercept + trendPerDay * dayIndex)
  }).reduce((sum, usage) => sum + usage, 0)

  return {
    projectedUsage: roundUsage(projectedUsage),
    baselineUsage: roundUsage(baselineUsage),
    trendPerDay: roundUsage(trendPerDay),
  }
}

function linearSlope(observations: DeltaObservation[]): number {
  if (observations.length < 2) {
    return 0
  }

  const meanX = mean(observations.map((row) => row.dayIndex))
  const meanY = mean(observations.map((row) => row.usageDelta))
  const denominator = observations.reduce((sum, row) => sum + (row.dayIndex - meanX) ** 2, 0)

  if (denominator === 0) {
    return 0
  }

  return (
    observations.reduce((sum, row) => sum + (row.dayIndex - meanX) * (row.usageDelta - meanY), 0) /
    denominator
  )
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function roundUsage(value: number): number {
  return Math.round(value * 100) / 100
}

function buildConfidence(observedDays: number): ForecastUsageOutput["confidence"] {
  if (observedDays < 5) {
    return "low"
  }

  if (observedDays < 10) {
    return "medium"
  }

  return "high"
}

function buildWarnings(observedDays: number): string[] {
  const warnings = [
    "This is a projection of incremental horizon usage from day-over-day cumulative usage deltas, not a prediction.",
  ]

  if (observedDays < 5) {
    warnings.push("Fewer than five observed days were available, so confidence is low.")
  }

  return warnings
}

function buildNextActions(observedDays: number): string[] {
  if (observedDays < 5) {
    return ["Collect at least five days of usage before relying on the projection."]
  }

  return ["Compare this projection against entitlement limits and wallet runway."]
}

function buildAnswer({
  customerId,
  featureSlug,
  horizonDays,
  projectedUsage,
}: {
  customerId: string
  featureSlug: string
  horizonDays: number
  projectedUsage: number
}): string {
  return `Projected incremental usage of ${projectedUsage} units for ${featureSlug} over the next ${horizonDays} days for customer ${customerId}. This is a projection, not a prediction.`
}

function buildEvidenceId({
  projectId,
  customerId,
  featureSlug,
  periodKey,
  dayKey,
}: {
  projectId: string
  customerId: string
  featureSlug: string
  periodKey?: string
  dayKey: string
}): string {
  return [projectId, customerId, featureSlug, periodKey, dayKey].filter(Boolean).join(":")
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}
