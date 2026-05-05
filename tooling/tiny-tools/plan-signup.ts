import { Unprice, type paths } from "@unprice/api"

type ListPlanVersionsRequest =
  paths["/v1/plans/listPlanVersions"]["post"]["requestBody"]["content"]["application/json"]
type ListPlanVersionsResponse =
  paths["/v1/plans/listPlanVersions"]["post"]["responses"]["200"]["content"]["application/json"]
type PlanVersion = ListPlanVersionsResponse["planVersions"][number]
type SignUpRequest =
  paths["/v1/customer/signUp"]["post"]["requestBody"]["content"]["application/json"]

type BillingInterval = NonNullable<ListPlanVersionsRequest["billingInterval"]>
type Currency = NonNullable<ListPlanVersionsRequest["currency"]>

const BILLING_INTERVALS = ["month", "year", "week", "day", "minute", "onetime"] as const
const CURRENCIES = ["USD", "EUR"] as const

const UNPRICE_TOKEN = process.env.UNPRICE_TOKEN || ""
const UNPRICE_API_URL = process.env.UNPRICE_API_URL || "http://localhost:8787"
const PLAN_SLUG = process.env.PLAN_SLUG?.trim() || "free"
const BILLING_INTERVAL = getOptionalEnvValue("BILLING_INTERVAL", BILLING_INTERVALS)
const CURRENCY = getOptionalEnvValue("CURRENCY", CURRENCIES)

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

if (!UNPRICE_TOKEN) {
  console.error(colors.red("UNPRICE_TOKEN env var is required"))
  process.exit(1)
}

const unprice = new Unprice({
  token: UNPRICE_TOKEN,
  baseUrl: UNPRICE_API_URL,
})

let selectedPlanVersion: PlanVersion | null = null
let customerId = ""
let externalId = ""
let email = ""

function getOptionalEnvValue<const T extends readonly string[]>(
  name: string,
  allowedValues: T
): T[number] | undefined {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return undefined

  if ((allowedValues as readonly string[]).includes(rawValue)) {
    return rawValue
  }

  throw new Error(`${name} must be one of: ${allowedValues.join(", ")}. Received: ${rawValue}`)
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

function getFeatureSlugFromPlanFeature(planFeature: PlanVersion["planFeatures"][number]): string {
  return planFeature.feature.slug
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

async function planPreflight(): Promise<void> {
  const request: ListPlanVersionsRequest = {
    onlyPublished: true,
    onlyLatest: true,
    onlyEnterprisePlan: false,
    ...(BILLING_INTERVAL ? { billingInterval: BILLING_INTERVAL as BillingInterval } : {}),
    ...(CURRENCY ? { currency: CURRENCY as Currency } : {}),
  }

  const { result, error } = await unprice.plans.listPlanVersions(request)

  assert(!error, `listPlanVersions error: ${error?.message}`)
  assert(!!result, "listPlanVersions result should exist")
  assert(Array.isArray(result.planVersions), "planVersions should be an array")
  assert(result.planVersions.length > 0, "at least one published latest plan version should exist")

  const availablePlanSlugs = Array.from(
    new Set(result.planVersions.map((version) => version.plan.slug))
  ).sort()
  const planVersion = result.planVersions.find((version) => version.plan.slug === PLAN_SLUG)

  assert(
    !!planVersion,
    `plan slug ${PLAN_SLUG} was not found. Available slugs: ${availablePlanSlugs.join(", ")}`
  )
  assert(planVersion.status === "published", `expected published plan, got ${planVersion.status}`)
  assert(planVersion.active === true, `expected active plan version, got ${planVersion.active}`)
  assert(
    Array.isArray(planVersion.planFeatures) && planVersion.planFeatures.length > 0,
    "selected plan version should include at least one plan feature"
  )

  selectedPlanVersion = planVersion
  console.info(
    `    plan: ${planVersion.plan.slug} (${planVersion.id}, ${planVersion.billingConfig.billingInterval}, ${planVersion.currency})`
  )
  console.info(
    `    features: ${planVersion.planFeatures.map(getFeatureSlugFromPlanFeature).join(", ")}`
  )
}

async function customerSignup(): Promise<void> {
  assert(selectedPlanVersion, "selected plan version should be loaded before signup")

  const runId = Math.random().toString(8).substring(2, 10)
  externalId = `tiny-tools-signup-${runId}`
  email = `tiny-tools-signup+${runId}@example.com`

  const request: SignUpRequest = {
    name: "Tiny Tools Signup E2E Customer",
    email,
    externalId,
    planSlug: PLAN_SLUG,
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
    timezone: "UTC",
    metadata: {
      country: "US",
      region: "E2E",
      city: "Local",
    },
    ...(BILLING_INTERVAL ? { billingInterval: BILLING_INTERVAL as BillingInterval } : {}),
    ...(CURRENCY ? { defaultCurrency: CURRENCY as Currency } : {}),
  }

  const { result, error } = await unprice.customers.signUp(request)

  assert(!error, `signUp error: ${error?.message}`)
  assert(!!result, "signUp result should exist")
  assert(result.success === true, `signUp should succeed, got success=${result.success}`)
  assert(
    typeof result.customerId === "string" && result.customerId.trim(),
    "customerId should exist"
  )

  customerId = result.customerId

  console.info(`    customerId: ${customerId}`)
  console.info(`    externalId: ${externalId}`)
  console.info(`    email: ${email}`)
  console.info(`    planVersionId: ${selectedPlanVersion.id}`)
}

async function subscriptionCheck(): Promise<void> {
  assert(customerId, "customerId should be loaded before checking subscription")

  const { result, error } = await unprice.customers.getSubscription({
    customerId,
  })

  assert(!error, `getSubscription error: ${error?.message}`)
  assert(!!result, "subscription result should exist")
  assert(result.active === true, `subscription should be active, got active=${result.active}`)
  assert(
    ["active", "trialing"].includes(result.status),
    `subscription status should be active or trialing, got ${result.status}`
  )
  assert(
    result.planSlug === PLAN_SLUG,
    `subscription planSlug should be ${PLAN_SLUG}, got ${result.planSlug}`
  )

  console.info(`    subscription: ${result.planSlug} (${result.status})`)
}

async function entitlementsCheck(): Promise<void> {
  assert(customerId, "customerId should be loaded before checking entitlements")
  assert(selectedPlanVersion, "selected plan version should be loaded before checking entitlements")

  const { result, error } = await unprice.customers.getEntitlements({
    customerId,
  })

  assert(!error, `getEntitlements error: ${error?.message}`)
  assert(!!result, "entitlements result should exist")
  assert(Array.isArray(result), "entitlements should be an array")
  assert(result.length > 0, "customer should have at least one entitlement")

  const entitlementFeatureSlugs = result
    .map((entitlement) => getFeatureSlugFromEntitlement(entitlement))
    .filter((featureSlug): featureSlug is string => !!featureSlug)
  const planFeatureSlugs = selectedPlanVersion.planFeatures.map(getFeatureSlugFromPlanFeature)
  const matchedFeatureSlugs = entitlementFeatureSlugs.filter((featureSlug) =>
    planFeatureSlugs.includes(featureSlug)
  )

  assert(
    entitlementFeatureSlugs.length === result.length,
    `could not resolve featureSlug for ${result.length - entitlementFeatureSlugs.length} entitlement(s)`
  )
  assert(
    matchedFeatureSlugs.length > 0,
    `expected at least one entitlement to match plan features. Entitlements: ${entitlementFeatureSlugs.join(
      ", "
    )}; plan features: ${planFeatureSlugs.join(", ")}`
  )

  console.info(`    entitlements: ${entitlementFeatureSlugs.join(", ")}`)
}

async function main(): Promise<void> {
  console.info(`\n${colors.cyan("Plan Signup E2E")} against ${colors.dim(UNPRICE_API_URL)}\n`)
  console.info(`  target plan: ${PLAN_SLUG}`)
  if (BILLING_INTERVAL) console.info(`  billing interval: ${BILLING_INTERVAL}`)
  if (CURRENCY) console.info(`  currency: ${CURRENCY}`)
  console.info("")

  await step("plan preflight: expected published plan exists", planPreflight)
  await step("customer signup: creates isolated customer", customerSignup)
  await step("subscription: new customer has active subscription", subscriptionCheck)
  await step("entitlements: new customer receives plan features", entitlementsCheck)

  console.info(`\n  ${colors.green("4 passed")}\n`)
}

main().catch(() => {
  process.exit(1)
})
