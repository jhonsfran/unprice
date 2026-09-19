import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Unprice } from "@unprice/api"
import {
  LOAD_TEST_EVENT_SLUGS,
  LOAD_TEST_FEATURE_SLUGS,
  LOAD_TEST_PLAN_SLUG,
  loadTestPricing,
} from "./load-test-pricing"

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const PRODUCTION_API_URL = "https://api.unprice.dev"
const BLOCKING_WARNING_CODES = new Set(["enforcement_settings_dropped", "version_settings_dropped"])

const baseUrl = requiredEnv("BASE_URL").replace(/\/$/, "")
const configToken = requiredEnv("UNPRICE_CONFIG_TOKEN")

if (baseUrl === PRODUCTION_API_URL && process.env.CONFIRM_PRODUCTION_LOAD_TEST !== "yes") {
  throw new Error(
    "Set CONFIRM_PRODUCTION_LOAD_TEST=yes after confirming that the key belongs to a disposable production project"
  )
}

const configClient = new Unprice({ baseUrl, token: configToken })

async function main(): Promise<void> {
  console.info(`Preparing ${LOAD_TEST_PLAN_SLUG} against ${baseUrl}`)

  await assertConfigurationCanBeManaged()

  const applied = await configClient.monetization.apply({ config: loadTestPricing })
  assertApiResult("monetization.apply", applied)

  const outcome = applied.result.plans.find(({ slug }) => slug === LOAD_TEST_PLAN_SLUG)
  if (!outcome) {
    throw new Error(`monetization.apply did not return ${LOAD_TEST_PLAN_SLUG}`)
  }

  if (applied.result.staleDrafts.length > 0) {
    console.warn("Stale pricing drafts:", applied.result.staleDrafts)
  }

  if (outcome.status !== "published") {
    console.info(`Pricing status: ${outcome.status}`)
    console.info(`Plan version: ${outcome.planVersionId}`)
    if (applied.result.reviewUrl) {
      console.info(`Review and publish: ${applied.result.reviewUrl}`)
    } else {
      console.info("Review and publish the matching draft in the Unprice dashboard.")
    }
    console.info("After publication, run this command again. No customer or usage was created.")
    return
  }

  const runtimeToken = requiredEnv("UNPRICE_TOKEN")
  const projectId = requiredEnv("PROJECT_ID")
  const runtimeClient = new Unprice({ baseUrl, token: runtimeToken })
  const latencyCustomerId = await signUpLoadTestCustomer(runtimeClient, "latency")

  runK6("latency", { baseUrl, customerId: latencyCustomerId, projectId, runtimeToken })

  const baselineCustomerId = await signUpLoadTestCustomer(runtimeClient, "baseline")
  const baselineStartedAt = Date.now() - 1_000

  runK6("baseline", { baseUrl, customerId: baselineCustomerId, projectId, runtimeToken })

  await verifyIngestion(runtimeClient, {
    customerId: baselineCustomerId,
    expectedMinimum: positiveInteger(process.env.EVENTS, 1_000) * LOAD_TEST_EVENT_SLUGS.length,
    fromTimestamp: baselineStartedAt,
  })
}

async function assertConfigurationCanBeManaged(): Promise<void> {
  const current = await configClient.monetization.get()
  assertApiResult("monetization.get", current)

  if (current.result.unrepresentablePlans.length > 0) {
    throw new Error(
      `The project has unrepresentable plans: ${JSON.stringify(current.result.unrepresentablePlans)}`
    )
  }

  const blockingWarnings = current.result.warnings.filter(({ code }) =>
    BLOCKING_WARNING_CODES.has(code)
  )
  if (blockingWarnings.length > 0) {
    throw new Error(
      `The project has blocking configuration warnings: ${JSON.stringify(blockingWarnings)}`
    )
  }

  const foreignPlanSlugs = current.result.config.plans
    .map(({ slug }) => slug)
    .filter((slug) => slug !== LOAD_TEST_PLAN_SLUG)
  const allowedEventSlugs = new Set<string>(LOAD_TEST_EVENT_SLUGS)
  const foreignEventSlugs = (current.result.config.events ?? [])
    .map(({ slug }) => slug)
    .filter((slug) => !allowedEventSlugs.has(slug))
  const allowedFeatureSlugs = new Set<string>(LOAD_TEST_FEATURE_SLUGS)
  const foreignFeatureSlugs = (current.result.config.features ?? [])
    .map(({ slug }) => slug)
    .filter((slug) => !allowedFeatureSlugs.has(slug))

  if (foreignPlanSlugs.length || foreignEventSlugs.length || foreignFeatureSlugs.length) {
    throw new Error(
      `Refusing to manage a project that is not dedicated to this load test. Other plans: ${foreignPlanSlugs.join(", ") || "none"}; other events: ${foreignEventSlugs.join(", ") || "none"}; other features: ${foreignFeatureSlugs.join(", ") || "none"}`
    )
  }
}

async function signUpLoadTestCustomer(
  client: Unprice,
  phase: "baseline" | "latency"
): Promise<string> {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const externalId = `k6-production-${phase}-${suffix}`
  const result = await client.customers.signUp({
    name: `k6 production ${phase} ${suffix}`,
    email: `k6-production-${phase}+${suffix}@example.com`,
    externalId,
    planSlug: LOAD_TEST_PLAN_SLUG,
    successUrl: "https://example.com/load-test/success",
    cancelUrl: "https://example.com/load-test/cancel",
    timezone: "UTC",
    defaultCurrency: "USD",
    billingInterval: "month",
    creditLinePolicy: "uncapped",
    metadata: { region: `k6-production-${phase}` },
  })
  assertApiResult("customers.signUp", result)

  if (!result.result.success || !result.result.customerId) {
    throw new Error("customers.signUp did not return a successful customer")
  }

  console.info(`${phase} customer: ${result.result.customerId}`)
  console.info(`External ID: ${externalId}`)
  return result.result.customerId
}

function runK6(
  script: "latency" | "baseline",
  input: { baseUrl: string; customerId: string; projectId: string; runtimeToken: string }
): void {
  console.info(`Starting k6 ${script}`)

  const child = spawnSync("corepack", ["pnpm", "--filter", "@unprice/k6", script], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      BASE_URL: input.baseUrl,
      COLD_SIGNUPS: "0",
      CUSTOMER_ID: input.customerId,
      PROJECT_ID: input.projectId,
      UNPRICE_TOKEN: input.runtimeToken,
    },
  })

  if (child.error) {
    throw child.error
  }
  if (child.status !== 0) {
    throw new Error(`k6 ${script} failed with exit code ${child.status ?? "unknown"}`)
  }
}

async function verifyIngestion(
  client: Unprice,
  input: { customerId: string; expectedMinimum: number; fromTimestamp: number }
): Promise<void> {
  const timeoutSeconds = positiveInteger(process.env.INGESTION_TIMEOUT_SECONDS, 120)
  const deadline = Date.now() + timeoutSeconds * 1_000
  let latest: Awaited<ReturnType<typeof client.ingestionEvents.status>>["result"]

  console.info(`Waiting for at least ${input.expectedMinimum} asynchronous ingestion results`)

  while (Date.now() < deadline) {
    const status = await client.ingestionEvents.status({
      customer_id: input.customerId,
      from_ts: input.fromTimestamp,
      to_ts: Date.now(),
      limit: 100,
    })
    assertApiResult("ingestionEvents.status", status)
    latest = status.result

    if (latest.totals.total >= input.expectedMinimum) {
      break
    }

    await delay(5_000)
  }

  if (!latest || latest.totals.total < input.expectedMinimum) {
    throw new Error(
      `Ingestion reconciliation timed out. Expected at least ${input.expectedMinimum}, observed ${latest?.totals.total ?? 0}`
    )
  }

  const summary = {
    customerId: input.customerId,
    expectedMinimum: input.expectedMinimum,
    ...latest.totals,
    successRate: latest.successRate,
    window: latest.window,
  }
  console.info(`INGESTION_SUMMARY_JSON=${JSON.stringify(summary)}`)

  if (latest.totals.failed > 0 || latest.totals.rejected > 0) {
    const unsuccessfulEvents = latest.recentEvents.filter(({ state }) => state !== "processed")
    console.error(`INGESTION_FAILURES_JSON=${JSON.stringify(unsuccessfulEvents)}`)
    throw new Error(
      `Ingestion finished with ${latest.totals.failed} failed and ${latest.totals.rejected} rejected events`
    )
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function assertApiResult<T>(
  operation: string,
  result: { result?: T; error?: { code?: string; message?: string; requestId?: string } }
): asserts result is { result: T; error?: undefined } {
  if (result.error) {
    throw new Error(
      `${operation} failed: ${result.error.code ?? "UNKNOWN"}: ${result.error.message ?? "No message"} (${result.error.requestId ?? "no request ID"})`
    )
  }
  if (result.result === undefined) {
    throw new Error(`${operation} returned no result`)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
