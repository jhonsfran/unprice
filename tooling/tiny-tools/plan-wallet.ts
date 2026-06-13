import { Unprice } from "@unprice/api"

type Currency = "USD" | "EUR"

type WalletAmount = {
  ledger_amount: number
  amount: string
  currency: Currency
  display_amount: string
}

type WalletCredit = {
  id: string
  source: string
  issued: WalletAmount
  available: WalletAmount
  expires_at: string | null
  created_at: string
}

type WalletSnapshot = {
  currency: Currency
  available: WalletAmount
  held: WalletAmount
  credits: WalletCredit[]
}

const UNPRICE_TOKEN = process.env.UNPRICE_TOKEN || "unprice_dev_1234567890"
const UNPRICE_API_URL = process.env.UNPRICE_API_URL || "http://localhost:8787"
const CUSTOMER_ID = process.env.CUSTOMER_ID?.trim() || ""
const PROJECT_ID = process.env.PROJECT_ID?.trim() || ""

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

let passed = 0
let walletSnapshot: WalletSnapshot | null = null
let cappedEntitlementCount = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCurrency(value: unknown): value is Currency {
  return value === "USD" || value === "EUR"
}

function assertWalletAmount(
  value: unknown,
  label: string,
  currency?: Currency
): asserts value is WalletAmount {
  assert(isRecord(value), `${label} should be an object`)
  const ledgerAmount = value.ledger_amount

  assert(
    typeof ledgerAmount === "number" && Number.isInteger(ledgerAmount) && ledgerAmount >= 0,
    `${label}.ledger_amount should be a non-negative integer`
  )
  assert(
    typeof value.amount === "string" && value.amount.length > 0,
    `${label}.amount should exist`
  )
  assert(isCurrency(value.currency), `${label}.currency should be USD or EUR`)
  if (currency) {
    assert(
      value.currency === currency,
      `${label}.currency should match wallet currency ${currency}`
    )
  }
  assert(
    typeof value.display_amount === "string" && value.display_amount.length > 0,
    `${label}.display_amount should be a non-empty string`
  )
}

function assertWalletSnapshot(value: unknown): asserts value is WalletSnapshot {
  assert(isRecord(value), "wallet response should be an object")
  assert(isCurrency(value.currency), "wallet currency should be USD or EUR")

  assertWalletAmount(value.available, "available", value.currency)
  assertWalletAmount(value.held, "held", value.currency)

  assert(Array.isArray(value.credits), "wallet credits should be an array")
  for (const [index, credit] of value.credits.entries()) {
    assert(isRecord(credit), `credits[${index}] should be an object`)
    assert(
      typeof credit.id === "string" && credit.id.length > 0,
      `credits[${index}].id should exist`
    )
    assert(
      typeof credit.source === "string" && credit.source.length > 0,
      `credits[${index}].source should exist`
    )
    assertWalletAmount(credit.issued, `credits[${index}].issued`, value.currency)
    assertWalletAmount(credit.available, `credits[${index}].available`, value.currency)
    assert(
      credit.available.ledger_amount <= credit.issued.ledger_amount,
      `credits[${index}].available should be <= issued`
    )
    assert(
      credit.expires_at === null || typeof credit.expires_at === "string",
      `credits[${index}].expires_at should be null or a string`
    )
    assert(typeof credit.created_at === "string", `credits[${index}].created_at should be a string`)
  }
}

function getCreditLinePolicy(entitlement: unknown): string | null {
  if (!isRecord(entitlement)) return null

  const subscriptionPhase = entitlement.subscriptionPhase
  if (!isRecord(subscriptionPhase)) return null

  return typeof subscriptionPhase.creditLinePolicy === "string"
    ? subscriptionPhase.creditLinePolicy
    : null
}

function getFeatureSlug(entitlement: unknown): string {
  if (!isRecord(entitlement)) return "unknown"

  const directSlug = entitlement.featureSlug
  if (typeof directSlug === "string" && directSlug.trim()) return directSlug

  const featurePlanVersion = entitlement.featurePlanVersion
  if (!isRecord(featurePlanVersion)) return "unknown"

  const feature = featurePlanVersion.feature
  if (!isRecord(feature)) return "unknown"

  return typeof feature.slug === "string" && feature.slug.trim() ? feature.slug : "unknown"
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now()

  try {
    await fn()
    passed++
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

async function verifyCappedEntitlement(): Promise<void> {
  const { result, error } = await unprice.entitlements.get({
    customerId: CUSTOMER_ID,
    ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
  })

  assert(!error, `entitlements.get error: ${error?.message}`)
  assert(!!result, "entitlements result should exist")
  assert(Array.isArray(result), "entitlements result should be an array")

  const cappedFeatures = result
    .filter((entitlement) => getCreditLinePolicy(entitlement) === "capped")
    .map((entitlement) => getFeatureSlug(entitlement))

  cappedEntitlementCount = cappedFeatures.length
  assert(cappedEntitlementCount > 0, "wallet E2E requires at least one capped entitlement")

  console.info(`    capped entitlements: ${cappedFeatures.join(", ")}`)
}

async function fetchWallet(): Promise<void> {
  const { result, error } = await unprice.wallet.get({
    customerId: CUSTOMER_ID,
    ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
  })

  assert(!error, `wallet.get error: ${error?.message}`)
  assert(!!result, "wallet result should exist")
  assertWalletSnapshot(result)

  walletSnapshot = result

  console.info(`    available: ${result.available.display_amount}`)
  console.info(`    held: ${result.held.display_amount}`)
}

async function verifyCreditsReconcile(): Promise<void> {
  assert(walletSnapshot, "wallet should be loaded before verifying credits")

  const availableCreditAmount = walletSnapshot.credits.reduce(
    (total, credit) => total + credit.available.ledger_amount,
    0
  )

  const issuedCreditAmount = walletSnapshot.credits.reduce(
    (total, credit) => total + credit.issued.ledger_amount,
    0
  )

  assert(
    walletSnapshot.available.ledger_amount >= availableCreditAmount,
    `wallet available should be >= active credit availability (${walletSnapshot.available.ledger_amount} < ${availableCreditAmount})`
  )
  assert(
    issuedCreditAmount >= availableCreditAmount,
    `issued credits should be >= available credits (${issuedCreditAmount} < ${availableCreditAmount})`
  )

  console.info(`    active credits: ${walletSnapshot.credits.length}`)
  console.info(`    credit availability: ${walletSnapshot.available.display_amount}`)
}

async function main(): Promise<void> {
  console.info(`\n${colors.cyan("Wallet E2E")} against ${colors.dim(UNPRICE_API_URL)}\n`)
  console.info(`  customer: ${CUSTOMER_ID}`)
  if (PROJECT_ID) console.info(`  project: ${PROJECT_ID}`)
  console.info("")

  await step("entitlements: customer has capped wallet-backed entitlement", verifyCappedEntitlement)
  await step("wallet: returns current available balance", fetchWallet)
  await step("wallet: credits reconcile to available balance", verifyCreditsReconcile)

  console.info(
    `\n  ${colors.green(`${passed} passed`)} (${cappedEntitlementCount} capped entitlement(s))\n`
  )
}

main().catch(() => {
  process.exit(1)
})
