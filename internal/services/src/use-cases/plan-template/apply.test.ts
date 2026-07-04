import type { Database } from "@unprice/db"
import type { Event, Feature, Plan, PlanVersion, PlanVersionFeature } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { applyPlanTemplate } from "./apply"

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

function createDbMock({
  existingPlanVersions = [],
}: {
  existingPlanVersions?: Array<PlanVersion & { planFeatures: PlanVersionFeature[] }>
} = {}) {
  const findMany = vi.fn(async () => existingPlanVersions)

  return {
    query: {
      versions: {
        findMany,
      },
    },
    insert: vi.fn(() => ({
      values: (row: Record<string, unknown>) => ({
        returning: () => Promise.resolve([row]),
      }),
    })),
  } as unknown as Database
}

function makeFeature(slug: string): Feature {
  return {
    id: `feature_${slug}`,
    slug,
    title: slug,
    projectId: "proj_123",
    unitOfMeasure: "units",
    description: "",
    meterConfig: null,
  } as unknown as Feature
}

function makeEvent(availableProperties: string[]): Event {
  return {
    id: "event_workflow_runs",
    slug: "workflow_runs",
    name: "Workflow Runs",
    projectId: "proj_123",
    availableProperties,
  } as unknown as Event
}

function makePlanVersion(id: string, input: CreatePlanVersionInput): PlanVersion {
  return {
    id,
    projectId: input.projectId,
    planId: input.planId,
    title: input.title,
    description: input.description,
    currency: input.currency,
    paymentProvider: input.paymentProvider,
    status: "draft",
    latest: false,
    active: true,
    billingConfig: input.billingConfig,
    whenToBill: input.whenToBill,
    collectionMethod: input.collectionMethod,
    dueBehaviour: input.dueBehaviour,
    paymentMethodRequired: input.paymentMethodRequired,
    trialUnits: input.trialUnits,
    gracePeriod: input.gracePeriod,
    autoRenew: input.autoRenew,
    tags: input.tags,
    metadata: input.metadata,
    version: 1,
  } as unknown as PlanVersion
}

type CreatePlanVersionInput = Parameters<ServiceContext["plans"]["createPlanVersionRecord"]>[0]
type CreatePlanVersionFeatureInput = Parameters<
  ServiceContext["plans"]["createPlanVersionFeatureRecord"]
>[0]
type UpdateEventInput = Parameters<ServiceContext["events"]["updateEvent"]>[0]

describe("applyPlanTemplate", () => {
  it("creates the onboarding SaaS plan family through service primitives", async () => {
    let planVersionCount = 0
    let eventProperties: string[] = []
    const db = createDbMock()

    const getPlanBySlug = vi.fn(async () => Ok(null))
    const createPlanVersionRecord = vi.fn(async (input: CreatePlanVersionInput) => {
      planVersionCount += 1

      return Ok({
        state: "ok" as const,
        planVersion: makePlanVersion(`plan_version_${planVersionCount}`, input),
      })
    })
    const createPlanVersionFeatureRecord = vi.fn(async (input: CreatePlanVersionFeatureInput) =>
      Ok({
        state: "ok" as const,
        planVersionFeature: {
          id: `feature_version_${input.featureId}_${input.planVersionId}`,
          ...input,
          planVersion: {
            id: input.planVersionId,
            billingConfig: input.billingConfig,
          } as unknown as PlanVersion,
          feature: makeFeature(input.featureId),
        } as unknown as PlanVersionFeature & { planVersion: PlanVersion; feature: Feature },
      })
    )

    const getFeatureBySlug = vi.fn(async () => Ok(null))
    const createFeatureRecord = vi.fn(async ({ slug }: { slug: string }) => Ok(makeFeature(slug)))
    const listEventsByProject = vi.fn(async () => Ok([] as Event[]))
    const createEvent = vi.fn(
      async ({ availableProperties }: { availableProperties?: string[] | null }) => {
        eventProperties = availableProperties ?? []
        return Ok(makeEvent(eventProperties))
      }
    )
    const updateEvent = vi.fn(async (input: UpdateEventInput) => {
      eventProperties = input.availableProperties ?? []

      return Ok({
        state: "ok" as const,
        event: makeEvent(eventProperties),
      })
    })

    const result = await applyPlanTemplate(
      {
        services: {
          plans: {
            getPlanBySlug,
            createPlanVersionRecord,
            createPlanVersionFeatureRecord,
          },
          features: {
            getFeatureBySlug,
            createFeatureRecord,
          },
          events: {
            listEventsByProject,
            createEvent,
            updateEvent,
          },
          customers: {},
        } as unknown as Pick<ServiceContext, "plans" | "features" | "events" | "customers">,
        db,
        logger: createLogger(),
        userId: "usr_123",
      },
      {
        template: "saas_onboarding",
        projectId: "proj_123",
        workspaceUnPriceCustomerId: "cus_123",
        currency: "USD",
        paymentProvider: "sandbox",
        publish: false,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      state: "ok",
      primaryPlanVersionId: "plan_version_1",
      appliedTemplates: [
        { key: "starter", planVersionId: "plan_version_1" },
        { key: "pro", planVersionId: "plan_version_2" },
        { key: "enterprise", planVersionId: "plan_version_3" },
      ],
    })
    expect(createPlanVersionRecord).toHaveBeenCalledTimes(3)
    expect(createPlanVersionRecord.mock.calls[0]?.[0].tags).toEqual([
      "template:saas_onboarding",
      "template-plan:starter",
    ])
    expect(db.insert).toHaveBeenCalledTimes(3)
    expect(createPlanVersionFeatureRecord).toHaveBeenCalledTimes(17)

    const featureInputs = createPlanVersionFeatureRecord.mock.calls.map(([input]) => input)
    const usageInputs = featureInputs.filter((input) => input.featureType === "usage")

    expect(usageInputs).toHaveLength(6)
    expect(usageInputs.map((input) => input.meterConfig?.eventSlug)).toEqual(
      Array(6).fill("workflow_runs")
    )
    expect(eventProperties).toEqual(["credits", "compute"])

    const creditInputs = usageInputs.filter((input) => input.featureId === "feature_credits")
    expect(creditInputs).toHaveLength(3)
    expect(creditInputs.every((input) => input.config.usageMode === "tier")).toBe(true)
  })

  it("reuses completed template versions on retry", async () => {
    const plans: Record<string, Plan> = {
      starter: {
        id: "plan_starter",
        projectId: "proj_123",
        title: "Starter",
        slug: "starter",
      } as unknown as Plan,
      pro: {
        id: "plan_pro",
        projectId: "proj_123",
        title: "Pro",
        slug: "pro",
      } as unknown as Plan,
      enterprise: {
        id: "plan_enterprise",
        projectId: "proj_123",
        title: "Enterprise",
        slug: "enterprise",
      } as unknown as Plan,
    }
    const existingPlanVersions = [
      {
        id: "plan_version_starter",
        projectId: "proj_123",
        planId: "plan_starter",
        currency: "USD",
        paymentProvider: "sandbox",
        status: "published",
        tags: ["template:saas_onboarding", "template-plan:starter"],
        createdAtM: 1,
        planFeatures: [{ id: "feature_version_starter" } as unknown as PlanVersionFeature],
      },
      {
        id: "plan_version_pro",
        projectId: "proj_123",
        planId: "plan_pro",
        currency: "USD",
        paymentProvider: "sandbox",
        status: "published",
        tags: ["template:saas_onboarding", "template-plan:pro"],
        createdAtM: 2,
        planFeatures: [{ id: "feature_version_pro" } as unknown as PlanVersionFeature],
      },
      {
        id: "plan_version_enterprise",
        projectId: "proj_123",
        planId: "plan_enterprise",
        currency: "USD",
        paymentProvider: "sandbox",
        status: "published",
        tags: ["template:saas_onboarding", "template-plan:enterprise"],
        createdAtM: 3,
        planFeatures: [{ id: "feature_version_enterprise" } as unknown as PlanVersionFeature],
      },
    ] as Array<PlanVersion & { planFeatures: PlanVersionFeature[] }>
    const db = createDbMock({
      existingPlanVersions,
    })
    const createPlanVersionRecord = vi.fn()
    const createPlanVersionFeatureRecord = vi.fn()

    const result = await applyPlanTemplate(
      {
        services: {
          plans: {
            getPlanBySlug: vi.fn(async ({ slug }: { slug: string }) => Ok(plans[slug] ?? null)),
            createPlanVersionRecord,
            createPlanVersionFeatureRecord,
          },
          features: {
            getFeatureBySlug: vi.fn(async ({ slug }: { slug: string }) => Ok(makeFeature(slug))),
            createFeatureRecord: vi.fn(),
          },
          events: {
            listEventsByProject: vi.fn(),
            createEvent: vi.fn(),
            updateEvent: vi.fn(),
          },
          customers: {},
        } as unknown as Pick<ServiceContext, "plans" | "features" | "events" | "customers">,
        db,
        logger: createLogger(),
        userId: "usr_123",
      },
      {
        template: "saas_onboarding",
        projectId: "proj_123",
        workspaceUnPriceCustomerId: "cus_123",
        currency: "USD",
        paymentProvider: "sandbox",
        publish: true,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      state: "ok",
      primaryPlanVersionId: "plan_version_starter",
      appliedTemplates: [
        { key: "starter", planVersionId: "plan_version_starter" },
        { key: "pro", planVersionId: "plan_version_pro" },
        { key: "enterprise", planVersionId: "plan_version_enterprise" },
      ],
    })
    expect(createPlanVersionRecord).not.toHaveBeenCalled()
    expect(createPlanVersionFeatureRecord).not.toHaveBeenCalled()
    expect(db.insert).not.toHaveBeenCalled()
  })
})
