import { randomUUID } from "node:crypto"
import { Unprice, type paths } from "@unprice/api"

type VerifyResponse =
  paths["/v1/customer/verify"]["post"]["responses"]["200"]["content"]["application/json"]
type MeterConfig = NonNullable<VerifyResponse["meterConfig"]>
type AggregationMethod = MeterConfig["aggregationMethod"]

const UNPRICE_TOKEN = process.env.UNPRICE_TOKEN || ""
const UNPRICE_API_URL = process.env.UNPRICE_API_URL || "http://localhost:8787"
const CUSTOMER_ID = process.env.CUSTOMER_ID?.trim() || ""
const FEATURE_SLUG = process.env.FEATURE_SLUG?.trim() || ""
const USAGE_AMOUNT = getPositiveNumberEnvValue("USAGE_AMOUNT", 5)
const BULK_USAGE_EVENTS = getPositiveIntegerEnvValue("BULK_USAGE_EVENTS", 25)
const BULK_USAGE_AMOUNT = getPositiveNumberEnvValue("BULK_USAGE_AMOUNT", 1)
const TOTAL_USAGE_AMOUNT = getOptionalPositiveNumberEnvValue("TOTAL_USAGE_AMOUNT")

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

if (!UNPRICE_TOKEN) {
  console.error(colors.red("UNPRICE_TOKEN env var is required"))
  process.exit(1)
}

if (!CUSTOMER_ID) {
  console.error(colors.red("CUSTOMER_ID env var is required"))
  process.exit(1)
}

const unprice = new Unprice({
  token: UNPRICE_TOKEN,
  baseUrl: UNPRICE_API_URL,
})

let selectedUsageFeature: {
  featureSlug: string
  eventSlug: string
  aggregationMethod: AggregationMethod
  aggregationField?: string
} | null = null
let currentUsage = 0
let currentLimit: number | null | undefined = null
let singleUsageBefore = 0
let singleUsageAmounts: number[] = []
let bulkUsageBefore = 0
let bulkUsageAmounts: number[] = []
let ingestedEvents = 0

function getPositiveNumberEnvValue(name: string, defaultValue: number): number {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return defaultValue

  return parsePositiveNumberEnvValue(name, rawValue)
}

function getOptionalPositiveNumberEnvValue(name: string): number | null {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return null

  return parsePositiveNumberEnvValue(name, rawValue)
}

function parsePositiveNumberEnvValue(name: string, rawValue: string): number {
  const value = Number(rawValue)
  if (Number.isFinite(value) && value > 0) {
    return value
  }

  throw new Error(`${name} must be a positive number. Received: ${rawValue}`)
}

function getPositiveIntegerEnvValue(name: string, defaultValue: number): number {
  const value = getPositiveNumberEnvValue(name, defaultValue)
  if (Number.isInteger(value)) {
    return value
  }

  throw new Error(`${name} must be a positive integer. Received: ${value}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getFeatureSlugFromEntitlement(entitlement: unknown): string | null {
  if (!isRecord(entitlement)) return null

  const directSlug = entitlement.featureSlug
  if (typeof directSlug === "string" && directSlug.trim()) {
    return directSlug
  }

  const featurePlanVersion = entitlement.featurePlanVersion
  if (!isRecord(featurePlanVersion)) return null

  const feature = featurePlanVersion.feature
  if (!isRecord(feature)) return null

  const nestedSlug = feature.slug
  return typeof nestedSlug === "string" && nestedSlug.trim() ? nestedSlug : null
}

function buildIngestionProperties(
  usage: number,
  meterConfig: Pick<MeterConfig, "aggregationMethod" | "aggregationField">
): Record<string, unknown> {
  if (meterConfig.aggregationMethod === "count") return {}

  const field = meterConfig.aggregationField?.trim()
  assert(field, "usage meter requires aggregationField for non-count aggregation")

  return { [field]: usage }
}

function buildUsageAmounts(
  method: AggregationMethod,
  previousUsage: number,
  limit: number | null | undefined,
  requestedEvents: number,
  requestedAmount: number
): number[] {
  if (method === "sum") {
    if (limit != null) {
      const remaining = limit - previousUsage
      assert(
        remaining > 0,
        `usage feature has no remaining capacity for sum events (${previousUsage}/${limit})`
      )

      if (remaining < requestedAmount) {
        return [remaining]
      }
    }

    const eventCount =
      limit == null
        ? requestedEvents
        : Math.min(requestedEvents, Math.floor((limit - previousUsage) / requestedAmount))

    assert(
      eventCount > 0,
      `usage feature has no remaining capacity for sum events (${previousUsage}/${limit})`
    )

    return Array.from({ length: eventCount }, () => requestedAmount)
  }

  if (method === "count") {
    const eventCount =
      limit == null ? requestedEvents : Math.min(requestedEvents, Math.floor(limit - previousUsage))

    assert(
      eventCount > 0,
      `usage feature has no remaining capacity for count events (${previousUsage}/${limit})`
    )

    return Array.from({ length: eventCount }, () => requestedAmount)
  }

  const firstAmount =
    limit == null
      ? Math.max(requestedAmount, previousUsage + 1)
      : Math.min(Math.max(requestedAmount, previousUsage + 1), limit)
  const eventCount =
    limit == null ? requestedEvents : Math.min(requestedEvents, Math.floor(limit - firstAmount + 1))

  assert(
    eventCount > 0,
    `usage feature has no remaining capacity for ${method} events (${previousUsage}/${limit})`
  )

  return Array.from({ length: eventCount }, (_, index) => firstAmount + index)
}

function buildTotalUsageAmounts(
  method: AggregationMethod,
  previousUsage: number,
  limit: number | null | undefined,
  totalUsageAmount: number,
  requestedEvents: number
): number[] {
  if (method === "sum") {
    assert(
      limit == null || previousUsage + totalUsageAmount <= limit,
      `requested TOTAL_USAGE_AMOUNT=${totalUsageAmount} exceeds remaining capacity (${previousUsage}/${limit})`
    )

    const eventCount = Math.max(1, Math.min(requestedEvents, Math.ceil(totalUsageAmount)))
    const baseAmount = Math.floor(totalUsageAmount / eventCount)
    const remainder = totalUsageAmount - baseAmount * eventCount
    const usageAmounts = Array.from({ length: eventCount }, (_, index) =>
      index === eventCount - 1 ? baseAmount + remainder : baseAmount
    )

    return usageAmounts.filter((amount) => amount > 0)
  }

  if (method === "count") {
    assert(
      Number.isInteger(totalUsageAmount),
      `TOTAL_USAGE_AMOUNT must be a positive integer for count meters. Received: ${totalUsageAmount}`
    )
    assert(
      limit == null || previousUsage + totalUsageAmount <= limit,
      `requested TOTAL_USAGE_AMOUNT=${totalUsageAmount} exceeds remaining capacity (${previousUsage}/${limit})`
    )

    return Array.from({ length: totalUsageAmount }, () => BULK_USAGE_AMOUNT)
  }

  assert(
    limit == null || totalUsageAmount <= limit,
    `requested TOTAL_USAGE_AMOUNT=${totalUsageAmount} exceeds limit ${limit}`
  )

  return [totalUsageAmount]
}

function expectedUsageAfter(
  previousUsage: number,
  method: AggregationMethod,
  usageAmounts: number[]
): number {
  if (method === "sum") {
    return previousUsage + usageAmounts.reduce((total, amount) => total + amount, 0)
  }

  if (method === "count") {
    return previousUsage + usageAmounts.length
  }

  if (method === "max") {
    return Math.max(previousUsage, ...usageAmounts)
  }

  return usageAmounts.at(-1) ?? previousUsage
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now()

  try {
    await fn()
    const ms = (performance.now() - start).toFixed(0)
    console.info(`  ${colors.green("PASS")} ${name} ${colors.dim(`(${ms}ms)`)}`)
  } catch (err) {
    const ms = (performance.now() - start).toFixed(0)
    console.error(
      `  ${colors.red("FAIL")} ${name} ${colors.dim(`(${ms}ms)`)}\n    ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    throw err
  }
}

async function discoverUsageFeature(): Promise<void> {
  if (FEATURE_SLUG) {
    await selectUsageFeature(FEATURE_SLUG)
    return
  }

  const { result, error } = await unprice.customers.getEntitlements({
    customerId: CUSTOMER_ID,
  })

  assert(!error, `getEntitlements error: ${error?.message}`)
  assert(!!result, "entitlements result should exist")
  assert(Array.isArray(result), "entitlements should be an array")
  assert(result.length > 0, "customer should have at least one entitlement")

  const featureSlugs = result
    .map((entitlement) => getFeatureSlugFromEntitlement(entitlement))
    .filter((featureSlug): featureSlug is string => !!featureSlug)

  assert(featureSlugs.length > 0, "could not resolve any feature slugs from customer entitlements")

  for (const featureSlug of featureSlugs) {
    const selected = await trySelectUsageFeature(featureSlug, { requireAllowed: false })
    if (selected) {
      return
    }
  }

  throw new Error(
    `No usage entitlement with meterConfig.eventSlug found for customer ${CUSTOMER_ID}. Entitlements: ${featureSlugs.join(
      ", "
    )}`
  )
}

async function selectUsageFeature(featureSlug: string): Promise<void> {
  const selected = await trySelectUsageFeature(featureSlug, { requireAllowed: true })
  assert(
    selected,
    `feature ${featureSlug} is not an allowed usage feature with meterConfig.eventSlug for customer ${CUSTOMER_ID}`
  )
}

async function trySelectUsageFeature(
  featureSlug: string,
  opts: { requireAllowed: boolean }
): Promise<boolean> {
  const { result, error } = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug,
  })

  if (error || !result?.meterConfig?.eventSlug) {
    return false
  }

  if (result.allowed !== true) {
    assert(
      !opts.requireAllowed,
      `usage feature ${featureSlug} is not allowed, status=${result.status}`
    )
    return false
  }

  selectedUsageFeature = {
    featureSlug,
    eventSlug: result.meterConfig.eventSlug,
    aggregationMethod: result.meterConfig.aggregationMethod,
    aggregationField: result.meterConfig.aggregationField,
  }
  currentUsage = result.usage ?? 0
  currentLimit = result.limit

  console.info(
    `    feature: ${featureSlug} (${selectedUsageFeature.eventSlug}, ${selectedUsageFeature.aggregationMethod})`
  )
  console.info(`    baseline: usage=${currentUsage}, limit=${currentLimit ?? "none"}`)
  return true
}

async function ingestUsageAmounts(usageAmounts: number[], label: string): Promise<void> {
  assert(selectedUsageFeature, "usage feature should be selected before ingestion")

  const timestampBase = Date.now()
  for (const [index, usageAmount] of usageAmounts.entries()) {
    const properties = buildIngestionProperties(usageAmount, selectedUsageFeature)
    const idempotencyKey = randomUUID()
    const { result, error } = await unprice.events.ingestSync({
      customerId: CUSTOMER_ID,
      eventSlug: selectedUsageFeature.eventSlug,
      featureSlug: selectedUsageFeature.featureSlug,
      properties,
      timestamp: timestampBase + index,
      idempotencyKey,
    })

    assert(!error, `${label} ingestSync error: ${error?.message}`)
    assert(!!result, `${label} ingestSync result should exist`)
    assert(
      result.allowed === true,
      `${label} ingestSync rejected at event ${index + 1}/${usageAmounts.length}: ${
        result.rejectionReason ?? "unknown reason"
      }`
    )

    ingestedEvents++
  }

  console.info(
    `    ${label}: ingested ${usageAmounts.length} event(s), amounts=${usageAmounts.join(", ")}`
  )
}

async function ingestSingleUsage(): Promise<void> {
  assert(selectedUsageFeature, "usage feature should be selected before single usage")

  singleUsageBefore = currentUsage
  singleUsageAmounts = buildUsageAmounts(
    selectedUsageFeature.aggregationMethod,
    singleUsageBefore,
    currentLimit,
    1,
    USAGE_AMOUNT
  )

  await ingestUsageAmounts(singleUsageAmounts, "single")
}

async function verifySingleUsageDelta(): Promise<void> {
  await verifyUsageDelta("single", singleUsageBefore, singleUsageAmounts)
}

async function ingestBulkUsage(): Promise<void> {
  assert(selectedUsageFeature, "usage feature should be selected before bulk usage")

  bulkUsageBefore = currentUsage
  bulkUsageAmounts =
    TOTAL_USAGE_AMOUNT == null
      ? buildUsageAmounts(
          selectedUsageFeature.aggregationMethod,
          bulkUsageBefore,
          currentLimit,
          BULK_USAGE_EVENTS,
          BULK_USAGE_AMOUNT
        )
      : buildTotalUsageAmounts(
          selectedUsageFeature.aggregationMethod,
          bulkUsageBefore,
          currentLimit,
          TOTAL_USAGE_AMOUNT,
          BULK_USAGE_EVENTS
        )

  await ingestUsageAmounts(bulkUsageAmounts, "bulk")
}

async function verifyBulkUsageDelta(): Promise<void> {
  await verifyUsageDelta("bulk", bulkUsageBefore, bulkUsageAmounts)
}

async function verifyUsageDelta(
  label: string,
  previousUsage: number,
  usageAmounts: number[]
): Promise<void> {
  assert(selectedUsageFeature, "usage feature should be selected before verifying usage")

  const { result, error } = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: selectedUsageFeature.featureSlug,
  })

  assert(!error, `${label} post-ingest verify error: ${error?.message}`)
  assert(!!result, `${label} post-ingest verify result should exist`)

  const actualUsage = result.usage ?? previousUsage
  const expectedUsage = expectedUsageAfter(
    previousUsage,
    selectedUsageFeature.aggregationMethod,
    usageAmounts
  )

  assert(
    actualUsage === expectedUsage,
    `${label} expected usage ${expectedUsage}, got ${actualUsage}`
  )

  currentUsage = actualUsage
  currentLimit = result.limit

  console.info(
    `    ${label}: usage ${previousUsage} -> ${actualUsage} (${selectedUsageFeature.aggregationMethod})`
  )
}

async function main(): Promise<void> {
  console.info(`\n${colors.cyan("Usage E2E")} against ${colors.dim(UNPRICE_API_URL)}\n`)
  console.info(`  customer: ${CUSTOMER_ID}`)
  if (FEATURE_SLUG) console.info(`  feature: ${FEATURE_SLUG}`)
  console.info(`  single usage amount: ${USAGE_AMOUNT}`)
  console.info(`  bulk usage events: ${BULK_USAGE_EVENTS}`)
  console.info(`  bulk usage amount: ${BULK_USAGE_AMOUNT}`)
  if (TOTAL_USAGE_AMOUNT != null) console.info(`  total usage amount: ${TOTAL_USAGE_AMOUNT}`)
  console.info("")

  await step("usage feature: discover from existing customer", discoverUsageFeature)
  await step("sync ingestion: reports one usage event", ingestSingleUsage)
  await step("verification: single usage delta is reflected", verifySingleUsageDelta)
  await step("sync ingestion: reports bulk usage events", ingestBulkUsage)
  await step("verification: bulk usage delta is reflected", verifyBulkUsageDelta)

  console.info(`\n  ${colors.green("5 passed")} (${ingestedEvents} usage events ingested)\n`)
}

main().catch(() => {
  process.exit(1)
})
