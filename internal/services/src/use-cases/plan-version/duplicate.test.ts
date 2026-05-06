import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { duplicatePlanVersion } from "./duplicate"

type InsertedValues = Record<string, unknown>

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createPlanVersion(overrides?: InsertedValues): InsertedValues {
  return {
    id: "pv_source",
    projectId: "proj_123",
    planId: "plan_free",
    description: "Free plan",
    title: "Free",
    tags: [],
    latest: true,
    active: true,
    status: "published",
    publishedAt: 1,
    publishedBy: "usr_123",
    archived: false,
    archivedAt: null,
    archivedBy: null,
    paymentProvider: "sandbox",
    dueBehaviour: "cancel",
    currency: "USD",
    billingConfig: {
      name: "monthly",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "recurring",
    },
    whenToBill: "pay_in_advance",
    gracePeriod: 0,
    collectionMethod: "charge_automatically",
    trialUnits: 0,
    autoRenew: true,
    metadata: null,
    paymentMethodRequired: true,
    version: 1,
    createdAtM: 1,
    updatedAtM: 1,
    plan: {
      id: "plan_free",
      projectId: "proj_123",
      defaultPlan: true,
    },
    planFeatures: [
      {
        id: "pf_source",
        projectId: "proj_123",
        planVersionId: "pv_source",
        featureId: "feature_123",
        metadata: { hidden: false },
        createdAtM: 1,
        updatedAtM: 1,
      },
    ],
    ...overrides,
  }
}

function createDbMocks(planVersionData: InsertedValues | null) {
  let insertedVersion: InsertedValues | null = null
  const insertedFeatures: InsertedValues[] = []

  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: InsertedValues) => {
        if ("planId" in values) {
          insertedVersion = values
          return {
            returning: vi.fn().mockResolvedValue([values]),
          }
        }

        insertedFeatures.push(values)
        return Promise.resolve()
      }),
    })),
  }

  const db = {
    query: {
      versions: {
        findFirst: vi.fn().mockResolvedValue(planVersionData),
      },
    },
    transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  } as unknown as Database

  return {
    db,
    inserted: {
      get version() {
        return insertedVersion
      },
      features: insertedFeatures,
    },
  }
}

describe("duplicatePlanVersion", () => {
  it("duplicates default plan versions without preserving a stale payment method requirement", async () => {
    const { db, inserted } = createDbMocks(createPlanVersion())

    const result = await duplicatePlanVersion(
      {
        db,
        logger: createLogger(),
      },
      {
        id: "pv_source",
        projectId: "proj_123",
      }
    )

    expect(result.err).toBeUndefined()
    if (!result.val || result.val.state !== "ok") {
      throw new Error(`expected duplicate to succeed, got ${result.val?.state ?? "error"}`)
    }

    expect(inserted.version).toMatchObject({
      paymentMethodRequired: false,
      status: "draft",
      latest: false,
      active: true,
      metadata: {},
      version: 2,
    })
    expect(result.val.planVersion.paymentMethodRequired).toBe(false)
    expect(inserted.features[0]).toMatchObject({
      planVersionId: result.val.planVersion.id,
      metadata: { hidden: false },
    })
  })

  it("preserves payment method requirements for non-default plan versions", async () => {
    const { db, inserted } = createDbMocks(
      createPlanVersion({
        plan: {
          id: "plan_paid",
          projectId: "proj_123",
          defaultPlan: false,
        },
      })
    )

    const result = await duplicatePlanVersion(
      {
        db,
        logger: createLogger(),
      },
      {
        id: "pv_source",
        projectId: "proj_123",
      }
    )

    expect(result.err).toBeUndefined()
    if (!result.val || result.val.state !== "ok") {
      throw new Error(`expected duplicate to succeed, got ${result.val?.state ?? "error"}`)
    }

    expect(inserted.version).toMatchObject({
      paymentMethodRequired: true,
      status: "draft",
      version: 2,
    })
  })
})
