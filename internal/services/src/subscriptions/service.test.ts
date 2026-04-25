import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { grants, subscriptionItems, subscriptionPhases, subscriptions } from "@unprice/db/schema"
import type { InsertSubscriptionPhase, PlanVersionExtended } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { BillingService } from "../billing/service"
import type { Cache } from "../cache/service"
import { CustomerService } from "../customers/service"
import { GrantsManager } from "../entitlements/grants"
import { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import { PaymentProviderResolver } from "../payment-provider/resolver"
import { RatingService } from "../rating/service"
import { WalletService } from "../wallet"
import { DrizzleSubscriptionRepository } from "./repository.drizzle"
import { SubscriptionService } from "./service"

vi.mock("../../env", () => ({
  env: {
    ENCRYPTION_KEY: "test_encryption_key",
    NODE_ENV: "test",
  },
}))

let idCounter = 0

vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()
  return {
    ...actual,
    AesGCM: {
      withBase64Key: vi.fn().mockResolvedValue({
        decrypt: vi.fn().mockResolvedValue("test_decrypted_key"),
      }),
    },
    newId: vi.fn().mockImplementation((prefix: string) => {
      idCounter += 1
      return `${prefix}_${idCounter}`
    }),
  }
})

type SubscriptionState = {
  id: string
  projectId: string
  customerId: string
  active: boolean
  status: "active" | "trialing" | "past_due" | "expired" | "canceled"
  timezone: string
  metadata: Record<string, unknown> | null
  currentCycleStartAt: number
  currentCycleEndAt: number
  renewAt?: number | null
  planSlug?: string | null
}

type PhaseState = {
  id: string
  projectId: string
  subscriptionId: string
  planVersionId: string
  paymentMethodId: string | null
  trialEndsAt: number | null
  trialUnits: number
  startAt: number
  endAt: number | null
  metadata: Record<string, unknown> | null
  billingAnchor: number
}

type SubscriptionItemState = {
  id: string
  subscriptionPhaseId: string
  subscriptionId: string
  projectId: string
  featurePlanVersionId: string
  units: number | null
}

type MockPlanVersion = PlanVersionExtended

function buildPlanVersion(params: {
  id: string
  planSlug: string
  featurePlanId: string
  featureSlug: string
  limit?: number | null
  paymentMethodRequired?: boolean
}) {
  return {
    id: params.id,
    status: "published",
    active: true,
    paymentMethodRequired: params.paymentMethodRequired ?? false,
    paymentProvider: "sandbox",
    whenToBill: "pay_in_advance",
    collectionMethod: "charge_automatically",
    currency: "usd",
    trialUnits: 0,
    billingConfig: {
      name: "standard",
      billingInterval: "month",
      billingIntervalCount: 1,
      planType: "recurring",
      billingAnchor: 1,
    },
    plan: { id: `plan_${params.id}`, slug: params.planSlug },
    planFeatures: [
      {
        id: params.featurePlanId,
        feature: { id: `feature_${params.featurePlanId}`, slug: params.featureSlug },
        featureType: "tier",
        unitOfMeasure: "seats",
        aggregationMethod: "sum",
        config: { tiers: [] },
        billingConfig: {
          name: "standard",
          billingInterval: "month",
          billingIntervalCount: 1,
          planType: "recurring",
        },
        limit: params.limit ?? 10,
        metadata: {
          overageStrategy: "none",
        },
      },
    ],
  } as unknown as MockPlanVersion
}

describe("SubscriptionService - grant lifecycle", () => {
  let mockDb: Database
  let mockAnalytics: Analytics
  let mockLogger: Logger
  let mockCache: Cache
  let mockMetrics: Metrics
  let subscriptionService: SubscriptionService

  const projectId = "proj_subscriptions"
  const customerId = "cust_subscriptions"
  const initialNow = new Date("2024-01-01T00:00:00Z").getTime()
  const basicPlanVersion = buildPlanVersion({
    id: "pv_basic",
    planSlug: "basic",
    featurePlanId: "pf_basic",
    featureSlug: "seats-basic",
    limit: 5,
  })
  const premiumPlanVersion = buildPlanVersion({
    id: "pv_premium",
    planSlug: "premium",
    featurePlanId: "pf_premium",
    featureSlug: "seats-premium",
    limit: 20,
  })

  let state: {
    customer: {
      id: string
      active: boolean
      projectId: string
      project: { timezone: string }
    }
    subscriptions: SubscriptionState[]
    phases: PhaseState[]
    items: SubscriptionItemState[]
    planVersions: Record<string, MockPlanVersion>
    removedPhase: PhaseState | null
    grantUpdateSets: Array<Record<string, unknown>>
  }

  const getPhaseItems = (phaseId: string) =>
    state.items
      .filter((item) => item.subscriptionPhaseId === phaseId)
      .map((item) => {
        const phase = state.phases.find((candidate) => candidate.id === phaseId)
        const planVersion = phase ? state.planVersions[phase.planVersionId] : null
        const featurePlanVersion =
          planVersion?.planFeatures.find((feature) => feature.id === item.featurePlanVersionId) ??
          null

        return {
          ...item,
          featurePlanVersion,
        }
      })

  const buildSubscriptionRecord = (subscription: SubscriptionState) => ({
    ...subscription,
    phases: state.phases
      .filter((phase) => phase.subscriptionId === subscription.id)
      .map((phase) => ({
        ...phase,
        items: getPhaseItems(phase.id),
      })),
    customer: { id: subscription.customerId },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    idCounter = 0

    state = {
      customer: {
        id: customerId,
        active: true,
        projectId,
        project: { timezone: "UTC" },
      },
      subscriptions: [],
      phases: [],
      items: [],
      planVersions: {
        [basicPlanVersion.id]: basicPlanVersion,
        [premiumPlanVersion.id]: premiumPlanVersion,
      },
      removedPhase: null,
      grantUpdateSets: [],
    }

    mockAnalytics = {} as unknown as Analytics
    mockLogger = {
      set: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    } as unknown as Logger
    mockMetrics = {} as unknown as Metrics
    mockCache = {
      accessControlList: {
        get: vi.fn().mockResolvedValue({ val: null }),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      customerRelevantEntitlements: {
        remove: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Cache

    mockDb = {
      transaction: vi.fn().mockImplementation(async (callback) => callback(mockDb)),
      query: {
        customers: {
          findFirst: vi.fn().mockImplementation(async () => ({
            ...state.customer,
            subscriptions: state.subscriptions.filter((subscription) => subscription.active),
            project: state.customer.project,
          })),
        },
        subscriptions: {
          findFirst: vi.fn().mockImplementation(async () => {
            const subscription = state.subscriptions[0]
            return subscription ? buildSubscriptionRecord(subscription) : null
          }),
        },
        subscriptionPhases: {
          findFirst: vi.fn().mockImplementation(async () => {
            const phase = state.phases[0]
            if (!phase) return null

            return {
              ...phase,
              items: getPhaseItems(phase.id),
              subscription: {
                customer: { id: customerId },
                customerId,
              },
            }
          }),
        },
        versions: {
          findFirst: vi.fn().mockImplementation(async () => basicPlanVersion),
        },
        grants: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      insert: vi.fn().mockImplementation((table) => ({
        values: vi.fn().mockImplementation((values) => {
          const rows = Array.isArray(values) ? values : [values]

          if (table === subscriptions) {
            for (const row of rows) {
              state.subscriptions.push(row as SubscriptionState)
            }
          }

          if (table === subscriptionPhases) {
            for (const row of rows) {
              state.phases.push(row as PhaseState)
            }
          }

          if (table === subscriptionItems) {
            for (const row of rows) {
              state.items.push(row as SubscriptionItemState)
            }
          }

          return {
            returning: vi.fn().mockResolvedValue(rows),
            onConflictDoNothing: vi.fn().mockImplementation(() => ({
              returning: vi.fn().mockResolvedValue(rows),
            })),
            onConflictDoUpdate: vi.fn().mockImplementation((params) => ({
              returning: vi.fn().mockResolvedValue([{ ...rows[0], ...params.set }]),
            })),
          }
        }),
      })),
      update: vi.fn().mockImplementation((table) => ({
        set: vi.fn().mockImplementation((set) => {
          if (table === subscriptions) {
            if (state.subscriptions[0]) {
              state.subscriptions[0] = {
                ...state.subscriptions[0]!,
                ...(set as Partial<SubscriptionState>),
              }
            }
          }

          if (table === subscriptionPhases) {
            if (state.phases[0]) {
              state.phases[0] = {
                ...state.phases[0]!,
                ...(set as Partial<PhaseState>),
              }
            }
          }

          if (table === grants) {
            state.grantUpdateSets.push(set as Record<string, unknown>)
          }

          return {
            where: vi.fn().mockImplementation(() => ({
              returning: vi
                .fn()
                .mockResolvedValue([table === subscriptionPhases ? state.phases[0] : set]),
            })),
          }
        }),
      })),
      delete: vi.fn().mockImplementation((table) => ({
        where: vi.fn().mockImplementation(() => {
          if (table === subscriptionPhases) {
            state.removedPhase = state.phases.shift() ?? null
            state.items = state.items.filter(
              (item) => item.subscriptionPhaseId !== state.removedPhase?.id
            )
          }

          return {
            returning: vi.fn().mockResolvedValue(state.removedPhase ? [state.removedPhase] : []),
          }
        }),
      })),
    } as unknown as Database

    vi.spyOn(CustomerService.prototype, "validatePaymentMethod").mockResolvedValue(
      Ok({ paymentMethodId: null, requiredPaymentMethod: false })
    )
    vi.spyOn(CustomerService.prototype, "updateAccessControlList").mockResolvedValue(undefined)
    const serviceDeps = {
      db: mockDb,
      logger: mockLogger,
      analytics: mockAnalytics,
      waitUntil: (promise: Promise<unknown>) => promise,
      cache: mockCache,
      metrics: mockMetrics,
    }
    const paymentProviderResolver = new PaymentProviderResolver({
      db: mockDb,
      logger: mockLogger,
    })
    const customerService = new CustomerService({ ...serviceDeps, paymentProviderResolver })
    const grantsManager = new GrantsManager({ db: mockDb, logger: mockLogger })
    const ratingService = new RatingService({ ...serviceDeps, grantsManager })
    const ledgerGateway = new LedgerGateway({
      db: mockDb,
      logger: mockLogger,
    })
    const billingService = new BillingService({
      ...serviceDeps,
      customerService,
      grantsManager,
      ratingService,
      ledgerService: ledgerGateway,
      walletService: new WalletService({
        db: mockDb,
        logger: mockLogger,
        ledgerGateway,
      }),
    })
    subscriptionService = new SubscriptionService({
      ...serviceDeps,
      repo: new DrizzleSubscriptionRepository(mockDb),
      customerService,
      billingService,
      ratingService,
      ledgerService: new LedgerGateway({
        db: mockDb,
        logger: mockLogger,
      }),
    })
  })

  it("creates grants during the initial subscription creation flow only when the active phase is created", async () => {
    const getPhaseOwnedGrantsSpy = vi
      .spyOn(GrantsManager.prototype, "getPhaseOwnedGrants")
      .mockResolvedValue(Ok([]))
    const createGrantSpy = vi
      .spyOn(GrantsManager.prototype, "createGrant")
      .mockImplementation(async ({ grant }) => Ok(grant as never))

    const createSubscriptionResult = await subscriptionService.createSubscription({
      input: { customerId, timezone: "UTC" },
      projectId,
    })

    expect(createSubscriptionResult.err).toBeUndefined()
    expect(createGrantSpy).not.toHaveBeenCalled()

    vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(basicPlanVersion)

    const createPhaseResult = await subscriptionService.createPhase({
      input: {
        subscriptionId: createSubscriptionResult.val!.id,
        planVersionId: basicPlanVersion.id,
        startAt: initialNow,
        config: [
          {
            featurePlanId: "pf_basic",
            units: 3,
            featureSlug: "seats-basic",
          },
        ],
        customerId,
        paymentMethodRequired: false,
      },
      projectId,
      now: initialNow,
    })

    expect(createPhaseResult.err).toBeUndefined()
    expect(getPhaseOwnedGrantsSpy).toHaveBeenCalledWith({
      projectId,
      customerId,
      subscriptionPhaseId: createPhaseResult.val!.id,
      featurePlanVersionIds: ["pf_basic"],
      phaseStartAt: initialNow,
      phaseEndAt: undefined,
    })
    expect(createGrantSpy).toHaveBeenCalledTimes(1)
    expect(createGrantSpy).toHaveBeenCalledWith({
      grant: expect.objectContaining({
        projectId,
        subjectType: "customer",
        subjectId: customerId,
        type: "subscription",
        featurePlanVersionId: "pf_basic",
        effectiveAt: initialNow,
        expiresAt: undefined,
        limit: 3,
        units: 3,
        autoRenew: false,
        metadata: expect.objectContaining({
          subscriptionId: createSubscriptionResult.val!.id,
          subscriptionPhaseId: createPhaseResult.val!.id,
          subscriptionItemId: expect.any(String),
        }),
      }),
    })
  })

  it("expires grants for the ended phase and creates grants for the replacement phase", async () => {
    state.subscriptions = [
      {
        id: "subscription_existing",
        projectId,
        customerId,
        active: true,
        status: "active",
        timezone: "UTC",
        metadata: null,
        currentCycleStartAt: initialNow,
        currentCycleEndAt: initialNow,
        renewAt: null,
        planSlug: "basic",
      },
    ]
    state.phases = [
      {
        id: "phase_old",
        projectId,
        subscriptionId: "subscription_existing",
        planVersionId: basicPlanVersion.id,
        paymentMethodId: null,
        trialEndsAt: null,
        trialUnits: 0,
        startAt: initialNow,
        endAt: null,
        metadata: null,
        billingAnchor: 1,
      },
    ]
    state.items = [
      {
        id: "subscription_item_old",
        subscriptionPhaseId: "phase_old",
        subscriptionId: "subscription_existing",
        projectId,
        featurePlanVersionId: "pf_basic",
        units: 3,
      },
    ]

    const transitionAt = initialNow + 7 * 24 * 60 * 60 * 1000
    const existingGrant = {
      id: "grant_old",
      projectId,
      subjectType: "customer",
      subjectId: customerId,
      type: "subscription",
      featurePlanVersionId: "pf_basic",
      effectiveAt: initialNow,
      expiresAt: null,
      autoRenew: false,
      deleted: false,
      deletedAt: null,
      priority: 10,
      limit: 3,
      units: 3,
      overageStrategy: "none",
      anchor: 1,
      metadata: {
        subscriptionId: "subscription_existing",
        subscriptionPhaseId: "phase_old",
        subscriptionItemId: "subscription_item_old",
      },
      name: "Base Plan",
      createdAtM: initialNow,
      updatedAtM: initialNow,
    }

    const getPhaseOwnedGrantsSpy = vi
      .spyOn(GrantsManager.prototype, "getPhaseOwnedGrants")
      .mockResolvedValueOnce(Ok([existingGrant as never]))
      .mockResolvedValueOnce(Ok([]))
    const createGrantSpy = vi
      .spyOn(GrantsManager.prototype, "createGrant")
      .mockImplementation(async ({ grant }) => Ok(grant as never))

    const updatePhaseInput = {
      ...state.phases[0]!,
      endAt: transitionAt,
      items: state.items.map((item) => ({
        id: item.id,
        units: item.units,
      })),
    } as unknown as InsertSubscriptionPhase & { id: string }

    const updatePhaseResult = await subscriptionService.updatePhase({
      input: updatePhaseInput as never,
      subscriptionId: "subscription_existing",
      projectId,
      now: transitionAt,
    })

    expect(updatePhaseResult.err).toBeUndefined()
    expect(getPhaseOwnedGrantsSpy).toHaveBeenNthCalledWith(1, {
      projectId,
      customerId,
      subscriptionPhaseId: "phase_old",
      featurePlanVersionIds: ["pf_basic"],
      phaseStartAt: initialNow,
      phaseEndAt: transitionAt,
    })
    expect(state.grantUpdateSets).toContainEqual(
      expect.objectContaining({
        expiresAt: transitionAt,
      })
    )

    vi.spyOn(mockDb.query.versions, "findFirst").mockResolvedValue(premiumPlanVersion)

    const newPhaseStart = transitionAt + 1
    const createPhaseResult = await subscriptionService.createPhase({
      input: {
        subscriptionId: "subscription_existing",
        planVersionId: premiumPlanVersion.id,
        startAt: newPhaseStart,
        config: [
          {
            featurePlanId: "pf_premium",
            units: 8,
            featureSlug: "seats-premium",
          },
        ],
        customerId,
        paymentMethodRequired: false,
      },
      projectId,
      now: newPhaseStart,
    })

    expect(createPhaseResult.err).toBeUndefined()
    expect(getPhaseOwnedGrantsSpy).toHaveBeenNthCalledWith(2, {
      projectId,
      customerId,
      subscriptionPhaseId: createPhaseResult.val!.id,
      featurePlanVersionIds: ["pf_premium"],
      phaseStartAt: newPhaseStart,
      phaseEndAt: undefined,
    })
    expect(createGrantSpy).toHaveBeenCalledWith({
      grant: expect.objectContaining({
        subjectId: customerId,
        type: "subscription",
        featurePlanVersionId: "pf_premium",
        effectiveAt: newPhaseStart,
        limit: 8,
        units: 8,
        metadata: expect.objectContaining({
          subscriptionPhaseId: createPhaseResult.val!.id,
        }),
      }),
    })
  })

  it("ends the active phase at now without creating duplicate grants", async () => {
    state.subscriptions = [
      {
        id: "subscription_existing",
        projectId,
        customerId,
        active: true,
        status: "active",
        timezone: "UTC",
        metadata: null,
        currentCycleStartAt: initialNow,
        currentCycleEndAt: initialNow,
        renewAt: null,
        planSlug: "basic",
      },
    ]
    state.phases = [
      {
        id: "phase_old",
        projectId,
        subscriptionId: "subscription_existing",
        planVersionId: basicPlanVersion.id,
        paymentMethodId: null,
        trialEndsAt: null,
        trialUnits: 0,
        startAt: initialNow,
        endAt: null,
        metadata: null,
        billingAnchor: 1,
      },
    ]
    state.items = [
      {
        id: "subscription_item_old",
        subscriptionPhaseId: "phase_old",
        subscriptionId: "subscription_existing",
        projectId,
        featurePlanVersionId: "pf_basic",
        units: 3,
      },
    ]

    const transitionAt = initialNow + 7 * 24 * 60 * 60 * 1000
    const existingGrant = {
      id: "grant_old",
      projectId,
      subjectType: "customer",
      subjectId: customerId,
      type: "subscription",
      featurePlanVersionId: "pf_basic",
      effectiveAt: initialNow,
      expiresAt: null,
      autoRenew: false,
      deleted: false,
      deletedAt: null,
      priority: 10,
      limit: 3,
      units: 3,
      overageStrategy: "none",
      anchor: 1,
      metadata: {
        subscriptionId: "subscription_existing",
        subscriptionPhaseId: "phase_old",
        subscriptionItemId: "subscription_item_old",
      },
      name: "Base Plan",
      createdAtM: initialNow,
      updatedAtM: initialNow,
    }

    const getPhaseOwnedGrantsSpy = vi
      .spyOn(GrantsManager.prototype, "getPhaseOwnedGrants")
      .mockResolvedValue(Ok([existingGrant as never]))
    const createGrantSpy = vi
      .spyOn(GrantsManager.prototype, "createGrant")
      .mockImplementation(async ({ grant }) => Ok(grant as never))

    const updatePhaseInput = {
      ...state.phases[0]!,
      endAt: transitionAt,
      items: state.items.map((item) => ({
        id: item.id,
        units: item.units,
      })),
    } as unknown as InsertSubscriptionPhase & { id: string }

    const updatePhaseResult = await subscriptionService.updatePhase({
      input: updatePhaseInput as never,
      subscriptionId: "subscription_existing",
      projectId,
      now: transitionAt,
    })

    expect(updatePhaseResult.err).toBeUndefined()
    expect(getPhaseOwnedGrantsSpy).toHaveBeenCalledWith({
      projectId,
      customerId,
      subscriptionPhaseId: "phase_old",
      featurePlanVersionIds: ["pf_basic"],
      phaseStartAt: initialNow,
      phaseEndAt: transitionAt,
    })
    expect(createGrantSpy).not.toHaveBeenCalled()
    expect(state.grantUpdateSets).toContainEqual(
      expect.objectContaining({
        expiresAt: transitionAt,
      })
    )
  })

  it("removes future phase grants using phase-derived feature plan versions", async () => {
    const futureStart = initialNow + 14 * 24 * 60 * 60 * 1000
    const futureEnd = futureStart + 30 * 24 * 60 * 60 * 1000

    state.subscriptions = [
      {
        id: "subscription_existing",
        projectId,
        customerId,
        active: true,
        status: "active",
        timezone: "UTC",
        metadata: null,
        currentCycleStartAt: initialNow,
        currentCycleEndAt: initialNow,
        renewAt: null,
        planSlug: "premium",
      },
    ]
    state.phases = [
      {
        id: "phase_future",
        projectId,
        subscriptionId: "subscription_existing",
        planVersionId: premiumPlanVersion.id,
        paymentMethodId: null,
        trialEndsAt: null,
        trialUnits: 0,
        startAt: futureStart,
        endAt: futureEnd,
        metadata: null,
        billingAnchor: 1,
      },
    ]
    state.items = [
      {
        id: "subscription_item_future",
        subscriptionPhaseId: "phase_future",
        subscriptionId: "subscription_existing",
        projectId,
        featurePlanVersionId: "pf_premium",
        units: 8,
      },
    ]

    const deletePhaseOwnedGrantsSpy = vi
      .spyOn(GrantsManager.prototype, "deletePhaseOwnedGrants")
      .mockResolvedValue(Ok(undefined))

    const removePhaseResult = await subscriptionService.removePhase({
      phaseId: "phase_future",
      projectId,
      now: initialNow,
    })

    expect(removePhaseResult.err).toBeUndefined()
    expect(deletePhaseOwnedGrantsSpy).toHaveBeenCalledTimes(1)

    const deletePhaseOwnedGrantsArgs = deletePhaseOwnedGrantsSpy.mock.calls[0]?.[0]
    expect(deletePhaseOwnedGrantsArgs).toEqual({
      projectId,
      customerId,
      subscriptionPhaseId: "phase_future",
      featurePlanVersionIds: ["pf_premium"],
      phaseStartAt: futureStart,
      phaseEndAt: futureEnd,
    })
    expect("subscriptionItemIds" in (deletePhaseOwnedGrantsArgs ?? {})).toBe(false)
  })
})
