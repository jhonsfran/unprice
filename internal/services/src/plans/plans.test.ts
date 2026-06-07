import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { BillingConfig, ResetConfig } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { PlanService } from "./service"

function createLogger(): Logger {
  return {
    set: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createPlanService(db: Database) {
  const analytics = {} as unknown as Analytics
  const cache = {
    planVersionList: { swr: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()) },
  } as unknown as Cache
  const metrics = { emit: vi.fn(), flush: vi.fn(), setColo: vi.fn() } as unknown as Metrics

  return new PlanService({
    db,
    logger: createLogger(),
    analytics,
    waitUntil: () => {},
    cache,
    metrics,
  })
}

const monthlyBillingConfig = {
  name: "monthly",
  billingInterval: "month",
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies BillingConfig

const every15MinutesBillingConfig = {
  name: "every-15-minutes",
  billingInterval: "minute",
  billingIntervalCount: 15,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies BillingConfig

const every5MinutesBillingConfig = {
  name: "every-5-minutes",
  billingInterval: "minute",
  billingIntervalCount: 5,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies BillingConfig

const every15MinutesResetConfig = {
  name: "every-15-minutes",
  resetInterval: "minute",
  resetIntervalCount: 15,
  resetAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies ResetConfig

const every5MinutesResetConfig = {
  name: "every-5-minutes",
  resetInterval: "minute",
  resetIntervalCount: 5,
  resetAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies ResetConfig

const yearlyBillingConfig = {
  name: "yearly",
  billingInterval: "year",
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies BillingConfig

const monthlyResetConfig = {
  name: "monthly",
  resetInterval: "month",
  resetIntervalCount: 1,
  resetAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies ResetConfig

const yearlyResetConfig = {
  name: "yearly",
  resetInterval: "year",
  resetIntervalCount: 1,
  resetAnchor: "dayOfCreation",
  planType: "recurring",
} satisfies ResetConfig

describe("PlanService listPlanVersions enterprise filter", () => {
  it("returns only enterprise plans when enterprise=true, null when no plans", async () => {
    const db = {
      query: {
        versions: {
          findMany: vi.fn().mockResolvedValue([
            {
              plan: { enterprisePlan: true },
              planFeatures: [],
              currency: "USD",
              billingConfig: { billingInterval: "month" },
              projectId: "p",
              active: true,
              status: "published",
              latest: true,
            },
            {
              plan: { enterprisePlan: false },
              planFeatures: [],
              currency: "USD",
              billingConfig: { billingInterval: "month" },
              projectId: "p",
              active: true,
              status: "published",
              latest: true,
            },
          ]),
        },
      },
    } as unknown as Database

    const service = createPlanService(db)

    const { val, err } = await service.listPlanVersions({
      projectId: "p",
      query: {
        enterprise: true,
        latest: true,
        published: true,
        currency: "USD",
        billingInterval: "month",
      },
      opts: { skipCache: true },
    })

    expect(err).toBeUndefined()
    expect(val).not.toBeNull()
    expect(val!.length).toBe(1)
  })
})

describe("PlanService plan version billing defaults", () => {
  it("persists billing defaults when creating a plan version", async () => {
    let insertedValues: Record<string, unknown> | null = null

    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          insertedValues = values
          return {
            returning: vi.fn().mockResolvedValue([{ id: "pv_123", ...values }]),
          }
        }),
      })),
    }

    const db = {
      query: {
        plans: {
          findFirst: vi.fn().mockResolvedValue({ id: "plan_123", projectId: "proj_123" }),
        },
      },
      transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const { val, err } = await createPlanService(db).createPlanVersionRecord({
      projectId: "proj_123",
      planId: "plan_123",
      metadata: null,
      description: "Usage plan",
      currency: "EUR",
      billingConfig: {
        name: "monthly",
        billingInterval: "month",
        billingIntervalCount: 1,
        billingAnchor: "dayOfCreation",
        planType: "recurring",
      },
      gracePeriod: 0,
      title: "FREE",
      tags: [],
      whenToBill: "pay_in_advance",
      paymentProvider: "sandbox",
      trialUnits: 0,
      autoRenew: true,
      collectionMethod: "send_invoice",
      dueBehaviour: "downgrade",
      paymentMethodRequired: true,
    })

    expect(err).toBeUndefined()
    expect(val).toBeDefined()
    if (!val) {
      throw new Error("expected createPlanVersionRecord to return a value")
    }
    expect(val.state).toBe("ok")
    expect(insertedValues).toMatchObject({
      collectionMethod: "send_invoice",
      dueBehaviour: "downgrade",
      paymentMethodRequired: true,
    })
  })

  it("persists billing defaults when updating a draft plan version", async () => {
    let updatedValues: Record<string, unknown> | null = null

    const tx = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues = values
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "pv_123", ...values }]),
            })),
          }
        }),
      })),
    }

    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pv_123",
            projectId: "proj_123",
            currency: "EUR",
            status: "draft",
            plan: { slug: "free" },
          }),
        },
      },
      transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const { val, err } = await createPlanService(db).updatePlanVersionRecord({
      projectId: "proj_123",
      id: "pv_123",
      paymentMethodRequired: true,
    })

    expect(err).toBeUndefined()
    expect(val).toBeDefined()
    if (!val) {
      throw new Error("expected updatePlanVersionRecord to return a value")
    }
    expect(val.state).toBe("ok")
    expect(updatedValues).toMatchObject({
      paymentMethodRequired: true,
    })
  })

  it("syncs legacy follower feature billing and reset cadence when updating draft plan billing", async () => {
    const updatedValues: Record<string, unknown>[] = []

    const tx = {
      query: {
        planVersionFeatures: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "fpv_follows_plan",
              projectId: "proj_123",
              planVersionId: "pv_123",
              featureType: "usage",
              billingConfig: monthlyBillingConfig,
              resetConfig: monthlyResetConfig,
            },
            {
              id: "fpv_flat_follows_plan",
              projectId: "proj_123",
              planVersionId: "pv_123",
              featureType: "flat",
              billingConfig: monthlyBillingConfig,
              resetConfig: null,
            },
            {
              id: "fpv_custom_yearly_billing",
              projectId: "proj_123",
              planVersionId: "pv_123",
              featureType: "usage",
              billingConfig: yearlyBillingConfig,
              resetConfig: null,
              metadata: {
                billingCadenceOverride: true,
                resetCadenceOverride: false,
              },
            },
          ]),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values)
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "pv_123", ...values }]),
            })),
          }
        }),
      })),
    }

    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pv_123",
            projectId: "proj_123",
            currency: "EUR",
            status: "draft",
            billingConfig: monthlyBillingConfig,
            plan: { slug: "free" },
          }),
        },
      },
      transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const { val, err } = await createPlanService(db).updatePlanVersionRecord({
      projectId: "proj_123",
      id: "pv_123",
      billingConfig: every15MinutesBillingConfig,
    })

    expect(err).toBeUndefined()
    expect(val?.state).toBe("ok")

    const featureUpdates = updatedValues.slice(0, -1)
    const versionUpdate = updatedValues.at(-1)

    expect(featureUpdates).toHaveLength(3)
    expect(featureUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          billingConfig: every15MinutesBillingConfig,
          resetConfig: every15MinutesResetConfig,
          metadata: expect.objectContaining({
            billingCadenceOverride: false,
            resetCadenceOverride: false,
          }),
        }),
        expect.objectContaining({
          billingConfig: every15MinutesBillingConfig,
        }),
        expect.objectContaining({
          resetConfig: yearlyResetConfig,
        }),
      ])
    )
    expect(versionUpdate).toMatchObject({
      billingConfig: every15MinutesBillingConfig,
    })
  })

  it("preserves custom feature reset cadence when updating draft plan billing", async () => {
    const updatedValues: Record<string, unknown>[] = []
    const customResetConfig = {
      name: "every-5-minutes",
      resetInterval: "minute",
      resetIntervalCount: 5,
      resetAnchor: "dayOfCreation",
      planType: "recurring",
    } satisfies ResetConfig

    const tx = {
      query: {
        planVersionFeatures: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "fpv_custom_reset",
              projectId: "proj_123",
              planVersionId: "pv_123",
              featureType: "usage",
              billingConfig: monthlyBillingConfig,
              resetConfig: customResetConfig,
              metadata: {
                billingCadenceOverride: false,
                resetCadenceOverride: true,
              },
            },
          ]),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values)
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "pv_123", ...values }]),
            })),
          }
        }),
      })),
    }

    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pv_123",
            projectId: "proj_123",
            currency: "EUR",
            status: "draft",
            billingConfig: monthlyBillingConfig,
            plan: { slug: "free" },
          }),
        },
      },
      transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const { val, err } = await createPlanService(db).updatePlanVersionRecord({
      projectId: "proj_123",
      id: "pv_123",
      billingConfig: every15MinutesBillingConfig,
    })

    expect(err).toBeUndefined()
    expect(val?.state).toBe("ok")

    const featureUpdates = updatedValues.slice(0, -1)

    expect(featureUpdates).toHaveLength(1)
    expect(featureUpdates[0]).toMatchObject({
      billingConfig: every15MinutesBillingConfig,
    })
    expect(featureUpdates[0]?.resetConfig).toBeUndefined()
  })

  it("allows usage feature billing cadence shorter than the plan billing cadence", async () => {
    let insertedValues: Record<string, unknown> | undefined
    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pv_123",
            projectId: "proj_123",
            status: "draft",
            billingConfig: monthlyBillingConfig,
          }),
        },
        features: {
          findFirst: vi.fn().mockResolvedValue({
            id: "feature_usage",
            projectId: "proj_123",
            unitOfMeasure: "events",
            meterConfig: {
              eventId: "event_123",
              eventSlug: "events",
              aggregationMethod: "count",
            },
          }),
        },
      },
      transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          insert: vi.fn(() => ({
            values: vi.fn((values: Record<string, unknown>) => {
              insertedValues = values
              return {
                returning: vi.fn().mockResolvedValue([{ id: "fpv_123" }]),
              }
            }),
          })),
          query: {
            planVersionFeatures: {
              findFirst: vi.fn().mockResolvedValue({
                id: "fpv_123",
                projectId: "proj_123",
                planVersionId: "pv_123",
                featureId: "feature_usage",
                featureType: "usage",
                billingConfig: every5MinutesBillingConfig,
                resetConfig: every5MinutesResetConfig,
                metadata: {
                  billingCadenceOverride: true,
                  resetCadenceOverride: false,
                },
                planVersion: { id: "pv_123" },
                feature: { id: "feature_usage" },
              }),
            },
          },
        })
      ),
    } as unknown as Database

    const { val, err } = await createPlanService(db).createPlanVersionFeatureRecord({
      projectId: "proj_123",
      planVersionId: "pv_123",
      featureId: "feature_usage",
      featureType: "usage",
      config: {
        usageMode: "unit",
        price: {
          displayAmount: "1.00",
          dinero: {
            amount: 100,
            currency: { code: "EUR", base: 10, exponent: 2 },
            scale: 2,
          },
        },
      },
      billingConfig: every5MinutesBillingConfig,
      order: 1024,
      hasMeterConfigOverride: false,
    })

    expect(err).toBeUndefined()
    expect(val?.state).toBe("ok")
    if (val?.state !== "ok") {
      throw new Error("expected usage feature with shorter billing cadence to be valid")
    }
    expect(val.planVersionFeature.metadata).toMatchObject({
      billingCadenceOverride: true,
      resetCadenceOverride: false,
    })
    expect(insertedValues).toMatchObject({
      billingConfig: every5MinutesBillingConfig,
      resetConfig: every5MinutesResetConfig,
      metadata: expect.objectContaining({
        billingCadenceOverride: true,
        resetCadenceOverride: false,
      }),
    })
  })

  it("rejects reset cadence longer than usage feature billing cadence", async () => {
    const resetEveryFourYears = {
      name: "every-4-years",
      resetInterval: "year",
      resetIntervalCount: 4,
      resetAnchor: "dayOfCreation",
      planType: "recurring",
    } satisfies ResetConfig

    const db = {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pv_123",
            projectId: "proj_123",
            status: "draft",
            billingConfig: monthlyBillingConfig,
          }),
        },
        features: {
          findFirst: vi.fn().mockResolvedValue({
            id: "feature_usage",
            projectId: "proj_123",
            unitOfMeasure: "events",
            meterConfig: {
              eventId: "event_123",
              eventSlug: "events",
              aggregationMethod: "count",
            },
          }),
        },
      },
    } as unknown as Database

    const { val, err } = await createPlanService(db).createPlanVersionFeatureRecord({
      projectId: "proj_123",
      planVersionId: "pv_123",
      featureId: "feature_usage",
      featureType: "usage",
      config: {
        usageMode: "unit",
        price: {
          displayAmount: "1.00",
          dinero: {
            amount: 100,
            currency: { code: "EUR", base: 10, exponent: 2 },
            scale: 2,
          },
        },
      },
      billingConfig: yearlyBillingConfig,
      resetConfig: resetEveryFourYears,
      order: 1024,
      hasMeterConfigOverride: false,
    })

    expect(err).toBeUndefined()
    expect(val?.state).toBe("invalid_reset_config")
  })
})
