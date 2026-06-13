import { fail } from "k6"

export function discoverCustomerUsageProfile({ customerId, projectId, postJson }) {
  const response = postJson(
    "/v1/entitlements/get",
    {
      customerId,
      projectId,
    },
    "POST /v1/entitlements/get"
  )

  if (response.status !== 200) {
    fail(`entitlements.get failed: ${response.status} ${response.body}`)
  }

  const entitlements = parseJson(response)

  if (!Array.isArray(entitlements) || entitlements.length === 0) {
    fail(`No active entitlements found for customer ${customerId} in project ${projectId}`)
  }

  const featureSlugs = []
  const usageEventFieldsByEventSlug = new Map()

  for (const entitlement of entitlements) {
    const featureSlug = getFeatureSlug(entitlement)

    if (featureSlug) {
      featureSlugs.push(featureSlug)
    }

    const meterConfig = getMeterConfig(entitlement)

    if (!meterConfig) {
      continue
    }

    const propertyFields = usageEventFieldsByEventSlug.get(meterConfig.eventSlug) ?? []

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

    usageEventFieldsByEventSlug.set(meterConfig.eventSlug, propertyFields)
  }

  if (featureSlugs.length === 0) {
    fail(`Could not resolve feature slugs from entitlements for customer ${customerId}`)
  }

  return {
    featureSlugs: unique(featureSlugs),
    usageEvents: [...usageEventFieldsByEventSlug.entries()].map(([eventSlug, propertyFields]) => ({
      eventSlug,
      propertyFields,
    })),
  }
}

export function buildProperties(propertyFields) {
  const properties = {}

  for (const field of propertyFields) {
    properties[field] = randomUsageValue()
  }

  return properties
}

export function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

export function parseJson(response) {
  try {
    return response.json()
  } catch (_error) {
    return null
  }
}

export function positiveInteger(value, fallback) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

export function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`Expected a non-negative integer, received: ${value}`)
  }

  return parsed
}

export function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function getFeatureSlug(entitlement) {
  const directSlug = trimString(entitlement?.featureSlug)

  if (directSlug) {
    return directSlug
  }

  return trimString(entitlement?.featurePlanVersion?.feature?.slug)
}

function getMeterConfig(entitlement) {
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

function randomUsageValue() {
  return randomInteger(1, 5)
}

function trimString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function unique(values) {
  return [...new Set(values)]
}
