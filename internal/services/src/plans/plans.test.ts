import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
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

describe("PlanService plan version usage allowance", () => {
  it("persists creditLineAmount when creating a plan version", async () => {
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
      creditLineAmount: 100_000_000,
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
      creditLineAmount: 100_000_000,
    })
  })

  it("persists creditLineAmount when updating a draft plan version", async () => {
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
      creditLineAmount: 250_000_000,
    })

    expect(err).toBeUndefined()
    expect(val).toBeDefined()
    if (!val) {
      throw new Error("expected updatePlanVersionRecord to return a value")
    }
    expect(val.state).toBe("ok")
    expect(updatedValues).toMatchObject({
      paymentMethodRequired: true,
      creditLineAmount: 250_000_000,
    })
  })
})
