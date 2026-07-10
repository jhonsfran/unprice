import { fail } from "k6"
import type { K6SdkClient } from "./sdk-client"

type EntitlementList = NonNullable<
  Awaited<ReturnType<K6SdkClient["access"]["entitlements"]["list"]>>["result"]
>
type Entitlement = EntitlementList[number]

export type UsageEventTarget = {
  eventSlug: string
  featureSlug: string
  aggregationMethod: string
  aggregationField: string | null
  propertyFields: string[]
}

export type CustomerUsageProfile = {
  featureSlugs: string[]
  usageEvents: UsageEventTarget[]
}

export async function discoverCustomerUsageProfile({
  customerId,
  projectId,
  sdk,
}: {
  customerId: string
  projectId?: string
  sdk: Pick<K6SdkClient, "access">
}): Promise<CustomerUsageProfile> {
  const entitlementsResult = await sdk.access.entitlements.list({
    customerId,
    ...(projectId ? { projectId } : {}),
  })

  if (entitlementsResult.error) {
    fail(
      `access.entitlements.list failed: ${entitlementsResult.error.code}: ${entitlementsResult.error.message}`
    )
  }

  const entitlements = entitlementsResult.result

  if (!Array.isArray(entitlements) || entitlements.length === 0) {
    fail(`No active entitlements found for customer ${customerId} in project ${projectId}`)
  }

  const featureSlugs: string[] = []
  const usageEventsByKey = new Map<string, UsageEventTarget>()

  for (const entitlement of entitlements) {
    const featureSlug = getFeatureSlug(entitlement)

    if (featureSlug) {
      featureSlugs.push(featureSlug)
    }

    const meterConfig = getMeterConfig(entitlement)

    if (!meterConfig) {
      continue
    }

    const key = `${meterConfig.eventSlug}:${featureSlug ?? "unknown"}`
    const existing = usageEventsByKey.get(key)
    const propertyFields = existing?.propertyFields ?? []

    if (meterConfig.aggregationMethod !== "count") {
      if (!meterConfig.aggregationField) {
        fail(
          `Usage meter for feature ${featureSlug ?? "unknown"} uses ${meterConfig.aggregationMethod} but has no aggregationField`
        )
      }

      if (!propertyFields.includes(meterConfig.aggregationField)) {
        propertyFields.push(meterConfig.aggregationField)
      }
    }

    usageEventsByKey.set(key, {
      eventSlug: meterConfig.eventSlug,
      featureSlug: featureSlug ?? meterConfig.eventSlug,
      aggregationMethod: meterConfig.aggregationMethod,
      aggregationField: meterConfig.aggregationField,
      propertyFields,
    })
  }

  if (featureSlugs.length === 0) {
    fail(`Could not resolve feature slugs from entitlements for customer ${customerId}`)
  }

  return {
    featureSlugs: unique(featureSlugs),
    usageEvents: [...usageEventsByKey.values()],
  }
}

export function buildProperties(propertyFields: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}

  for (const field of propertyFields) {
    properties[field] = randomUsageValue()
  }

  return properties
}

export function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

export function parseJson(response: { json(): unknown }): unknown {
  try {
    return response.json()
  } catch (_error) {
    return null
  }
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

export function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`Expected a non-negative integer, received: ${value}`)
  }

  return parsed
}

export function randomInteger(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function getFeatureSlug(entitlement: Entitlement): string | null {
  return trimString(entitlement?.featurePlanVersion?.feature?.slug)
}

function getMeterConfig(entitlement: Entitlement): {
  eventSlug: string
  aggregationMethod: string
  aggregationField: string | null
} | null {
  const meterConfig = entitlement?.featurePlanVersion?.meterConfig

  if (!meterConfig || typeof meterConfig !== "object") {
    return null
  }

  const eventSlug = trimString(meterConfig.eventSlug)

  if (!eventSlug) {
    return null
  }

  return {
    eventSlug,
    aggregationMethod: trimString(meterConfig.aggregationMethod) || "count",
    aggregationField: trimString(meterConfig.aggregationField),
  }
}

function randomUsageValue(): number {
  return randomInteger(1, 5)
}

function trimString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
