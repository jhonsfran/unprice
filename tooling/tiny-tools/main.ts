import { randomUUID } from "node:crypto"
import { Unprice } from "@unprice/api"

// ─── Config ──────────────────────────────────────────────────────────────────

const CUSTOMER_ID = process.env.CUSTOMER_ID || ""
const UNPRICE_TOKEN = process.env.UNPRICE_TOKEN || ""
const UNPRICE_API_URL = process.env.UNPRICE_API_URL || "http://localhost:8787"

// which tests to run (comma-separated), empty = all
const ONLY = process.env.ONLY?.split(",").map((s) => s.trim()) ?? []

const unprice = new Unprice({
  token: UNPRICE_TOKEN,
  baseUrl: UNPRICE_API_URL,
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

let passed = 0
let failed = 0
let skipped = 0

class SkipTestError extends Error {}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function skip(message: string): never {
  throw new SkipTestError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getFeatureSlug(entitlement: unknown): string | null {
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

function normalizeEntitlement(entitlement: unknown): { id: string; featureSlug: string } | null {
  if (!isRecord(entitlement)) return null

  const featureSlug = getFeatureSlug(entitlement)
  if (!featureSlug) return null

  return {
    id: typeof entitlement.id === "string" ? entitlement.id : featureSlug,
    featureSlug,
  }
}

function buildIngestionProperties(
  usage: number,
  meterConfig:
    | {
        aggregationMethod: "sum" | "count" | "max" | "latest"
        aggregationField?: string
      }
    | undefined
): Record<string, unknown> | null {
  if (!meterConfig) return null
  if (meterConfig.aggregationMethod === "count") return {}

  const field = meterConfig.aggregationField?.trim()
  if (!field) return null

  return { [field]: usage }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Test runner ─────────────────────────────────────────────────────────────

type TestFn = () => Promise<void>

const tests: Array<{ name: string; fn: TestFn }> = []

function test(name: string, fn: TestFn) {
  tests.push({ name, fn })
}

async function runTests() {
  if (!CUSTOMER_ID) {
    console.error(colors.red("CUSTOMER_ID env var is required"))
    process.exit(1)
  }
  if (!UNPRICE_TOKEN) {
    console.error(colors.red("UNPRICE_TOKEN env var is required"))
    process.exit(1)
  }

  console.info(
    `\n${colors.cyan("E2E Tests")} against ${colors.dim(UNPRICE_API_URL)} for customer ${colors.dim(CUSTOMER_ID)}\n`
  )

  for (const t of tests) {
    if (ONLY.length > 0 && !ONLY.some((o) => t.name.toLowerCase().includes(o.toLowerCase()))) {
      skipped++
      console.info(`  ${colors.yellow("SKIP")} ${t.name}`)
      continue
    }

    const start = performance.now()
    try {
      await t.fn()
      const ms = (performance.now() - start).toFixed(0)
      passed++
      console.info(`  ${colors.green("PASS")} ${t.name} ${colors.dim(`(${ms}ms)`)}`)
    } catch (err) {
      const ms = (performance.now() - start).toFixed(0)
      if (err instanceof SkipTestError) {
        skipped++
        console.info(
          `  ${colors.yellow("SKIP")} ${t.name} ${colors.dim(`(${ms}ms)`)}\n    ${err.message}`
        )
        continue
      }

      failed++
      console.error(
        `  ${colors.red("FAIL")} ${t.name} ${colors.dim(`(${ms}ms)`)}\n    ${(err as Error).message}`
      )
    }
  }

  console.info(
    `\n  ${colors.green(`${passed} passed`)}${failed ? `, ${colors.red(`${failed} failed`)}` : ""}${skipped ? `, ${colors.yellow(`${skipped} skipped`)}` : ""}\n`
  )

  process.exit(failed > 0 ? 1 : 0)
}

// ─── Shared state across tests ───────────────────────────────────────────────
// Tests run sequentially, so later tests can rely on state from earlier ones.

let entitlements: Array<{ id: string; featureSlug: string }> = []
// pick a usage-based feature for ingestion tests
let usageFeature: {
  featureSlug: string
  eventSlug: string
  aggregationMethod: string
  aggregationField?: string
} | null = null
let ingestionUnavailableReason: string | null = null

// ─── Tests ───────────────────────────────────────────────────────────────────

test("subscription: is active", async () => {
  const { result, error } = await unprice.customers.getSubscription({
    customerId: CUSTOMER_ID,
  })

  assert(!error, `getSubscription error: ${error?.message}`)
  assert(!!result, "subscription result should exist")
  assert(result?.active === true, `subscription should be active, got status=${result?.status}`)
  assert(
    ["active", "trialing"].includes(result?.status ?? ""),
    `expected status active|trialing, got ${result?.status}`
  )

  console.info(`    subscription: ${result?.planSlug} (${result?.status})`)
})

test("entitlements: fetches list", async () => {
  const { result, error } = await unprice.customers.getEntitlements({
    customerId: CUSTOMER_ID,
  })

  assert(!error, `getEntitlements error: ${error?.message}`)
  assert(!!result, "entitlements result should exist")
  assert(Array.isArray(result), "entitlements should be an array")
  assert((result?.length ?? 0) > 0, "customer should have at least 1 entitlement")

  const normalizedEntitlements = (result ?? [])
    .map((entitlement) => normalizeEntitlement(entitlement))
    .filter((entitlement): entitlement is { id: string; featureSlug: string } => !!entitlement)

  assert(
    normalizedEntitlements.length === result?.length,
    `could not resolve featureSlug for ${(result?.length ?? 0) - normalizedEntitlements.length} entitlement(s)`
  )

  entitlements = normalizedEntitlements
  console.info(
    `    found ${entitlements.length} entitlements: ${entitlements.map((e) => e.featureSlug).join(", ")}`
  )
})

test("verification: verify all entitlements", async () => {
  assert(entitlements.length > 0, "no entitlements loaded (did previous test fail?)")

  for (const ent of entitlements) {
    const { result, error } = await unprice.customers.verify({
      customerId: CUSTOMER_ID,
      featureSlug: ent.featureSlug,
    })

    assert(!error, `verify ${ent.featureSlug} error: ${error?.message}`)
    assert(!!result, `verify ${ent.featureSlug}: result should exist`)
    assert(
      typeof result?.allowed === "boolean",
      `verify ${ent.featureSlug}: allowed should be boolean`
    )
    assert(!!result?.status, `verify ${ent.featureSlug}: status should exist`)

    // discover a usage-based feature for ingestion tests
    if (result?.meterConfig?.eventSlug && !usageFeature) {
      usageFeature = {
        featureSlug: ent.featureSlug,
        eventSlug: result?.meterConfig?.eventSlug,
        aggregationMethod: result.meterConfig.aggregationMethod,
        aggregationField: result?.meterConfig?.aggregationField,
      }
    }
  }

  if (usageFeature) {
    console.info(
      `    usage feature for ingestion tests: ${usageFeature.featureSlug} (event: ${usageFeature.eventSlug})`
    )
  } else {
    console.info(
      `    ${colors.yellow("no usage-based features found — ingestion tests will be skipped")}`
    )
  }
})

test("sync-ingestion: ingest and verify usage delta", async () => {
  if (!usageFeature) {
    skip("no usage-based feature found")
  }
  if (ingestionUnavailableReason) {
    skip(ingestionUnavailableReason)
  }

  // 1. Verify before ingestion
  const before = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: usageFeature.featureSlug,
  })

  assert(!before.error, `pre-verify error: ${before.error?.message}`)
  assert(
    before.result?.allowed === true,
    `feature ${usageFeature.featureSlug} not allowed — cannot test ingestion`
  )

  const usageBefore = before.result?.usage ?? 0

  // 2. Build ingestion payload
  const ingestAmount = 5
  const props = buildIngestionProperties(ingestAmount, {
    aggregationMethod: usageFeature.aggregationMethod as "sum" | "count" | "max" | "latest",
    aggregationField: usageFeature.aggregationField,
  })
  assert(props !== null, "could not build ingestion properties")

  // 3. Sync ingest
  const ingestResult = await unprice.events.ingestSync({
    customerId: CUSTOMER_ID,
    eventSlug: usageFeature.eventSlug,
    featureSlug: usageFeature.featureSlug,
    properties: props!,
    idempotencyKey: randomUUID(),
  })

  assert(!ingestResult.error, `ingestSync error: ${ingestResult.error?.message}`)
  const rejectionReason = ingestResult.result?.rejectionReason as string | undefined
  if (ingestResult.result?.allowed === false && rejectionReason === "WALLET_EMPTY") {
    ingestionUnavailableReason = `sync ingestion rejected: ${rejectionReason}`
    skip(ingestionUnavailableReason)
  }
  assert(ingestResult.result?.allowed === true, `ingestSync rejected: ${rejectionReason}`)

  // 4. Verify after ingestion — usage should have changed
  const after = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: usageFeature.featureSlug,
  })

  assert(!after.error, `post-verify error: ${after.error?.message}`)

  const usageAfter = after.result?.usage ?? 0
  const method = usageFeature.aggregationMethod

  if (method === "sum") {
    assert(
      usageAfter === usageBefore + ingestAmount,
      `expected usage ${usageBefore + ingestAmount}, got ${usageAfter}`
    )
  } else if (method === "count") {
    assert(usageAfter === usageBefore + 1, `expected count ${usageBefore + 1}, got ${usageAfter}`)
  } else if (method === "max") {
    assert(usageAfter >= ingestAmount, `expected max >= ${ingestAmount}, got ${usageAfter}`)
  } else if (method === "latest") {
    assert(usageAfter === ingestAmount, `expected latest = ${ingestAmount}, got ${usageAfter}`)
  }

  console.info(`    usage: ${usageBefore} → ${usageAfter} (${method}, ingested ${ingestAmount})`)
})

test("async-ingestion: ingest and poll for eventual consistency", async () => {
  if (!usageFeature) {
    skip("no usage-based feature found")
  }
  if (ingestionUnavailableReason) {
    skip(ingestionUnavailableReason)
  }

  // 1. Verify before
  const before = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: usageFeature.featureSlug,
  })

  assert(!before.error, `pre-verify error: ${before.error?.message}`)
  assert(before.result?.allowed === true, "feature not allowed — cannot test async ingestion")

  const usageBefore = before.result?.usage ?? 0

  // 2. Async ingest
  const ingestAmount = 3
  const props = buildIngestionProperties(ingestAmount, {
    aggregationMethod: usageFeature.aggregationMethod as "sum" | "count" | "max" | "latest",
    aggregationField: usageFeature.aggregationField,
  })
  assert(props !== null, "could not build ingestion properties")

  const ingestResult = await unprice.events.ingest({
    customerId: CUSTOMER_ID,
    eventSlug: usageFeature.eventSlug,
    properties: props!,
    idempotencyKey: randomUUID(),
  })

  assert(!ingestResult.error, `async ingest error: ${ingestResult.error?.message}`)
  assert(ingestResult.result?.accepted === true, "async event should be accepted")

  // 3. Poll until usage reflects the change (max 10s)
  let usageAfter = usageBefore
  const deadline = Date.now() + 10_000
  const method = usageFeature.aggregationMethod

  while (Date.now() < deadline) {
    await sleep(500)

    const check = await unprice.customers.verify({
      customerId: CUSTOMER_ID,
      featureSlug: usageFeature.featureSlug,
    })

    if (check.error) continue
    usageAfter = check.result?.usage ?? usageBefore

    // check if usage has changed from the baseline
    if (usageAfter !== usageBefore) break
  }

  if (method === "sum") {
    assert(
      usageAfter === usageBefore + ingestAmount,
      `expected usage ${usageBefore + ingestAmount}, got ${usageAfter} (may need more poll time)`
    )
  } else if (method === "count") {
    assert(usageAfter === usageBefore + 1, `expected count ${usageBefore + 1}, got ${usageAfter}`)
  }

  console.info(`    async usage: ${usageBefore} → ${usageAfter} (polled until consistent)`)
})

test("idempotency: duplicate key is deduplicated", async () => {
  if (!usageFeature) {
    skip("no usage-based feature found")
  }
  if (ingestionUnavailableReason) {
    skip(ingestionUnavailableReason)
  }

  // 1. Verify baseline
  const before = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: usageFeature.featureSlug,
  })

  assert(!before.error, `pre-verify error: ${before.error?.message}`)
  assert(before.result?.allowed === true, "feature not allowed")

  const usageBefore = before.result?.usage ?? 0
  const ingestAmount = 7
  const idempotencyKey = randomUUID()

  const props = buildIngestionProperties(ingestAmount, {
    aggregationMethod: usageFeature.aggregationMethod as "sum" | "count" | "max" | "latest",
    aggregationField: usageFeature.aggregationField,
  })
  assert(props !== null, "could not build ingestion properties")

  // 2. Send the same event twice with the same idempotency key
  const first = await unprice.events.ingestSync({
    customerId: CUSTOMER_ID,
    eventSlug: usageFeature.eventSlug,
    featureSlug: usageFeature.featureSlug,
    properties: props!,
    idempotencyKey,
  })
  assert(!first.error, `first ingest error: ${first.error?.message}`)

  const second = await unprice.events.ingestSync({
    customerId: CUSTOMER_ID,
    eventSlug: usageFeature.eventSlug,
    featureSlug: usageFeature.featureSlug,
    properties: props!,
    idempotencyKey,
  })
  // second call should succeed (idempotent) but not double-count
  assert(!second.error, `second ingest error: ${second.error?.message}`)

  // 3. Verify usage increased only once
  const after = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: usageFeature.featureSlug,
  })

  assert(!after.error, `post-verify error: ${after.error?.message}`)
  const usageAfter = after.result?.usage ?? 0

  const method = usageFeature.aggregationMethod
  if (method === "sum") {
    assert(
      usageAfter === usageBefore + ingestAmount,
      `idempotency failed: expected ${usageBefore + ingestAmount}, got ${usageAfter} (double-counted?)`
    )
  } else if (method === "count") {
    assert(
      usageAfter === usageBefore + 1,
      `idempotency failed: expected ${usageBefore + 1}, got ${usageAfter}`
    )
  }

  console.info(`    usage: ${usageBefore} → ${usageAfter} (same key sent twice, counted once)`)
})

test("limit-enforcement: sync ingest rejects when limit exceeded", async () => {
  if (!usageFeature) {
    skip("no usage-based feature found")
  }
  if (ingestionUnavailableReason) {
    skip(ingestionUnavailableReason)
  }

  // 1. Check current state
  const check = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: usageFeature.featureSlug,
  })

  assert(!check.error, `verify error: ${check.error?.message}`)

  const limit = check.result?.limit
  const currentUsage = check.result?.usage ?? 0

  if (limit === null || limit === undefined) {
    console.info(`    ${colors.yellow("no limit set on this feature — skipping")}`)
    return
  }

  if (!check.result?.allowed) {
    // already at limit, try one more ingest to confirm rejection
    const props = buildIngestionProperties(1, {
      aggregationMethod: usageFeature.aggregationMethod as "sum" | "count" | "max" | "latest",
      aggregationField: usageFeature.aggregationField,
    })

    if (props) {
      const res = await unprice.events.ingestSync({
        customerId: CUSTOMER_ID,
        eventSlug: usageFeature.eventSlug,
        featureSlug: usageFeature.featureSlug,
        properties: props,
        idempotencyKey: randomUUID(),
      })

      assert(!res.error, `ingestSync error: ${res.error?.message}`)
      assert(res.result?.allowed === false, "expected rejection when limit already reached")
      assert(
        res.result?.rejectionReason === "LIMIT_EXCEEDED",
        `expected LIMIT_EXCEEDED, got ${res.result?.rejectionReason}`
      )
    }

    console.info(`    limit already reached (${currentUsage}/${limit}), rejection confirmed`)
    return
  }

  // Not at limit yet — try to push over
  const remaining = limit - currentUsage
  if (remaining > 100) {
    console.info(
      `    ${colors.yellow(`too far from limit (${currentUsage}/${limit}) — skipping exhaustion`)}`
    )
    return
  }

  // Ingest enough to exceed the limit
  const overshoot = remaining + 1
  const props = buildIngestionProperties(overshoot, {
    aggregationMethod: usageFeature.aggregationMethod as "sum" | "count" | "max" | "latest",
    aggregationField: usageFeature.aggregationField,
  })
  assert(props !== null, "could not build ingestion properties")

  const res = await unprice.events.ingestSync({
    customerId: CUSTOMER_ID,
    eventSlug: usageFeature.eventSlug,
    featureSlug: usageFeature.featureSlug,
    properties: props!,
    idempotencyKey: randomUUID(),
  })

  assert(!res.error, `ingestSync error: ${res.error?.message}`)

  // depending on overage strategy this might be allowed (last-call) or rejected
  if (res.result?.allowed === false) {
    assert(
      res.result?.rejectionReason === "LIMIT_EXCEEDED",
      `expected LIMIT_EXCEEDED, got ${res.result?.rejectionReason}`
    )
    console.info(`    ingestion rejected at limit (${currentUsage}/${limit})`)
  } else {
    console.info(
      `    overage allowed (strategy: ${check.result?.overageStrategy}), usage=${currentUsage + overshoot}/${limit}`
    )
  }
})

test("analytics: getUsage returns data", async () => {
  const { result, error } = await unprice.analytics.getUsage({
    customer_id: CUSTOMER_ID,
    range: "24h",
  })

  assert(!error, `getUsage error: ${error?.message}`)
  assert(!!result, "usage result should exist")
  assert(Array.isArray(result?.usage), "usage should be an array")

  console.info(`${result?.usage?.length} usage records in last 24h`)

  if (usageFeature && (result?.usage?.length ?? 0) > 0) {
    const featureUsage = result?.usage?.find((u) => u.feature_slug === usageFeature!.featureSlug)
    if (featureUsage) {
      console.info(`    ${usageFeature.featureSlug}: value=${featureUsage.value_after}`)
    }
  }
})

test("verification: non-existent feature returns proper error", async () => {
  const fakeSlug = `fake_feature_${Date.now()}`
  const { result, error } = await unprice.customers.verify({
    customerId: CUSTOMER_ID,
    featureSlug: fakeSlug,
  })

  // The API should either return an error or a result with allowed=false
  if (error) {
    // API-level error is acceptable
    console.info(`    API error for fake feature: ${error.code}`)
    return
  }

  assert(!!result, "result should exist")
  assert(
    result.allowed === false,
    `fake feature should not be allowed, got allowed=${result.allowed}`
  )
  assert(
    result.status === "feature_missing" || result.status === "feature_inactive",
    `expected feature_missing|feature_inactive, got ${result.status}`
  )

  console.info(`    correctly denied: status=${result.status}`)
})

test("verification: non-existent customer returns proper error", async () => {
  const fakeCustomer = `cus_fake_${Date.now()}`
  const { result, error } = await unprice.customers.verify({
    customerId: fakeCustomer,
    featureSlug: entitlements[0]?.featureSlug ?? "any",
  })

  if (error) {
    console.info(`    API error for fake customer: ${error.code}`)
    return
  }

  assert(!!result, "result should exist")
  assert(result?.allowed === false, "fake customer should not be allowed")
  assert(
    result.status === "customer_not_found",
    `expected customer_not_found, got ${result.status}`
  )

  console.info(`    correctly denied: status=${result.status}`)
})

// ─── Run ─────────────────────────────────────────────────────────────────────

runTests()
