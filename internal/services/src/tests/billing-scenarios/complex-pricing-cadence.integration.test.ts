import type { Analytics } from "@unprice/analytics"
import { and, count, eq, inArray } from "@unprice/db"
import {
  billingPeriods,
  customerEntitlements,
  features,
  grants,
  invoices,
  planVersionFeatures,
  subscriptionItems,
  versions,
} from "@unprice/db/schema"
import type {
  BillingConfig,
  BillingInterval,
  Customer,
  ResetConfig,
  Subscription,
} from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DrizzleBillingRepository } from "../../billing/repository.drizzle"
import { LATE_EVENT_GRACE_MS } from "../../entitlements"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import { RatingService } from "../../rating/service"
import { DrizzleSubscriptionRepository } from "../../subscriptions/repository.drizzle"
import type { SubscriptionContext } from "../../subscriptions/types"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { billPeriod } from "../../use-cases/billing/bill-period"

const db = createTestDatabaseConnection()

const fixtures = [
  "base-project.sql",
  "plan-monthly-arrear.sql",
  "customer-active.sql",
  "subscription-monthly-arrear-active.sql",
]

const projectId = "proj_test"
const customerId = "cus_test"
const subscriptionId = "sub_test_monthly_arrear"
const planVersionId = "pv_test_monthly_arrear"
const phaseId = "phase_test_monthly_arrear"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const jan2 = Date.parse("2026-01-02T00:00:00.000Z")
const jan8 = Date.parse("2026-01-08T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const dec1 = Date.parse("2026-12-01T00:00:00.000Z")
const dec31 = Date.parse("2026-12-31T00:00:00.000Z")
const dec31HourBeforeMidnight = Date.parse("2026-12-31T23:00:00.000Z")
const jan1_2027 = Date.parse("2027-01-01T00:00:00.000Z")
const billableNow = feb1 + 2 * 60 * 60 * 1000
const coBilledNow = jan1_2027 + 2 * 60 * 60 * 1000
const mar1 = Date.parse("2026-03-01T00:00:00.000Z")
const monthlyStatementKey = "stmt_test_arrear_2026_01"
const dailyStatementKey = "stmt_complex_daily_2026_01_01"
const weeklyStatementKey = "stmt_complex_weekly_2026_01_01"
const coBilledStatementKey = "stmt_complex_cobilled_2027_01_01"
const splitStatementKey = "stmt_complex_cobilled_usage_split_2027_01_01"
const advanceWithPriorUsageStatementKey = "stmt_complex_advance_fixed_with_prior_arrear_usage"

type FeatureInsert = typeof features.$inferInsert
type PlanFeatureInsert = typeof planVersionFeatures.$inferInsert
type SubscriptionItemInsert = typeof subscriptionItems.$inferInsert
type EntitlementInsert = typeof customerEntitlements.$inferInsert
type GrantInsert = typeof grants.$inferInsert
type BillingPeriodInsert = typeof billingPeriods.$inferInsert
type MeterConfig = NonNullable<FeatureInsert["meterConfig"]>
type PriceConfig = NonNullable<PlanFeatureInsert["config"]>

function createLogger(): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createAnalytics(usageByFeature: Record<string, number>): Analytics {
  return {
    getUsageBillingFeatures: vi.fn(
      async ({
        features,
      }: {
        features: Array<{ featureSlug: string }>
      }) =>
        Ok(
          features.map((feature) => ({
            featureSlug: feature.featureSlug,
            usage: usageByFeature[feature.featureSlug] ?? 0,
          }))
        )
    ),
  } as unknown as Analytics
}

function billingConfig(
  billingInterval: BillingInterval,
  name: string = billingInterval,
  billingIntervalCount = 1
): BillingConfig {
  return {
    name,
    billingInterval,
    billingIntervalCount,
    billingAnchor: "dayOfCreation",
    planType: "recurring",
  }
}

function resetConfig(
  resetInterval: BillingInterval,
  name: string = resetInterval,
  resetIntervalCount = 1
): ResetConfig {
  return {
    name,
    resetInterval,
    resetIntervalCount,
    resetAnchor: "dayOfCreation",
    planType: "recurring",
  }
}

function meterConfig(
  aggregationField: string,
  aggregationMethod: MeterConfig["aggregationMethod"]
) {
  return {
    eventId: "evt_test_completions",
    eventSlug: "completions",
    aggregationMethod,
    aggregationField,
  } satisfies MeterConfig
}

function eurPrice(amount: number, displayAmount: string, scale = 2) {
  return {
    dinero: {
      amount,
      currency: {
        code: "EUR",
        base: 10,
        exponent: 2,
      },
      scale,
    },
    displayAmount,
  } satisfies NonNullable<PriceConfig["price"]>
}

function featureRow(input: {
  id: string
  slug: string
  code: number
  unitOfMeasure: string
  title: string
  description: string
  meterConfig?: MeterConfig | null
}): FeatureInsert {
  return {
    id: input.id,
    projectId,
    createdAtM: jan1,
    updatedAtM: jan1,
    slug: input.slug,
    code: input.code,
    unitOfMeasure: input.unitOfMeasure,
    title: input.title,
    description: input.description,
    meterConfig: input.meterConfig ?? null,
  }
}

function planFeatureRow(input: {
  id: string
  featureId: string
  featureType: PlanFeatureInsert["featureType"]
  unitOfMeasure: string
  config: PriceConfig
  billingConfig: BillingConfig
  resetConfig: ResetConfig
  order: number
  defaultQuantity: number | null
  limit?: number | null
  meterConfig?: MeterConfig | null
}): PlanFeatureInsert {
  return {
    id: input.id,
    projectId,
    createdAtM: jan1,
    updatedAtM: jan1,
    planVersionId,
    type: "feature",
    featureId: input.featureId,
    featureType: input.featureType,
    unitOfMeasure: input.unitOfMeasure,
    config: input.config,
    billingConfig: input.billingConfig,
    resetConfig: input.resetConfig,
    metadata: {
      overageStrategy: "none",
      realtime: false,
      notifyUsageThreshold: 95,
      blockCustomer: false,
      hidden: false,
    },
    order: input.order,
    defaultQuantity: input.defaultQuantity,
    limit: input.limit ?? null,
    meterConfig: input.meterConfig ?? null,
  }
}

function subscriptionItemRow(input: {
  id: string
  featurePlanVersionId: string
  units: number | null
}): SubscriptionItemInsert {
  return {
    id: input.id,
    projectId,
    createdAtM: jan1,
    updatedAtM: jan1,
    units: input.units,
    featurePlanVersionId: input.featurePlanVersionId,
    subscriptionPhaseId: phaseId,
    subscriptionId,
  }
}

function entitlementRow(input: {
  id: string
  featurePlanVersionId: string
  subscriptionItemId: string
  effectiveAt: number
  expiresAt: number
}): EntitlementInsert {
  return {
    id: input.id,
    projectId,
    createdAtM: jan1,
    updatedAtM: jan1,
    customerId,
    featurePlanVersionId: input.featurePlanVersionId,
    subscriptionId,
    subscriptionPhaseId: phaseId,
    subscriptionItemId: input.subscriptionItemId,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
    overageStrategy: "none",
    metadata: {},
  }
}

function grantRow(input: {
  id: string
  customerEntitlementId: string
  allowanceUnits: number | null
  effectiveAt: number
  expiresAt: number
}): GrantInsert {
  return {
    id: input.id,
    projectId,
    createdAtM: jan1,
    updatedAtM: jan1,
    customerEntitlementId: input.customerEntitlementId,
    type: "subscription",
    priority: 10,
    allowanceUnits: input.allowanceUnits,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
    metadata: {},
  }
}

function billingPeriodRow(input: {
  id: string
  subscriptionItemId: string
  cycleStartAt: number
  cycleEndAt: number
  invoiceAt: number
  statementKey: string
  whenToBill?: BillingPeriodInsert["whenToBill"]
}): BillingPeriodInsert {
  return {
    id: input.id,
    projectId,
    createdAtM: jan1,
    updatedAtM: jan1,
    subscriptionId,
    customerId,
    subscriptionPhaseId: phaseId,
    subscriptionItemId: input.subscriptionItemId,
    status: "pending",
    type: "normal",
    cycleStartAt: input.cycleStartAt,
    cycleEndAt: input.cycleEndAt,
    amountEstimate: null,
    reason: "normal",
    invoiceId: null,
    whenToBill: input.whenToBill ?? "pay_in_arrear",
    invoiceAt: input.invoiceAt,
    statementKey: input.statementKey,
  }
}

async function loadSubscriptionContext(now = billableNow): Promise<SubscriptionContext> {
  const subscription = (await db.query.subscriptions.findFirst({
    where: (table, ops) =>
      ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, subscriptionId)),
  })) as Subscription | undefined
  const customer = (await db.query.customers.findFirst({
    where: (table, ops) =>
      ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, customerId)),
  })) as Customer | undefined

  if (!subscription || !customer) {
    throw new Error("Seeded subscription context was not restored")
  }

  return {
    now,
    subscriptionId,
    projectId,
    subscription,
    customer,
    paymentMethodId: null,
    requiredPaymentMethod: false,
    currentPhase: null,
  }
}

async function addComplexPricingConfiguration() {
  const monthlyBillingConfig = billingConfig("month")
  const dailyBillingConfig = billingConfig("day")
  const weeklyBillingConfig = billingConfig("week")
  const monthlyResetConfig = resetConfig("month")
  const dailyResetConfig = resetConfig("day")
  const weeklyResetConfig = resetConfig("week")
  const tokensMeter = meterConfig("tokens", "sum")
  const jobsMeter = meterConfig("jobs", "sum")

  await db
    .insert(features)
    .values([
      featureRow({
        id: "feat_test_bundle",
        slug: "bundles",
        code: 1101,
        unitOfMeasure: "bundle",
        title: "Usage bundles",
        description: "Packaged subscription bundle",
      }),
      featureRow({
        id: "feat_test_seats",
        slug: "seats",
        code: 1102,
        unitOfMeasure: "seat",
        title: "Seats",
        description: "Tiered seats",
      }),
      featureRow({
        id: "feat_test_tokens",
        slug: "tokens",
        code: 1103,
        unitOfMeasure: "token",
        title: "Tokens",
        description: "Daily token usage",
        meterConfig: tokensMeter,
      }),
      featureRow({
        id: "feat_test_jobs",
        slug: "jobs",
        code: 1104,
        unitOfMeasure: "job",
        title: "Jobs",
        description: "Weekly job usage",
        meterConfig: jobsMeter,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(planVersionFeatures)
    .values([
      planFeatureRow({
        id: "fv_test_arrear_bundle",
        featureId: "feat_test_bundle",
        featureType: "package",
        unitOfMeasure: "bundle",
        config: {
          price: eurPrice(700, "7.00"),
          units: 10,
        },
        billingConfig: monthlyBillingConfig,
        resetConfig: monthlyResetConfig,
        order: 3,
        defaultQuantity: 21,
      }),
      planFeatureRow({
        id: "fv_test_arrear_seats",
        featureId: "feat_test_seats",
        featureType: "tier",
        unitOfMeasure: "seat",
        config: {
          tierMode: "graduated",
          tiers: [
            {
              unitPrice: eurPrice(200, "2.00"),
              flatPrice: eurPrice(0, "0.00"),
              firstUnit: 1,
              lastUnit: 5,
            },
            {
              unitPrice: eurPrice(100, "1.00"),
              flatPrice: eurPrice(300, "3.00"),
              firstUnit: 6,
              lastUnit: null,
            },
          ],
        },
        billingConfig: monthlyBillingConfig,
        resetConfig: monthlyResetConfig,
        order: 4,
        defaultQuantity: 8,
      }),
      planFeatureRow({
        id: "fv_test_arrear_tokens",
        featureId: "feat_test_tokens",
        featureType: "usage",
        unitOfMeasure: "token",
        config: {
          usageMode: "unit",
          price: eurPrice(25, "0.25"),
          units: 1,
        },
        billingConfig: dailyBillingConfig,
        resetConfig: dailyResetConfig,
        order: 5,
        defaultQuantity: null,
        meterConfig: tokensMeter,
      }),
      planFeatureRow({
        id: "fv_test_arrear_jobs",
        featureId: "feat_test_jobs",
        featureType: "usage",
        unitOfMeasure: "job",
        config: {
          usageMode: "package",
          price: eurPrice(400, "4.00"),
          units: 25,
        },
        billingConfig: weeklyBillingConfig,
        resetConfig: weeklyResetConfig,
        order: 6,
        defaultQuantity: null,
        meterConfig: jobsMeter,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(subscriptionItems)
    .values([
      subscriptionItemRow({
        id: "item_test_arrear_bundle",
        units: 21,
        featurePlanVersionId: "fv_test_arrear_bundle",
      }),
      subscriptionItemRow({
        id: "item_test_arrear_seats",
        units: 8,
        featurePlanVersionId: "fv_test_arrear_seats",
      }),
      subscriptionItemRow({
        id: "item_test_arrear_tokens",
        units: null,
        featurePlanVersionId: "fv_test_arrear_tokens",
      }),
      subscriptionItemRow({
        id: "item_test_arrear_jobs",
        units: null,
        featurePlanVersionId: "fv_test_arrear_jobs",
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(customerEntitlements)
    .values([
      entitlementRow({
        id: "ent_test_arrear_bundle",
        featurePlanVersionId: "fv_test_arrear_bundle",
        subscriptionItemId: "item_test_arrear_bundle",
        effectiveAt: jan1,
        expiresAt: feb1,
      }),
      entitlementRow({
        id: "ent_test_arrear_seats",
        featurePlanVersionId: "fv_test_arrear_seats",
        subscriptionItemId: "item_test_arrear_seats",
        effectiveAt: jan1,
        expiresAt: feb1,
      }),
      entitlementRow({
        id: "ent_test_arrear_tokens",
        featurePlanVersionId: "fv_test_arrear_tokens",
        subscriptionItemId: "item_test_arrear_tokens",
        effectiveAt: jan1,
        expiresAt: jan2,
      }),
      entitlementRow({
        id: "ent_test_arrear_jobs",
        featurePlanVersionId: "fv_test_arrear_jobs",
        subscriptionItemId: "item_test_arrear_jobs",
        effectiveAt: jan1,
        expiresAt: jan8,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(grants)
    .values([
      grantRow({
        id: "grant_test_arrear_bundle",
        customerEntitlementId: "ent_test_arrear_bundle",
        allowanceUnits: 21,
        effectiveAt: jan1,
        expiresAt: feb1,
      }),
      grantRow({
        id: "grant_test_arrear_seats",
        customerEntitlementId: "ent_test_arrear_seats",
        allowanceUnits: 8,
        effectiveAt: jan1,
        expiresAt: feb1,
      }),
      grantRow({
        id: "grant_test_arrear_tokens",
        customerEntitlementId: "ent_test_arrear_tokens",
        allowanceUnits: null,
        effectiveAt: jan1,
        expiresAt: jan2,
      }),
      grantRow({
        id: "grant_test_arrear_jobs",
        customerEntitlementId: "ent_test_arrear_jobs",
        allowanceUnits: null,
        effectiveAt: jan1,
        expiresAt: jan8,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(billingPeriods)
    .values([
      billingPeriodRow({
        id: "bp_test_arrear_bundle_jan",
        subscriptionItemId: "item_test_arrear_bundle",
        cycleStartAt: jan1,
        cycleEndAt: feb1,
        invoiceAt: feb1,
        statementKey: monthlyStatementKey,
      }),
      billingPeriodRow({
        id: "bp_test_arrear_seats_jan",
        subscriptionItemId: "item_test_arrear_seats",
        cycleStartAt: jan1,
        cycleEndAt: feb1,
        invoiceAt: feb1,
        statementKey: monthlyStatementKey,
      }),
      billingPeriodRow({
        id: "bp_test_arrear_tokens_jan01",
        subscriptionItemId: "item_test_arrear_tokens",
        cycleStartAt: jan1,
        cycleEndAt: jan2,
        invoiceAt: jan2,
        statementKey: dailyStatementKey,
      }),
      billingPeriodRow({
        id: "bp_test_arrear_jobs_jan01",
        subscriptionItemId: "item_test_arrear_jobs",
        cycleStartAt: jan1,
        cycleEndAt: jan8,
        invoiceAt: jan8,
        statementKey: weeklyStatementKey,
      }),
    ])
    .onConflictDoNothing()
}

async function addCoBilledCadenceConfiguration() {
  const annualBillingConfig = billingConfig("year", "annual")
  const monthlyBillingConfig = billingConfig("month")
  const dailyBillingConfig = billingConfig("day")
  const hourlyBillingConfig = billingConfig("minute", "hourly", 60)
  const annualResetConfig = resetConfig("year", "annual")
  const monthlyResetConfig = resetConfig("month")
  const dailyResetConfig = resetConfig("day")
  const hourlyResetConfig = resetConfig("minute", "hourly", 60)
  const dailyMeter = meterConfig("daily_units", "sum")
  const hourlyMeter = meterConfig("hourly_jobs", "sum")

  await db
    .delete(billingPeriods)
    .where(
      and(
        eq(billingPeriods.projectId, projectId),
        eq(billingPeriods.subscriptionId, subscriptionId)
      )
    )

  await db
    .update(versions)
    .set({ billingConfig: annualBillingConfig, updatedAtM: jan1 })
    .where(and(eq(versions.projectId, projectId), eq(versions.id, planVersionId)))

  await db
    .insert(features)
    .values([
      featureRow({
        id: "feat_test_annual_platform",
        slug: "annual-platform",
        code: 1201,
        unitOfMeasure: "platform",
        title: "Annual platform",
        description: "Annual flat platform fee",
      }),
      featureRow({
        id: "feat_test_monthly_audit",
        slug: "monthly-audit",
        code: 1202,
        unitOfMeasure: "audit",
        title: "Monthly audit pack",
        description: "Monthly packaged audit fee",
      }),
      featureRow({
        id: "feat_test_daily_units",
        slug: "daily-units",
        code: 1203,
        unitOfMeasure: "unit",
        title: "Daily units",
        description: "Daily usage units",
        meterConfig: dailyMeter,
      }),
      featureRow({
        id: "feat_test_hourly_jobs",
        slug: "hourly-jobs",
        code: 1204,
        unitOfMeasure: "job",
        title: "Hourly jobs",
        description: "Hourly usage jobs represented as 60-minute billing",
        meterConfig: hourlyMeter,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(planVersionFeatures)
    .values([
      planFeatureRow({
        id: "fv_test_annual_platform",
        featureId: "feat_test_annual_platform",
        featureType: "flat",
        unitOfMeasure: "platform",
        config: {
          price: eurPrice(120000, "1200.00"),
        },
        billingConfig: annualBillingConfig,
        resetConfig: annualResetConfig,
        order: 10,
        defaultQuantity: 1,
      }),
      planFeatureRow({
        id: "fv_test_monthly_audit",
        featureId: "feat_test_monthly_audit",
        featureType: "package",
        unitOfMeasure: "audit",
        config: {
          price: eurPrice(1000, "10.00"),
          units: 1,
        },
        billingConfig: monthlyBillingConfig,
        resetConfig: monthlyResetConfig,
        order: 11,
        defaultQuantity: 1,
      }),
      planFeatureRow({
        id: "fv_test_daily_units",
        featureId: "feat_test_daily_units",
        featureType: "usage",
        unitOfMeasure: "unit",
        config: {
          usageMode: "unit",
          price: eurPrice(10, "0.10"),
        },
        billingConfig: dailyBillingConfig,
        resetConfig: dailyResetConfig,
        order: 12,
        defaultQuantity: null,
        meterConfig: dailyMeter,
      }),
      planFeatureRow({
        id: "fv_test_hourly_jobs",
        featureId: "feat_test_hourly_jobs",
        featureType: "usage",
        unitOfMeasure: "job",
        config: {
          usageMode: "package",
          price: eurPrice(50, "0.50"),
          units: 10,
        },
        billingConfig: hourlyBillingConfig,
        resetConfig: hourlyResetConfig,
        order: 13,
        defaultQuantity: null,
        meterConfig: hourlyMeter,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(subscriptionItems)
    .values([
      subscriptionItemRow({
        id: "item_test_annual_platform",
        units: 1,
        featurePlanVersionId: "fv_test_annual_platform",
      }),
      subscriptionItemRow({
        id: "item_test_monthly_audit",
        units: 1,
        featurePlanVersionId: "fv_test_monthly_audit",
      }),
      subscriptionItemRow({
        id: "item_test_daily_units",
        units: null,
        featurePlanVersionId: "fv_test_daily_units",
      }),
      subscriptionItemRow({
        id: "item_test_hourly_jobs",
        units: null,
        featurePlanVersionId: "fv_test_hourly_jobs",
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(customerEntitlements)
    .values([
      entitlementRow({
        id: "ent_test_annual_platform",
        featurePlanVersionId: "fv_test_annual_platform",
        subscriptionItemId: "item_test_annual_platform",
        effectiveAt: jan1,
        expiresAt: jan1_2027,
      }),
      entitlementRow({
        id: "ent_test_monthly_audit",
        featurePlanVersionId: "fv_test_monthly_audit",
        subscriptionItemId: "item_test_monthly_audit",
        effectiveAt: dec1,
        expiresAt: jan1_2027,
      }),
      entitlementRow({
        id: "ent_test_daily_units",
        featurePlanVersionId: "fv_test_daily_units",
        subscriptionItemId: "item_test_daily_units",
        effectiveAt: dec31,
        expiresAt: jan1_2027,
      }),
      entitlementRow({
        id: "ent_test_hourly_jobs",
        featurePlanVersionId: "fv_test_hourly_jobs",
        subscriptionItemId: "item_test_hourly_jobs",
        effectiveAt: dec31HourBeforeMidnight,
        expiresAt: jan1_2027,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(grants)
    .values([
      grantRow({
        id: "grant_test_annual_platform",
        customerEntitlementId: "ent_test_annual_platform",
        allowanceUnits: 1,
        effectiveAt: jan1,
        expiresAt: jan1_2027,
      }),
      grantRow({
        id: "grant_test_monthly_audit",
        customerEntitlementId: "ent_test_monthly_audit",
        allowanceUnits: 1,
        effectiveAt: dec1,
        expiresAt: jan1_2027,
      }),
      grantRow({
        id: "grant_test_daily_units",
        customerEntitlementId: "ent_test_daily_units",
        allowanceUnits: null,
        effectiveAt: dec31,
        expiresAt: jan1_2027,
      }),
      grantRow({
        id: "grant_test_hourly_jobs",
        customerEntitlementId: "ent_test_hourly_jobs",
        allowanceUnits: null,
        effectiveAt: dec31HourBeforeMidnight,
        expiresAt: jan1_2027,
      }),
    ])
    .onConflictDoNothing()

  await db
    .insert(billingPeriods)
    .values([
      billingPeriodRow({
        id: "bp_test_annual_platform_2026",
        subscriptionItemId: "item_test_annual_platform",
        cycleStartAt: jan1,
        cycleEndAt: jan1_2027,
        invoiceAt: jan1_2027,
        statementKey: coBilledStatementKey,
      }),
      billingPeriodRow({
        id: "bp_test_monthly_audit_dec",
        subscriptionItemId: "item_test_monthly_audit",
        cycleStartAt: dec1,
        cycleEndAt: jan1_2027,
        invoiceAt: jan1_2027,
        statementKey: coBilledStatementKey,
      }),
      billingPeriodRow({
        id: "bp_test_daily_units_dec31",
        subscriptionItemId: "item_test_daily_units",
        cycleStartAt: dec31,
        cycleEndAt: jan1_2027,
        invoiceAt: jan1_2027,
        statementKey: coBilledStatementKey,
      }),
      billingPeriodRow({
        id: "bp_test_hourly_jobs_dec31_23",
        subscriptionItemId: "item_test_hourly_jobs",
        cycleStartAt: dec31HourBeforeMidnight,
        cycleEndAt: jan1_2027,
        invoiceAt: jan1_2027,
        statementKey: coBilledStatementKey,
      }),
    ])
    .onConflictDoNothing()
}

async function addAdvanceFixedWithPriorArrearUsageConfiguration() {
  await db
    .delete(billingPeriods)
    .where(
      and(
        eq(billingPeriods.projectId, projectId),
        eq(billingPeriods.subscriptionId, subscriptionId)
      )
    )

  await db
    .update(versions)
    .set({
      whenToBill: "pay_in_advance",
      billingConfig: billingConfig("month"),
      updatedAtM: jan1,
    })
    .where(and(eq(versions.projectId, projectId), eq(versions.id, planVersionId)))

  await db
    .update(customerEntitlements)
    .set({
      expiresAt: mar1,
      updatedAtM: jan1,
    })
    .where(
      and(
        eq(customerEntitlements.projectId, projectId),
        eq(customerEntitlements.id, "ent_test_arrear_access")
      )
    )

  await db
    .update(grants)
    .set({
      expiresAt: mar1,
      updatedAtM: jan1,
    })
    .where(and(eq(grants.projectId, projectId), eq(grants.id, "grant_test_arrear_access")))

  await db
    .insert(billingPeriods)
    .values([
      billingPeriodRow({
        id: "bp_test_advance_access_feb",
        subscriptionItemId: "item_test_arrear_access",
        cycleStartAt: feb1,
        cycleEndAt: mar1,
        invoiceAt: feb1,
        statementKey: advanceWithPriorUsageStatementKey,
        whenToBill: "pay_in_advance",
      }),
      billingPeriodRow({
        id: "bp_adv_prior_events_jan",
        subscriptionItemId: "item_test_arrear_events",
        cycleStartAt: jan1,
        cycleEndAt: feb1,
        invoiceAt: feb1,
        statementKey: advanceWithPriorUsageStatementKey,
        whenToBill: "pay_in_arrear",
      }),
    ])
    .onConflictDoNothing()
}

async function runBilling({
  analytics,
  now = billableNow,
}: {
  analytics: Analytics
  now?: number
}) {
  const logger = createLogger()
  const ledger = new LedgerGateway({ db, logger })
  const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
  expect(ensureAccounts.err).toBeUndefined()

  const result = await billPeriod({
    context: await loadSubscriptionContext(now),
    logger,
    db,
    repo: new DrizzleSubscriptionRepository(db),
    ratingService: new RatingService({
      logger,
      analytics,
      grantsManager: new GrantsManager({ db, logger }),
    }),
    ledgerService: ledger,
  })

  return { result, ledger }
}

async function listInvoices() {
  return db
    .select({
      statementKey: invoices.statementKey,
      totalAmount: invoices.totalAmount,
      statementStartAt: invoices.statementStartAt,
      statementEndAt: invoices.statementEndAt,
    })
    .from(invoices)
    .where(and(eq(invoices.projectId, projectId), eq(invoices.subscriptionId, subscriptionId)))
    .orderBy(invoices.statementKey)
}

async function countInvoicedPeriods() {
  const rows = await db
    .select({ value: count() })
    .from(billingPeriods)
    .where(
      and(
        eq(billingPeriods.projectId, projectId),
        eq(billingPeriods.subscriptionId, subscriptionId),
        eq(billingPeriods.status, "invoiced")
      )
    )
  return rows[0]?.value ?? 0
}

async function listPeriods() {
  return db
    .select({
      id: billingPeriods.id,
      cycleStartAt: billingPeriods.cycleStartAt,
      cycleEndAt: billingPeriods.cycleEndAt,
      invoiceAt: billingPeriods.invoiceAt,
      status: billingPeriods.status,
      statementKey: billingPeriods.statementKey,
    })
    .from(billingPeriods)
    .where(
      and(
        eq(billingPeriods.projectId, projectId),
        eq(billingPeriods.subscriptionId, subscriptionId)
      )
    )
    .orderBy(billingPeriods.id)
}

describe("DB-backed complex pricing and mixed meter cadence billing", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("bills a plan mixing every price mode while usage meters use different billing/reset cadences", async () => {
    await addComplexPricingConfiguration()

    const analytics = createAnalytics({
      events: 120,
      jobs: 51,
      tokens: 40,
    })

    const { result, ledger } = await runBilling({ analytics })

    expect(result.phasesProcessed).toBe(3)
    expect(await listInvoices()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          statementKey: dailyStatementKey,
          totalAmount: 1_000_000_000,
        }),
        expect.objectContaining({
          statementKey: monthlyStatementKey,
          totalAmount: 13_712_000_000,
        }),
        expect.objectContaining({
          statementKey: weeklyStatementKey,
          totalAmount: 1_200_000_000,
        }),
      ])
    )

    const lineAmountsByStatement = new Map<string, number[]>()
    for (const statementKey of [monthlyStatementKey, dailyStatementKey, weeklyStatementKey]) {
      const lines = await ledger.getInvoiceLines({ projectId, statementKey })
      expect(lines.err).toBeUndefined()
      lineAmountsByStatement.set(
        statementKey,
        (lines.val ?? [])
          .map((line) => toLedgerMinor(line.amount))
          .sort((left, right) => left - right)
      )
    }

    expect(lineAmountsByStatement.get(monthlyStatementKey)).toEqual([
      112_000_000, 1_600_000_000, 2_100_000_000, 9_900_000_000,
    ])
    expect(lineAmountsByStatement.get(dailyStatementKey)).toEqual([1_000_000_000])
    expect(lineAmountsByStatement.get(weeklyStatementKey)).toEqual([1_200_000_000])
    expect(await countInvoicedPeriods()).toBe(6)

    const usageCalls = vi.mocked(analytics.getUsageBillingFeatures).mock.calls.map(([input]) => {
      const typed = input as {
        endAt: number
        features: Array<{ featureSlug: string }>
        periodKeys?: string[]
        startAt: number
      }

      return {
        endAt: typed.endAt,
        featureSlug: typed.features[0]?.featureSlug,
        periodKeys: typed.periodKeys ?? [],
        startAt: typed.startAt,
      }
    })

    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endAt: feb1,
          featureSlug: "events",
          startAt: jan1,
          periodKeys: expect.arrayContaining([expect.stringMatching(/^month:/)]),
        }),
        expect.objectContaining({
          endAt: jan2,
          featureSlug: "tokens",
          startAt: jan1,
          periodKeys: expect.arrayContaining([expect.stringMatching(/^day:/)]),
        }),
        expect.objectContaining({
          endAt: jan8,
          featureSlug: "jobs",
          startAt: jan1,
          periodKeys: expect.arrayContaining([expect.stringMatching(/^week:/)]),
        }),
      ])
    )
  })

  it("co-bills annual, monthly, daily, and hourly periods into one invoice when they share the same statement end", async () => {
    await addCoBilledCadenceConfiguration()

    const analytics = createAnalytics({
      "daily-units": 30,
      "hourly-jobs": 23,
    })

    const { result, ledger } = await runBilling({
      analytics,
      now: coBilledNow,
    })

    expect(result.phasesProcessed).toBe(1)

    const invoicesForSubscription = await listInvoices()
    expect(invoicesForSubscription).toEqual([
      {
        statementKey: coBilledStatementKey,
        totalAmount: 121_450_000_000,
        statementStartAt: jan1,
        statementEndAt: jan1_2027,
      },
    ])

    const lines = await ledger.getInvoiceLines({ projectId, statementKey: coBilledStatementKey })
    expect(lines.err).toBeUndefined()
    expect(
      (lines.val ?? [])
        .map((line) => ({
          amount: toLedgerMinor(line.amount),
          cycleEndAt: (line.metadata as Record<string, unknown>).cycle_end_at,
          cycleStartAt: (line.metadata as Record<string, unknown>).cycle_start_at,
        }))
        .sort((left, right) => left.amount - right.amount)
    ).toEqual([
      {
        amount: 150_000_000,
        cycleStartAt: dec31HourBeforeMidnight,
        cycleEndAt: jan1_2027,
      },
      {
        amount: 300_000_000,
        cycleStartAt: dec31,
        cycleEndAt: jan1_2027,
      },
      {
        amount: 1_000_000_000,
        cycleStartAt: dec1,
        cycleEndAt: jan1_2027,
      },
      {
        amount: 120_000_000_000,
        cycleStartAt: jan1,
        cycleEndAt: jan1_2027,
      },
    ])
    expect(await countInvoicedPeriods()).toBe(4)

    const usageCalls = vi.mocked(analytics.getUsageBillingFeatures).mock.calls.map(([input]) => {
      const typed = input as {
        endAt: number
        features: Array<{ featureSlug: string }>
        periodKeys?: string[]
        startAt: number
      }

      return {
        endAt: typed.endAt,
        featureSlug: typed.features[0]?.featureSlug,
        periodKeys: typed.periodKeys ?? [],
        startAt: typed.startAt,
      }
    })

    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endAt: jan1_2027,
          featureSlug: "daily-units",
          periodKeys: expect.arrayContaining([expect.stringMatching(/^day:/)]),
          startAt: dec31,
        }),
        expect.objectContaining({
          endAt: jan1_2027,
          featureSlug: "hourly-jobs",
          periodKeys: expect.arrayContaining([expect.stringMatching(/^minute:/)]),
          startAt: dec31HourBeforeMidnight,
        }),
      ])
    )
  })

  it("keeps a mixed-cadence co-billed statement idempotent across reruns", async () => {
    await addCoBilledCadenceConfiguration()

    const analytics = createAnalytics({
      "daily-units": 30,
      "hourly-jobs": 23,
    })

    const firstRun = await runBilling({
      analytics,
      now: coBilledNow,
    })
    expect(firstRun.result.phasesProcessed).toBe(1)

    const firstInvoices = await listInvoices()
    const firstLines = await firstRun.ledger.getInvoiceLines({
      projectId,
      statementKey: coBilledStatementKey,
    })
    expect(firstLines.err).toBeUndefined()
    expect(firstLines.val).toHaveLength(4)

    const secondRun = await runBilling({
      analytics,
      now: coBilledNow,
    })

    const secondLines = await secondRun.ledger.getInvoiceLines({
      projectId,
      statementKey: coBilledStatementKey,
    })
    expect(secondRun.result.phasesProcessed).toBe(0)
    expect(await listInvoices()).toEqual(firstInvoices)
    expect(secondLines.err).toBeUndefined()
    expect(secondLines.val).toHaveLength(4)
    expect(await countInvoicedPeriods()).toBe(4)
  })

  it("splits same-end periods into separate invoices when statement keys differ", async () => {
    await addCoBilledCadenceConfiguration()

    await db
      .update(billingPeriods)
      .set({ statementKey: splitStatementKey, updatedAtM: jan1 })
      .where(
        and(
          eq(billingPeriods.projectId, projectId),
          inArray(billingPeriods.id, ["bp_test_daily_units_dec31", "bp_test_hourly_jobs_dec31_23"])
        )
      )

    const analytics = createAnalytics({
      "daily-units": 30,
      "hourly-jobs": 23,
    })

    const { result, ledger } = await runBilling({
      analytics,
      now: coBilledNow,
    })

    expect(result.phasesProcessed).toBe(2)
    expect(await listInvoices()).toEqual([
      expect.objectContaining({
        statementKey: coBilledStatementKey,
        statementStartAt: jan1,
        statementEndAt: jan1_2027,
        totalAmount: 121_000_000_000,
      }),
      expect.objectContaining({
        statementKey: splitStatementKey,
        statementStartAt: dec31,
        statementEndAt: jan1_2027,
        totalAmount: 450_000_000,
      }),
    ])

    const fixedLines = await ledger.getInvoiceLines({
      projectId,
      statementKey: coBilledStatementKey,
    })
    const usageLines = await ledger.getInvoiceLines({
      projectId,
      statementKey: splitStatementKey,
    })
    expect(fixedLines.err).toBeUndefined()
    expect(usageLines.err).toBeUndefined()
    expect(fixedLines.val).toHaveLength(2)
    expect(usageLines.val).toHaveLength(2)
  })

  it("holds a mixed-cadence arrears statement until the last period clears late-event grace", async () => {
    await addCoBilledCadenceConfiguration()

    await db
      .update(billingPeriods)
      .set({
        cycleEndAt: dec31,
        updatedAtM: jan1,
      })
      .where(
        and(
          eq(billingPeriods.projectId, projectId),
          inArray(billingPeriods.id, [
            "bp_test_annual_platform_2026",
            "bp_test_monthly_audit_dec",
            "bp_test_daily_units_dec31",
          ])
        )
      )

    const repo = new DrizzleBillingRepository(db)
    const beforeGrace = await repo.listPendingPeriodGroups({
      projectId,
      subscriptionId,
      lateEventGraceMs: LATE_EVENT_GRACE_MS,
      now: jan1_2027 + LATE_EVENT_GRACE_MS - 1,
    })
    const afterGrace = await repo.listPendingPeriodGroups({
      projectId,
      subscriptionId,
      lateEventGraceMs: LATE_EVENT_GRACE_MS,
      now: jan1_2027 + LATE_EVENT_GRACE_MS,
    })

    expect(beforeGrace).toEqual([])
    expect(afterGrace).toEqual([
      expect.objectContaining({
        projectId,
        subscriptionId,
        subscriptionPhaseId: phaseId,
        statementKey: coBilledStatementKey,
        invoiceAt: jan1_2027,
      }),
    ])
  })

  it("co-bills pay-in-advance fixed charges with prior arrears usage on the same statement", async () => {
    await addAdvanceFixedWithPriorArrearUsageConfiguration()

    const analytics = createAnalytics({
      events: 120,
    })

    const { result, ledger } = await runBilling({
      analytics,
      now: feb1 + LATE_EVENT_GRACE_MS,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(await listInvoices()).toEqual([
      {
        statementKey: advanceWithPriorUsageStatementKey,
        statementStartAt: jan1,
        statementEndAt: mar1,
        totalAmount: 10_012_000_000,
      },
    ])

    const lines = await ledger.getInvoiceLines({
      projectId,
      statementKey: advanceWithPriorUsageStatementKey,
    })
    expect(lines.err).toBeUndefined()
    expect(
      (lines.val ?? [])
        .map((line) => ({
          amount: toLedgerMinor(line.amount),
          cycleEndAt: (line.metadata as Record<string, unknown>).cycle_end_at,
          cycleStartAt: (line.metadata as Record<string, unknown>).cycle_start_at,
        }))
        .sort((left, right) => left.amount - right.amount)
    ).toEqual([
      {
        amount: 112_000_000,
        cycleStartAt: jan1,
        cycleEndAt: feb1,
      },
      {
        amount: 9_900_000_000,
        cycleStartAt: feb1,
        cycleEndAt: mar1,
      },
    ])
  })

  it("caps pending annual, monthly, daily, and hourly periods when a phase is shortened", async () => {
    await addCoBilledCadenceConfiguration()

    const phaseEndAt = Date.parse("2026-12-31T23:30:00.000Z")
    await new DrizzleBillingRepository(db).capPendingPeriodsAtPhaseEnd({
      phaseId,
      phaseEndAt,
      whenToBill: "pay_in_arrear",
    })

    expect(await listPeriods()).toEqual([
      expect.objectContaining({
        id: "bp_test_annual_platform_2026",
        cycleEndAt: phaseEndAt,
        invoiceAt: phaseEndAt,
      }),
      expect.objectContaining({
        id: "bp_test_daily_units_dec31",
        cycleEndAt: phaseEndAt,
        invoiceAt: phaseEndAt,
      }),
      expect.objectContaining({
        id: "bp_test_hourly_jobs_dec31_23",
        cycleEndAt: phaseEndAt,
        invoiceAt: phaseEndAt,
      }),
      expect.objectContaining({
        id: "bp_test_monthly_audit_dec",
        cycleEndAt: phaseEndAt,
        invoiceAt: phaseEndAt,
      }),
    ])
  })
})
