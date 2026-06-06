import { createRoute } from "@hono/zod-openapi"
import type { Analytics, FeatureUsagePeriodRow } from "@unprice/analytics"
import { FetchError } from "@unprice/error"
import { aiAnswerEnvelopeSchema, aiEvidenceSchema } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["analytics"]
const DAY_MS = 86_400_000
const OBSERVATION_DAYS = 14

export const forecastUsageApiRequestSchema = z.object({
  customer_id: z.string(),
  feature_slug: z.string(),
  period_key: z.string().optional(),
  horizon_days: z.number().int().min(1).max(31).optional().default(14),
})

export const forecastUsageApiResponseSchema = aiAnswerEnvelopeSchema.extend({
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

export const route = createRoute({
  path: "/v1/analytics/forecast-usage",
  operationId: "analytics.forecastUsage",
  summary: "forecast usage",
  description: "Project customer feature usage from recent Tinybird usage aggregates.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(forecastUsageApiRequestSchema, "Forecast usage request"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(forecastUsageApiResponseSchema, "Forecast usage response"),
    ...openApiErrorResponses,
  },
})

export type ForecastUsageApiRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ForecastUsageApiResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

type Observation = {
  dayIndex: number
  start: number
  end: number
  usage: number
}

export const registerForecastUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      customer_id: customerId,
      feature_slug: featureSlug,
      period_key: periodKey,
      horizon_days: horizonDays,
    } = c.req.valid("json")
    const key = await keyAuth(c)
    const projectId = key.projectId
    const generatedAt = Date.now()
    const observationEnd = generatedAt
    const observationStart = observationEnd - OBSERVATION_DAYS * DAY_MS

    try {
      const observations = await loadObservations({
        analytics: c.get("analytics"),
        projectId,
        customerId,
        featureSlug,
        periodKey,
        observationStart,
      })
      const projection = projectUsage({ observations, horizonDays })
      const response: ForecastUsageApiResponse = {
        answer: buildAnswer({
          customerId,
          featureSlug,
          horizonDays,
          projectedUsage: projection.projectedUsage,
        }),
        confidence: buildConfidence(observations.length),
        freshness: {
          generatedAt,
          dataFrom: observations.at(0)?.start ?? observationStart,
          dataTo: observations.at(-1)?.end ?? observationEnd,
        },
        evidence: observations.map((observation) => ({
          type: "meter_fact",
          id: `${projectId}:${customerId}:${featureSlug}:${observation.start}:${observation.end}`,
          source: "tinybird",
          timestamp: observation.end,
        })),
        warnings: buildWarnings(observations.length),
        nextActions: buildNextActions(observations.length),
        project_id: projectId,
        customer_id: customerId,
        feature_slug: featureSlug,
        horizonDays,
        projectedUsage: projection.projectedUsage,
        observedDays: observations.length,
        baselineUsage: projection.baselineUsage,
        trendPerDay: projection.trendPerDay,
        ...(periodKey ? { periodKey } : {}),
      }

      return c.json(response, HttpStatusCodes.OK)
    } catch (error) {
      throw toUnpriceApiError(
        new FetchError({
          message: error instanceof Error ? error.message : "Failed to forecast usage",
          retry: true,
          context: {
            url: "tinybird:v1_forecast_usage",
            method: "GET",
            projectId,
            customerId,
            featureSlug,
          },
        })
      )
    }
  })

async function loadObservations({
  analytics,
  projectId,
  customerId,
  featureSlug,
  periodKey,
  observationStart,
}: {
  analytics: Pick<Analytics, "getFeaturesUsagePeriod">
  projectId: string
  customerId: string
  featureSlug: string
  periodKey?: string
  observationStart: number
}): Promise<Observation[]> {
  const windows = Array.from({ length: OBSERVATION_DAYS }, (_, dayIndex) => {
    const start = observationStart + dayIndex * DAY_MS
    return {
      dayIndex,
      start,
      end: start + DAY_MS,
    }
  })

  const responses = await Promise.all(
    windows.map((window) =>
      analytics.getFeaturesUsagePeriod({
        project_id: projectId,
        customer_id: customerId,
        feature_slugs: [featureSlug],
        start: window.start,
        end: window.end,
        ...(periodKey ? { period_key: periodKey } : {}),
      })
    )
  )

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
        usage,
      },
    ]
  })
}

function readUsage(row: FeatureUsagePeriodRow): number | null {
  const usage = row.usage ?? row.value_after
  return typeof usage === "number" && Number.isFinite(usage) ? usage : null
}

function projectUsage({
  observations,
  horizonDays,
}: {
  observations: Observation[]
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
    observations.reduce((sum, observation) => sum + observation.usage, 0) / observations.length
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

function linearSlope(observations: Observation[]): number {
  if (observations.length < 2) {
    return 0
  }

  const meanX = mean(observations.map((row) => row.dayIndex))
  const meanY = mean(observations.map((row) => row.usage))
  const denominator = observations.reduce((sum, row) => sum + (row.dayIndex - meanX) ** 2, 0)

  if (denominator === 0) {
    return 0
  }

  return (
    observations.reduce((sum, row) => sum + (row.dayIndex - meanX) * (row.usage - meanY), 0) /
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

function buildConfidence(observedDays: number): ForecastUsageApiResponse["confidence"] {
  if (observedDays < 5) {
    return "low"
  }

  if (observedDays < 10) {
    return "medium"
  }

  return "high"
}

function buildWarnings(observedDays: number): string[] {
  const warnings = ["This is a projection based on recent aggregate usage, not a prediction."]

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
  return `Projected ${projectedUsage} usage units for ${featureSlug} over the next ${horizonDays} days for customer ${customerId}. This is a projection, not a prediction.`
}
