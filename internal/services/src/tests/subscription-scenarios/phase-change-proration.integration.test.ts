import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../../cache"
import { type ServiceContext, createServiceContext } from "../../context"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import type { Metrics } from "../../metrics"
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
const originalPhaseId = "phase_test_monthly_arrear"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const jan10 = Date.parse("2026-01-10T00:00:00.000Z")
const jan16 = Date.parse("2026-01-16T00:00:00.000Z")
const jan16NextMs = jan16 + 1
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const feb1PreviousMs = feb1 - 1
const mar1 = Date.parse("2026-03-01T00:00:00.000Z")
const billableNow = feb1 + 2 * 60 * 60 * 1000

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

function createAnalytics(usageByFeature: Record<string, number> = {}): Analytics {
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
    ingestEvents: vi.fn(),
  } as unknown as Analytics
}

function createCache(): Cache {
  return {
    accessControlList: {
      get: vi.fn(async () => Ok(null)),
      remove: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    },
  } as unknown as Cache
}

function createServices(): { logger: Logger; services: ServiceContext } {
  const logger = createLogger()
  return {
    logger,
    services: createServiceContext({
      db,
      logger,
      analytics: createAnalytics(),
      waitUntil: (promise) => {
        void promise
      },
      cache: createCache(),
      metrics: {} as Metrics,
    }),
  }
}

async function addEnterprisePlanVersion() {
  const billingConfig = {
    name: "monthly",
    billingInterval: "month",
    billingIntervalCount: 1,
    billingAnchor: "dayOfCreation",
    planType: "recurring",
  }
  const resetConfig = {
    name: "monthly",
    resetInterval: "month",
    resetIntervalCount: 1,
    resetAnchor: "dayOfCreation",
    planType: "recurring",
  }

  await db.execute(sql`
    INSERT INTO unprice_plan_versions (
      id,
      project_id,
      created_at_m,
      updated_at_m,
      plan_id,
      description,
      latest,
      title,
      tags,
      active,
      plan_version_status,
      published_at_m,
      published_by,
      archived,
      archived_at_m,
      archived_by,
      payment_providers,
      due_behaviour,
      currency,
      billing_config,
      when_to_bill,
      grace_period,
      collection_method,
      trial_units,
      auto_renew,
      metadata,
      payment_method_required,
      version
    ) VALUES (
      'pv_test_enterprise_arrear',
      ${projectId},
      ${jan1},
      ${jan1},
      'plan_test_pro',
      'Enterprise phase test version',
      false,
      'Enterprise Arrears',
      '[]'::json,
      true,
      'published',
      ${jan1},
      'user_test_owner',
      false,
      NULL,
      NULL,
      'sandbox',
      'cancel',
      'EUR',
      ${JSON.stringify(billingConfig)}::json,
      'pay_in_arrear',
      3,
      'charge_automatically',
      0,
      true,
      '{}'::json,
      false,
      2
    ) ON CONFLICT DO NOTHING
  `)

  await db.execute(sql`
    INSERT INTO unprice_plan_versions_features (
      id,
      project_id,
      created_at_m,
      updated_at_m,
      plan_version_id,
      feature_config_type,
      feature_id,
      feature_type,
      unit_of_measure,
      features_config,
      billing_config,
      reset_config,
      metadata,
      "order",
      default_quantity,
      "limit",
      meter_config
    ) VALUES (
      'fv_test_enterprise_access',
      ${projectId},
      ${jan1},
      ${jan1},
      'pv_test_enterprise_arrear',
      'feature',
      'feat_test_access_pro',
      'flat',
      'access',
      '{"price":{"dinero":{"amount":31000,"currency":{"code":"EUR","base":10,"exponent":2},"scale":2},"displayAmount":"310.00"}}'::json,
      ${JSON.stringify(billingConfig)}::json,
      ${JSON.stringify(resetConfig)}::json,
      '{}'::json,
      1,
      1,
      NULL,
      NULL
    ) ON CONFLICT DO NOTHING
  `)
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

async function closeOriginalPhase(services: ServiceContext, endAt: number, now: number) {
  const result = await services.subscriptions.updatePhase({
    input: {
      id: originalPhaseId,
      projectId,
      subscriptionId,
      startAt: jan1,
      endAt,
      items: [],
    } as never,
    subscriptionId,
    projectId,
    now,
  })

  expect(result.err).toBeUndefined()
}

async function createEnterprisePhase(services: ServiceContext, startAt: number, now: number) {
  const result = await services.subscriptions.createPhase({
    input: {
      subscriptionId,
      planVersionId: "pv_test_enterprise_arrear",
      startAt,
    } as never,
    projectId,
    now,
  })

  expect(result.err).toBeUndefined()
  if (result.err) throw result.err
  return result.val.id
}

async function touchPhaseForEntitlementSync(
  services: ServiceContext,
  phaseId: string,
  startAt: number,
  now: number
) {
  const result = await services.subscriptions.updatePhase({
    input: {
      id: phaseId,
      projectId,
      subscriptionId,
      startAt,
      endAt: null,
      items: [],
    } as never,
    subscriptionId,
    projectId,
    now,
  })

  expect(result.err).toBeUndefined()
}

async function listPhaseEntitlements(phaseId: string) {
  const result = await db.execute<{
    entitlement_id: string
    expires_at: string | null
    feature_plan_version_id: string
    grant_effective_at: string
    grant_expires_at: string | null
    grant_type: string
    effective_at: string
  }>(sql`
    SELECT
      ce.id AS entitlement_id,
      ce.feature_plan_version_id,
      ce.effective_at,
      ce.expires_at,
      g.type AS grant_type,
      g.effective_at AS grant_effective_at,
      g.expires_at AS grant_expires_at
    FROM unprice_customer_entitlements ce
    JOIN unprice_grants g
      ON g.customer_entitlement_id = ce.id
      AND g.project_id = ce.project_id
    WHERE ce.project_id = ${projectId}
      AND ce.subscription_phase_id = ${phaseId}
    ORDER BY ce.feature_plan_version_id, g.type
  `)

  return result.rows.map((row) => ({
    ...row,
    effective_at: Number(row.effective_at),
    expires_at: row.expires_at === null ? null : Number(row.expires_at),
    grant_effective_at: Number(row.grant_effective_at),
    grant_expires_at: row.grant_expires_at === null ? null : Number(row.grant_expires_at),
  }))
}

describe("DB-backed subscription phase changes", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
    await addEnterprisePlanVersion()
  })

  it("immediate phase change closes old grants, opens new grants, prorates the old invoice, and creates the next phase invoice window", async () => {
    const { logger, services } = createServices()

    await closeOriginalPhase(services, jan16, jan16)
    const enterprisePhaseId = await createEnterprisePhase(services, jan16NextMs, jan16NextMs)

    const materialized = await services.billing.generateBillingPeriods({
      projectId,
      subscriptionId,
      now: billableNow,
    })
    expect(materialized.err).toBeUndefined()

    const oldEntitlements = await listPhaseEntitlements(originalPhaseId)
    expect(oldEntitlements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entitlement_id: "ent_test_arrear_access",
          expires_at: jan16,
          grant_expires_at: jan16,
        }),
        expect.objectContaining({
          entitlement_id: "ent_test_arrear_events",
          expires_at: jan16,
          grant_expires_at: jan16,
        }),
      ])
    )

    const newEntitlements = await listPhaseEntitlements(enterprisePhaseId)
    expect(newEntitlements).toEqual([
      expect.objectContaining({
        effective_at: jan16NextMs,
        expires_at: null,
        feature_plan_version_id: "fv_test_enterprise_access",
        grant_effective_at: jan16NextMs,
        grant_expires_at: null,
        grant_type: "subscription",
      }),
    ])

    const ledger = new LedgerGateway({ db, logger })
    const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
    expect(ensureAccounts.err).toBeUndefined()
    const billed = await billPeriod({
      context: await loadSubscriptionContext(),
      logger,
      db,
      repo: new DrizzleSubscriptionRepository(db),
      ratingService: new RatingService({
        logger,
        analytics: createAnalytics({ events: 120 }),
        grantsManager: new GrantsManager({ db, logger }),
      }),
      ledgerService: ledger,
    })
    expect(billed.phasesProcessed).toBe(1)

    const invoice = await db.execute<{ statement_key: string; gross_amount: string }>(sql`
      SELECT statement_key, gross_amount
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
      ORDER BY created_at_m
    `)
    expect(invoice.rows).toHaveLength(1)
    expect(Number(invoice.rows[0]!.gross_amount)).toBeGreaterThan(1_000_000_000)
    expect(Number(invoice.rows[0]!.gross_amount)).toBeLessThan(9_900_000_000)

    const lines = await ledger.getInvoiceLines({
      projectId,
      statementKey: invoice.rows[0]!.statement_key,
    })
    expect(lines.err).toBeUndefined()
    const accessLine = (lines.val ?? []).find((line) => line.description === "Access Pro")
    expect(accessLine).toBeDefined()
    expect(toLedgerMinor(accessLine!.amount)).toBeLessThan(9_900_000_000)
    expect((accessLine!.metadata as Record<string, unknown> | null)?.proration_factor).toSatisfy(
      (factor: unknown) => typeof factor === "number" && factor > 0 && factor < 1
    )

    const nextPhasePeriods = await db.execute<{
      cycle_end_at_m: string
      cycle_start_at_m: string
      status: string
    }>(sql`
      SELECT status, cycle_start_at_m, cycle_end_at_m
      FROM unprice_billing_periods
      WHERE project_id = ${projectId}
        AND subscription_phase_id = ${enterprisePhaseId}
      ORDER BY cycle_start_at_m
    `)
    expect(
      nextPhasePeriods.rows.map((period) => ({
        ...period,
        cycle_end_at_m: Number(period.cycle_end_at_m),
        cycle_start_at_m: Number(period.cycle_start_at_m),
      }))
    ).toEqual([
      expect.objectContaining({
        cycle_start_at_m: jan16,
        status: "pending",
      }),
    ])
  })

  it("future phase change keeps future grants out until activation and preserves next invoice invariants", async () => {
    const { services } = createServices()

    await closeOriginalPhase(services, feb1PreviousMs, jan10)
    const enterprisePhaseId = await createEnterprisePhase(services, feb1, jan10)

    expect(await listPhaseEntitlements(enterprisePhaseId)).toEqual([])

    await touchPhaseForEntitlementSync(services, enterprisePhaseId, feb1, feb1)
    expect(await listPhaseEntitlements(enterprisePhaseId)).toEqual([
      expect.objectContaining({
        effective_at: feb1,
        expires_at: null,
        feature_plan_version_id: "fv_test_enterprise_access",
        grant_effective_at: feb1,
        grant_expires_at: null,
        grant_type: "subscription",
      }),
    ])

    const materialized = await services.billing.generateBillingPeriods({
      projectId,
      subscriptionId,
      now: feb1,
    })
    expect(materialized.err).toBeUndefined()

    const periods = await db.execute<{
      cycle_end_at_m: string
      cycle_start_at_m: string
      status: string
      subscription_phase_id: string
    }>(sql`
      SELECT subscription_phase_id, status, cycle_start_at_m, cycle_end_at_m
      FROM unprice_billing_periods
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
      ORDER BY cycle_start_at_m, subscription_phase_id
    `)
    const normalized = periods.rows.map((period) => ({
      ...period,
      cycle_end_at_m: Number(period.cycle_end_at_m),
      cycle_start_at_m: Number(period.cycle_start_at_m),
    }))

    expect(normalized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cycle_end_at_m: feb1PreviousMs,
          cycle_start_at_m: jan1,
          subscription_phase_id: originalPhaseId,
        }),
        expect.objectContaining({
          cycle_end_at_m: mar1,
          cycle_start_at_m: feb1,
          status: "pending",
          subscription_phase_id: enterprisePhaseId,
        }),
      ])
    )
  })
})
