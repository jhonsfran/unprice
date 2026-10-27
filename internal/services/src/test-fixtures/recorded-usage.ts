import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { vi } from "vitest"
import { type BillingUsageSnapshot, ownsBillingUsagePeriod } from "../billing/usage-snapshot"
import { createServiceContext } from "../context"
import type { ServiceDeps } from "../deps"
import { computeGrantPeriodBucket } from "../entitlements/grant-consumption"
import { GrantsManager } from "../entitlements/grants"
import { LedgerGateway } from "../ledger"
import { RatingService as BaseRatingService } from "../rating/service"
import { billPeriod } from "../use-cases/billing/bill-period"
import type { BillingReservationFlushGateway } from "../use-cases/billing/reservation-flush-gateway"

const fixtures = new WeakMap<Analytics, { db: Database; gateway: BillingReservationFlushGateway }>()
const ratingGateways = new WeakMap<BaseRatingService, BillingReservationFlushGateway>()

export function withRecordedUsageAnalytics(db: Database, analytics: Analytics): Analytics {
  if (fixtures.has(analytics)) return analytics
  const logger = {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger
  const grants = new GrantsManager({ db, logger })
  const rating = new BaseRatingService({ logger, analytics, grantsManager: grants })
  const ledger = new LedgerGateway({ db, logger })
  const getAllocations: Analytics["getBillingUsageAllocations"] = async (query) => {
    const data = []
    for (const featureSlug of query.feature_slugs) {
      const usage = await analytics.getUsageBillingFeatures({
        projectId: query.project_id,
        customerId: query.customer_id,
        customerEntitlementIds: query.customer_entitlement_ids,
        features: [{ featureSlug, aggregationMethod: "sum", featureType: "usage" }],
        startAt: query.start,
        endAt: query.end,
      })
      if (usage.err) throw usage.err
      const owners = await grants.listGrantsForCustomerFeature({
        projectId: query.project_id,
        customerId: query.customer_id,
        customerEntitlementIds: query.customer_entitlement_ids,
        featureSlug,
        startAt: query.start,
        endAt: query.end,
      })
      if (owners.err) throw owners.err
      const charges = await rating.rateBillingPeriod({
        projectId: query.project_id,
        customerId: query.customer_id,
        customerEntitlementIds: query.customer_entitlement_ids,
        featureSlug,
        startAt: query.start,
        endAt: query.end,
        usageData: usage.val,
        grants: owners.val,
      })
      if (charges.err) throw charges.err
      for (const charge of charges.val) {
        const grant = owners.val.find((candidate) => candidate.id === charge.grantId)
        if (!grant) throw new Error("Recorded usage fixture has no grant")
        const bucket = computeGrantPeriodBucket(
          {
            grantId: grant.id,
            cadenceEffectiveAt: grant.customerEntitlement.effectiveAt,
            cadenceExpiresAt: grant.customerEntitlement.expiresAt,
            effectiveAt: grant.effectiveAt,
            expiresAt: grant.expiresAt,
            resetConfig: grant.customerEntitlement.featurePlanVersion.resetConfig,
          },
          Math.max(query.start, charge.cycleStartAt, grant.effectiveAt)
        )
        if (!bucket) throw new Error("Recorded usage fixture has no reset bucket")
        data.push({
          customer_entitlement_id: grant.customerEntitlement.id,
          grant_id: grant.id,
          feature_slug: featureSlug,
          period_key: bucket.periodKey,
          period_start_at: bucket.start,
          usage: charge.usage,
          amount: toLedgerMinor(charge.price.totalPrice.dinero),
          currency: charge.price.totalPrice.dinero.toJSON().currency.code,
          amount_scale: 8,
        })
      }
    }
    return { data, meta: [] }
  }
  Object.assign(analytics, { getBillingUsageAllocations: vi.fn(getAllocations) })

  const snapshots = new Map<string, BillingUsageSnapshot>()
  const gateway: BillingReservationFlushGateway = {
    registerPeriods: async (input) => {
      for (const registration of input.registrations) {
        const key = `${registration.customerEntitlementId}:${registration.billingPeriodId}`
        if (!snapshots.has(key))
          snapshots.set(key, {
            ...registration,
            amount: 0,
            quantity: 0,
            lastEventAt: null,
            state: "open",
            sealedAt: null,
            completedAt: null,
          })
      }
      return Ok(undefined)
    },
    completeForInvoicing: async () => Ok(undefined),
    flushForInvoicing: async (input) => {
      const periods = await db.query.billingPeriods.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.projectId, input.projectId),
            eq(table.customerId, input.customerId),
            eq(table.subscriptionId, input.subscriptionId),
            eq(table.subscriptionPhaseId, input.subscriptionPhaseId),
            eq(table.statementKey, input.statementKey)
          ),
        with: {
          subscriptionItem: { with: { featurePlanVersion: { with: { feature: true } } } },
          subscriptionPhase: { with: { planVersion: true } },
        },
      })
      const sealed: BillingUsageSnapshot[] = []
      for (const period of periods) {
        if (period.subscriptionItem.featurePlanVersion.featureType !== "usage") continue
        const entitlementRows = await db.query.customerEntitlements.findMany({
          where: (table, { and, eq }) =>
            and(
              eq(table.projectId, input.projectId),
              eq(table.customerId, input.customerId),
              eq(table.subscriptionItemId, period.subscriptionItemId)
            ),
        })
        const entitlements = entitlementRows.filter((row) => ownsBillingUsagePeriod(row, period))
        const rows = await getAllocations({
          project_id: input.projectId,
          customer_id: input.customerId,
          customer_entitlement_ids: entitlements.map((entitlement) => entitlement.id),
          feature_slugs: [period.subscriptionItem.featurePlanVersion.feature.slug],
          start: period.cycleStartAt,
          end: period.cycleEndAt,
        })
        const captured = await ledger.getInvoiceLines({
          projectId: input.projectId,
          statementKey: input.statementKey,
        })
        if (captured.err) throw captured.err
        const captures = captured.val.filter(
          (line) =>
            line.metadata?.flow === "capture" &&
            line.metadata.billing_period_id === period.id &&
            line.metadata.feature_plan_version_item_id === period.subscriptionItemId
        )
        if (period.subscriptionPhase.creditLinePolicy === "capped" && entitlements.length > 1)
          throw new Error("Capped usage fixture needs one explicit entitlement owner")
        for (const entitlement of entitlements) {
          const key = `${entitlement.id}:${period.id}`
          const existing = snapshots.get(key)
          if (existing && existing.state !== "open") {
            sealed.push(existing)
            continue
          }
          const facts = rows.data.filter((row) => row.customer_entitlement_id === entitlement.id)
          const snapshot: BillingUsageSnapshot = {
            projectId: input.projectId,
            customerId: input.customerId,
            customerEntitlementId: entitlement.id,
            subscriptionId: period.subscriptionId,
            subscriptionPhaseId: period.subscriptionPhaseId,
            subscriptionItemId: period.subscriptionItemId,
            billingPeriodId: period.id,
            statementKey: period.statementKey,
            featureSlug: period.subscriptionItem.featurePlanVersion.feature.slug,
            cycleStartAt: period.cycleStartAt,
            cycleEndAt: period.cycleEndAt,
            currency: period.subscriptionPhase.planVersion.currency,
            amountScale: 8,
            origin: "period_generation_v1",
            genesis: { version: 1, customerEntitlementId: entitlement.id },
            registeredAt: period.cycleStartAt,
            amount:
              period.subscriptionPhase.creditLinePolicy === "capped"
                ? captures.reduce((sum, line) => sum + toLedgerMinor(line.amount), 0)
                : facts.reduce((sum, fact) => sum + fact.amount, 0),
            quantity: facts.reduce((sum, fact) => sum + fact.usage, 0),
            lastEventAt: facts.length > 0 ? period.cycleEndAt - 1 : null,
            state: "sealed",
            sealedAt: period.cycleEndAt,
            completedAt: null,
          }
          snapshots.set(key, snapshot)
          sealed.push(snapshot)
        }
      }
      return Ok({ snapshots: sealed })
    },
  }
  fixtures.set(analytics, { db, gateway })
  return analytics
}

export function recordedUsageGateway(analytics: Analytics): BillingReservationFlushGateway {
  const fixture = fixtures.get(analytics)
  if (!fixture) throw new Error("Analytics needs explicit recorded usage fixture data")
  return fixture.gateway
}

export class RecordedFixtureRatingService extends BaseRatingService {
  constructor(options: ConstructorParameters<typeof BaseRatingService>[0]) {
    super(options)
    ratingGateways.set(this, recordedUsageGateway(options.analytics))
  }
}

export function billPeriodWithRecordedUsage(input: Parameters<typeof billPeriod>[0]) {
  const gateway = input.reservationFlushGateway ?? ratingGateways.get(input.ratingService)
  if (!gateway) throw new Error("Billing test needs an authoritative usage fixture gateway")
  return billPeriod({ ...input, reservationFlushGateway: gateway })
}

export function createRecordedServiceContext(deps: ServiceDeps) {
  return createServiceContext({
    ...deps,
    reservationFlushGateway: recordedUsageGateway(deps.analytics),
  })
}
