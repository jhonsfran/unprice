import type { Database } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { dinero } from "dinero.js"
import * as dineroCurrencies from "dinero.js/currencies"
import { beforeEach, vi } from "vitest"
import type { LedgerGateway } from "../../ledger"
import type { RatingService } from "../../rating/service"
import type { SubscriptionRepository } from "../../subscriptions/repository"
import type { SubscriptionContext } from "../../subscriptions/types"

type RepoInstance = {
  listPendingPeriodGroups: ReturnType<typeof vi.fn>
  listPendingPeriodsForStatement: ReturnType<typeof vi.fn>
  createInvoice: ReturnType<typeof vi.fn>
  updateInvoice: ReturnType<typeof vi.fn>
  markPeriodsInvoiced: ReturnType<typeof vi.fn>
}

type MockBillPeriodTx = {
  execute: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
}

type MockBillPeriodDb = Database & {
  tx: MockBillPeriodTx
  invoicedPeriod: Array<{ id: string }> | []
  nextPendingPeriod: Array<{ invoiceAt: number }> | []
}

export const repositories = { outer: makeBillingRepository(), tx: makeBillingRepository() }

function makeBillingRepository(): RepoInstance {
  return {
    listPendingPeriodGroups: vi.fn().mockResolvedValue([makePeriodGroup()]),
    listPendingPeriodsForStatement: vi.fn().mockResolvedValue([makeBillingPeriod()]),
    createInvoice: vi.fn().mockResolvedValue({ id: "inv_1", projectId: "proj_1" }),
    updateInvoice: vi.fn().mockResolvedValue(undefined),
    markPeriodsInvoiced: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  repositories.outer = makeBillingRepository()
  repositories.tx = makeBillingRepository()
})

export const usd = dineroCurrencies.USD

export function makeLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger
}

export function makePeriodGroup(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionPhaseId: "phase_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    statementKey: "stmt_2026_04",
    invoiceAt: 1_700_000_000_000,
    ...overrides,
  }
}

export function makePhase(overrides: Record<string, unknown> = {}) {
  return {
    id: "phase_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    paymentMethodId: "pm_1",
    paymentProvider: "stripe",
    planVersion: {
      whenToBill: "pay_in_advance",
      billingConfig: { billingInterval: "month" },
      paymentMethodRequired: true,
      collectionMethod: "charge_automatically",
      currency: "USD",
      gracePeriod: 1,
    },
    subscription: {
      customerId: "cust_1",
      timezone: "UTC",
    },
    ...overrides,
  }
}

export function makeBillingPeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: "bp_1",
    projectId: "proj_1",
    customerId: "cust_1",
    subscriptionId: "sub_1",
    subscriptionPhaseId: "phase_1",
    subscriptionItemId: "item_1",
    statementKey: "stmt_2026_04",
    cycleStartAt: 1_700_000_000_000,
    cycleEndAt: 1_702_000_000_000,
    type: "regular",
    subscriptionItem: {
      id: "item_1",
      units: 1,
      featurePlanVersion: {
        id: "fpv_1",
        featureType: "flat",
        feature: { slug: "api-calls", title: "API Calls" },
      },
    },
    ...overrides,
  }
}

export function makeDb(
  opts: {
    entitlementRows?: Array<{ id: string; effectiveAt?: number; expiresAt?: number | null }>
    invoicedPeriod?: Array<{ id: string }>
    nextPendingPeriod?: Array<{ invoiceAt: number }>
  } = {}
): MockBillPeriodDb {
  const entitlementRows = (opts.entitlementRows ?? [{ id: "ent_1" }]).map((row) => ({
    effectiveAt: 0,
    expiresAt: null,
    ...row,
  }))
  const invoicedPeriod = opts.invoicedPeriod ?? []
  const nextPendingPeriod = opts.nextPendingPeriod ?? []
  const txExecute = vi.fn().mockResolvedValue(undefined)
  const txSelectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(entitlementRows),
  }
  const txSelect = vi.fn().mockReturnValue(txSelectChain)
  const tx = { execute: txExecute, select: txSelect, billingRepository: repositories.tx }

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(tx)
  })

  const makeDbSelectChain = (rows: unknown[]) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  })
  const dbSelect = vi
    .fn()
    .mockReturnValueOnce(makeDbSelectChain(nextPendingPeriod))
    .mockReturnValue(makeDbSelectChain(invoicedPeriod))

  return {
    transaction,
    billingRepository: repositories.outer,
    tx,
    select: dbSelect,
    invoicedPeriod,
    nextPendingPeriod,
  } as unknown as MockBillPeriodDb
}

export function makeRatingService(result?: unknown): RatingService {
  return {
    rateBillingPeriod: vi.fn().mockResolvedValue(
      result ??
        Ok([
          {
            price: {
              totalPrice: { dinero: dinero({ amount: 1000_0000_00, currency: usd, scale: 8 }) },
              unitPrice: { dinero: dinero({ amount: 100_0000_00, currency: usd, scale: 8 }) },
            },
            usage: 10,
            prorate: 1,
          },
        ])
    ),
  } as unknown as RatingService
}

export function makeLedgerService(overrides: Partial<LedgerGateway> = {}): LedgerGateway {
  return {
    createTransfer: vi.fn().mockResolvedValue(Ok({ transferId: "xfer_1" })),
    getInvoiceLines: vi.fn().mockResolvedValue(
      Ok([
        {
          entryId: "ple_1",
          statementKey: "stmt_2026_04",
          kind: "subscription",
          description: "API Calls",
          quantity: 10,
          amount: dinero({ amount: 1000_0000_00, currency: usd, scale: 8 }),
          currency: "USD",
          createdAt: new Date(),
          metadata: {
            billing_period_id: "bp_1",
            feature_plan_version_item_id: "item_1",
            subscription_id: "sub_1",
            subscription_item_id: "item_1",
            cycle_start_at: 1_700_000_000_000,
            cycle_end_at: 1_702_000_000_000,
            proration_factor: 1,
            description: "API Calls",
            settlement_status: "due",
          },
        },
      ])
    ),
    ...overrides,
  } as unknown as LedgerGateway
}

export function makeRepo(phase?: unknown): SubscriptionRepository {
  return {
    findPhaseForBilling: vi.fn().mockResolvedValue(phase ?? makePhase()),
  } as unknown as SubscriptionRepository
}

export function makeContext(overrides: Partial<SubscriptionContext> = {}): SubscriptionContext {
  return {
    subscriptionId: "sub_1",
    projectId: "proj_1",
    subscription: { id: "sub_1", projectId: "proj_1" } as unknown as Subscription,
    customer: { id: "cust_1", projectId: "proj_1" } as unknown as Customer,
    paymentMethodId: null,
    requiredPaymentMethod: false,
    currentPhase: null,
    now: 1_700_000_000_000,
    ...overrides,
  } as SubscriptionContext
}
