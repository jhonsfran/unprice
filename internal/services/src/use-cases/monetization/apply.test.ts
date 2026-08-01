import type { Database } from "@unprice/db"
import * as dbSchema from "@unprice/db/schema"
import {
  type BillingConfig,
  type Event,
  type Feature,
  type MonetizationConfigInput,
  type Plan,
  type PlanVersion,
  type PlanVersionFeature,
  type ResetConfig,
  computeConfigHash,
  isResetCadenceAtMostBilling,
  monetizationConfigSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import type { MaterializeContext } from "../plan-template/materialize"
import {
  type ApplyMonetizationConfigOutput,
  applyMonetizationConfig,
  resolvePlanDraft,
} from "./apply"

const PROJECT_ID = "proj_123"

type CreatePlanVersionInput = Parameters<ServiceContext["plans"]["createPlanVersionRecord"]>[0]
type UpdatePlanVersionInput = Parameters<ServiceContext["plans"]["updatePlanVersionRecord"]>[0]
type CreatePlanVersionFeatureInput = Parameters<
  ServiceContext["plans"]["createPlanVersionFeatureRecord"]
>[0]
type UpdatePlanVersionFeatureInput = Parameters<
  ServiceContext["plans"]["updatePlanVersionFeatureRecord"]
>[0]
type UpdatePlanInput = Parameters<ServiceContext["plans"]["updatePlanRecord"]>[0]
type CreateFeatureInput = Parameters<ServiceContext["features"]["createFeatureRecord"]>[0]
type UpdateFeatureInput = Parameters<ServiceContext["features"]["updateFeatureRecord"]>[0]
type CreateEventInput = Parameters<ServiceContext["events"]["createEvent"]>[0]
type UpdateEventInput = Parameters<ServiceContext["events"]["updateEvent"]>[0]

/** Mirrors `resetConfigFromBillingConfig` in the plan service. */
function resetConfigFromBilling(billingConfig: BillingConfig): ResetConfig {
  return {
    name: billingConfig.name,
    resetInterval: billingConfig.billingInterval,
    resetIntervalCount: billingConfig.billingIntervalCount,
    resetAnchor: billingConfig.billingAnchor,
    planType: billingConfig.planType,
  }
}

type StoredPlanVersion = PlanVersion & {
  planFeatures: Array<PlanVersionFeature & { feature: Feature }>
}

// ---------------------------------------------------------------------------
// A `where` clause evaluator, so the fake database actually filters.
//
// The use case narrows by `configHash` and `status` in SQL rather than in JS. A
// fake that ignored `where` would hand every row back and let a broken lookup
// pass every test in this file.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
type Predicate = (row: Row) => boolean
type Column = { column: string }

const columns = new Proxy({} as Record<string, Column>, {
  get: (_target, property) => ({ column: String(property) }),
})

const operators = {
  and:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  or:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.some((predicate) => predicate(row)),
  eq:
    (column: Column, value: unknown): Predicate =>
    (row) =>
      row[column.column] === value,
  ne:
    (column: Column, value: unknown): Predicate =>
    (row) =>
      row[column.column] !== value,
  isNotNull:
    (column: Column): Predicate =>
    (row) =>
      row[column.column] !== null && row[column.column] !== undefined,
}

type QueryArgs = {
  where?: (table: Record<string, Column>, ops: typeof operators) => Predicate
}

function runQuery<T extends Row>(rows: T[], args?: QueryArgs): T[] {
  if (!args?.where) return rows
  const predicate = args.where(columns, operators)
  return rows.filter((row) => predicate(row))
}

function createLogger() {
  const info = vi.fn()

  return {
    info,
    logger: {
      set: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      info,
      flush: vi.fn(),
    } as unknown as Logger,
  }
}

/**
 * Every row leaving the fake database is detached from the store, exactly as a
 * real query result is.
 *
 * Handing back the live object makes anything the caller kept magically fresh,
 * which is the one thing a fake must never do: read-then-write staleness is
 * invisible in the test and real in production.
 */
function detach<T>(row: T): T {
  return { ...row }
}

// ---------------------------------------------------------------------------
// In-memory project. Every fake mirrors the real service's observable contract,
// including the states that make this use case hard: `plan_version_published`
// on writes to a published version and `default_plan_exists` when another plan
// still holds the default.
// ---------------------------------------------------------------------------

function createHarness() {
  const store = {
    plans: [] as Plan[],
    features: [] as Feature[],
    events: [] as Event[],
    versions: [] as StoredPlanVersion[],
  }
  /** Lets a test crash one write without restating the whole fake. */
  const control = {
    failFeatureWrite: null as null | ((input: CreatePlanVersionFeatureInput) => FetchError | null),
  }
  /**
   * How many plans hold the default flag after each `updatePlanRecord`. A
   * project with no default plan cannot answer `customers.signUp` without a
   * `planSlug`, so the length of that window is the thing under test.
   */
  const defaultHolders: number[] = []
  let planVersionSequence = 0

  const insert = vi.fn((table: unknown) => ({
    values: (row: Record<string, unknown>) => ({
      returning: async () => {
        if (table !== dbSchema.plans) {
          throw new Error("monetization.apply wrote to a table it does not own")
        }
        store.plans.push(row as unknown as Plan)
        return [row]
      },
    }),
  }))

  const db = {
    query: {
      versions: {
        // `planFeatures` stays shared by reference: a real `with` join re-reads
        // the rows, so a feature written since is visible either way.
        findMany: vi.fn(async (args?: QueryArgs) => runQuery(store.versions, args).map(detach)),
      },
      plans: {
        findFirst: vi.fn(async (args?: QueryArgs) => {
          const plan = runQuery(store.plans, args)[0]
          return plan && detach(plan)
        }),
      },
    },
    insert,
  } as unknown as Database

  const getPlanBySlug = vi.fn(async ({ slug }: { slug: string }) => {
    const plan = store.plans.find((candidate) => candidate.slug === slug)
    return Ok(plan ? detach(plan) : null)
  })

  const updatePlanRecord = vi.fn(async (input: UpdatePlanInput) => {
    const plan = store.plans.find(({ id }) => id === input.id)
    if (!plan) return Ok({ state: "plan_not_found" as const })
    if (input.defaultPlan && input.enterprisePlan) {
      return Ok({ state: "default_enterprise_conflict" as const })
    }
    if (
      input.defaultPlan &&
      store.plans.some((other) => other.defaultPlan && other.id !== input.id)
    ) {
      return Ok({ state: "default_plan_exists" as const })
    }

    if (input.title !== undefined) plan.title = input.title
    if (input.description !== undefined) plan.description = input.description
    plan.defaultPlan = input.defaultPlan ?? false
    plan.enterprisePlan = input.enterprisePlan ?? false
    defaultHolders.push(store.plans.filter(({ defaultPlan }) => defaultPlan).length)

    return Ok({ state: "ok" as const, plan: detach(plan) })
  })

  const createPlanVersionRecord = vi.fn(async (input: CreatePlanVersionInput) => {
    if (!store.plans.some(({ id }) => id === input.planId)) {
      return Ok({ state: "plan_not_found" as const })
    }

    planVersionSequence += 1
    const planVersion = {
      id: `plan_version_${planVersionSequence}`,
      projectId: input.projectId,
      planId: input.planId,
      title: input.title,
      description: input.description,
      currency: input.currency,
      paymentProvider: input.paymentProvider,
      status: input.status ?? "draft",
      configHash: input.configHash ?? null,
      tags: input.tags ?? [],
      createdAtM: planVersionSequence,
      billingConfig: {
        ...input.billingConfig,
        billingAnchor: input.billingConfig.billingAnchor ?? "dayOfCreation",
      },
      whenToBill: input.whenToBill,
      collectionMethod: input.collectionMethod,
      dueBehaviour: input.dueBehaviour,
      paymentMethodRequired: input.paymentMethodRequired,
      trialUnits: input.trialUnits,
      gracePeriod: input.gracePeriod,
      autoRenew: input.autoRenew,
      metadata: input.metadata,
      version: planVersionSequence,
      planFeatures: [],
    } as unknown as StoredPlanVersion

    store.versions.push(planVersion)
    return Ok({ state: "ok" as const, planVersion: detach(planVersion) })
  })

  const updatePlanVersionRecord = vi.fn(async (input: UpdatePlanVersionInput) => {
    const planVersion = store.versions.find(({ id }) => id === input.id)
    if (!planVersion) return Ok({ state: "not_found" as const })

    if (input.title !== undefined) planVersion.title = input.title
    if (input.description !== undefined) planVersion.description = input.description

    return Ok({ state: "ok" as const, planVersion: detach(planVersion) })
  })

  const createPlanVersionFeatureRecord = vi.fn(async (input: CreatePlanVersionFeatureInput) => {
    const failure = control.failFeatureWrite?.(input)
    if (failure) return Err(failure)

    const planVersion = store.versions.find(({ id }) => id === input.planVersionId)
    if (!planVersion) return Ok({ state: "plan_version_not_found" as const })
    if (planVersion.status === "published") return Ok({ state: "plan_version_published" as const })

    const feature = store.features.find(({ id }) => id === input.featureId)
    if (!feature) return Ok({ state: "feature_not_found" as const })

    // The real writer decides the billing/reset/meter snapshot; a fake that just
    // echoed the input would hide every mistake in what we hand it.
    const billingConfig =
      input.featureType === "usage" ? input.billingConfig : planVersion.billingConfig
    const resetConfig =
      input.featureType === "usage"
        ? (input.resetConfig ?? resetConfigFromBilling(billingConfig))
        : null
    const meterConfig =
      input.featureType !== "usage"
        ? null
        : input.hasMeterConfigOverride
          ? (input.meterConfig ?? null)
          : (feature.meterConfig ?? null)

    if (input.featureType === "usage" && !meterConfig) {
      return Ok({ state: "usage_meter_config_required" as const })
    }
    if (
      input.featureType === "usage" &&
      resetConfig &&
      !isResetCadenceAtMostBilling(resetConfig, billingConfig)
    ) {
      return Ok({ state: "invalid_reset_config" as const })
    }

    const planVersionFeature = {
      ...input,
      id: `feature_version_${input.planVersionId}_${feature.slug}`,
      unitOfMeasure: input.unitOfMeasure ?? feature.unitOfMeasure ?? "units",
      billingConfig,
      resetConfig,
      meterConfig,
      feature,
    } as unknown as PlanVersionFeature & { feature: Feature }

    planVersion.planFeatures.push(planVersionFeature)
    return Ok({ state: "ok" as const, planVersionFeature })
  })

  const updatePlanVersionFeatureRecord = vi.fn(async (input: UpdatePlanVersionFeatureInput) => {
    const planVersion = store.versions.find(({ id }) => id === input.planVersionId)
    if (!planVersion) return Ok({ state: "plan_version_not_found" as const })
    if (planVersion.status === "published") return Ok({ state: "plan_version_published" as const })

    const planVersionFeature = planVersion.planFeatures.find(({ id }) => id === input.id)
    if (!planVersionFeature) return Ok({ state: "plan_version_feature_not_found" as const })

    // Mirrors the real writer: it only touches the meter when told to, and
    // demands one whenever it does touch a usage feature's.
    const featureType = input.featureType ?? planVersionFeature.featureType
    const shouldUpdateMeterConfig =
      input.hasMeterConfigOverride ||
      input.featureId !== undefined ||
      input.featureType !== undefined
    const meterConfig =
      featureType !== "usage"
        ? null
        : input.hasMeterConfigOverride
          ? (input.meterConfig ?? null)
          : (planVersionFeature.feature.meterConfig ?? null)

    if (featureType === "usage" && shouldUpdateMeterConfig && !meterConfig) {
      return Ok({ state: "usage_meter_config_required" as const })
    }

    if (shouldUpdateMeterConfig) planVersionFeature.meterConfig = meterConfig
    if (input.unitOfMeasure !== undefined) {
      planVersionFeature.unitOfMeasure = input.unitOfMeasure
    }

    return Ok({ state: "ok" as const, planVersionFeature: detach(planVersionFeature) })
  })

  const getFeatureBySlug = vi.fn(async ({ slug }: { slug: string }) => {
    const feature = store.features.find((candidate) => candidate.slug === slug)
    return Ok(feature ? detach(feature) : null)
  })

  const createFeatureRecord = vi.fn(async (input: CreateFeatureInput) => {
    const feature = {
      id: `feature_${input.slug}`,
      projectId: PROJECT_ID,
      slug: input.slug,
      title: input.title,
      description: input.description ?? "",
      unitOfMeasure: input.unitOfMeasure ?? "units",
      meterConfig: null,
    } as unknown as Feature

    store.features.push(feature)
    return Ok(detach(feature))
  })

  const updateFeatureRecord = vi.fn(async (input: UpdateFeatureInput) => {
    const feature = store.features.find(({ id }) => id === input.id)
    if (!feature) return Ok({ state: "not_found" as const })

    feature.title = input.title
    feature.description = input.description ?? ""
    // The real writer stores `unitOfMeasure ?? ""`, which is exactly why the
    // caller has to hand the current value back.
    feature.unitOfMeasure = input.unitOfMeasure ?? ""

    return Ok({ state: "ok" as const, feature: detach(feature) })
  })

  const listEventsByProject = vi.fn(async () => Ok(store.events.map(detach)))

  const createEvent = vi.fn(async (input: CreateEventInput) => {
    const event = {
      id: `event_${input.slug}`,
      projectId: PROJECT_ID,
      slug: input.slug,
      name: input.name,
      availableProperties: input.availableProperties ?? [],
    } as unknown as Event

    store.events.push(event)
    return Ok(detach(event))
  })

  const updateEvent = vi.fn(async (input: UpdateEventInput) => {
    const event = store.events.find(({ id }) => id === input.id)
    if (!event) return Ok({ state: "not_found" as const })

    if (input.hasAvailableProperties) {
      event.availableProperties = Array.from(
        new Set([...(event.availableProperties ?? []), ...(input.availableProperties ?? [])])
      )
    }

    return Ok({ state: "ok" as const, event: detach(event) })
  })

  const services = {
    plans: {
      getPlanBySlug,
      updatePlanRecord,
      createPlanVersionRecord,
      updatePlanVersionRecord,
      createPlanVersionFeatureRecord,
      updatePlanVersionFeatureRecord,
    },
    features: { getFeatureBySlug, createFeatureRecord, updateFeatureRecord },
    events: { listEventsByProject, createEvent, updateEvent },
  } as unknown as Pick<ServiceContext, "plans" | "features" | "events">

  const { logger, info: wideEvent } = createLogger()

  return {
    store,
    control,
    defaultHolders,
    wideEvent,
    deps: { services, db, logger },
    spies: {
      insert,
      getPlanBySlug,
      updatePlanRecord,
      createPlanVersionRecord,
      updatePlanVersionRecord,
      createPlanVersionFeatureRecord,
      updatePlanVersionFeatureRecord,
      getFeatureBySlug,
      createFeatureRecord,
      updateFeatureRecord,
      createEvent,
      updateEvent,
    },
  }
}

function baseConfig(): MonetizationConfigInput {
  return {
    events: [{ slug: "chat_request", name: "Chat request" }],
    features: [
      { slug: "support", title: "Support", unitOfMeasure: "access" },
      { slug: "chat-messages", title: "Chat messages", unitOfMeasure: "message" },
    ],
    plans: [
      {
        slug: "free",
        title: "Free",
        defaultPlan: true,
        version: {
          currency: "USD",
          paymentProvider: "stripe",
          billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
          features: [
            { featureSlug: "support", featureType: "flat", config: { price: "0.00" } },
            {
              featureSlug: "chat-messages",
              featureType: "usage",
              config: { usageMode: "unit", price: "0.01" },
              meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
              limit: 20,
              resetConfig: { interval: "day" },
            },
          ],
        },
      },
      {
        slug: "pro",
        title: "Pro",
        version: {
          currency: "USD",
          paymentProvider: "stripe",
          billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
          features: [
            { featureSlug: "support", featureType: "flat", config: { price: "20.00" } },
            {
              featureSlug: "chat-messages",
              featureType: "usage",
              config: { usageMode: "unit", price: "0.005" },
              meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
            },
          ],
        },
      },
    ],
  }
}

/** Narrows to the success branch and fails the test with the real state otherwise. */
function expectApplied(
  result: Awaited<ReturnType<typeof applyMonetizationConfig>>
): Extract<ApplyMonetizationConfigOutput, { state: "ok" }> {
  expect(result.err).toBeUndefined()
  expect(result.val?.state).toBe("ok")
  if (result.val?.state !== "ok") throw new Error("expected a successful apply")
  return result.val
}

function versionsOfPlan(store: ReturnType<typeof createHarness>["store"], slug: string) {
  const plan = store.plans.find((candidate) => candidate.slug === slug)
  return store.versions.filter((version) => version.planId === plan?.id)
}

// ---------------------------------------------------------------------------
// Draft resolution on its own. `resolvePlanDraft` decides which existing version
// a content address maps to, and the interesting states — two drafts with one
// hash, a live version, a half-written draft — are all seeded, not produced by
// arranging several full applies.
// ---------------------------------------------------------------------------

/** The document's free plan, as parse output. The hash is only defined on that. */
function parsedFreePlan(mutate?: (config: MonetizationConfigInput) => void) {
  const config = baseConfig()
  mutate?.(config)
  const plan = monetizationConfigSchema.parse(config).plans[0]
  if (!plan) throw new Error("fixture changed")
  return plan
}

function seedDraftContext(harness: ReturnType<typeof createHarness>) {
  const { store, deps } = harness
  const planRow = {
    id: "plan_free",
    projectId: PROJECT_ID,
    slug: "free",
    title: "Free",
    description: "",
    active: true,
    defaultPlan: true,
    enterprisePlan: false,
  } as unknown as Plan

  store.plans.push(planRow)
  store.features.push(
    {
      id: "feature_support",
      projectId: PROJECT_ID,
      slug: "support",
      title: "Support",
      description: "",
      unitOfMeasure: "access",
      meterConfig: null,
    } as unknown as Feature,
    {
      id: "feature_chat-messages",
      projectId: PROJECT_ID,
      slug: "chat-messages",
      title: "Chat messages",
      description: "",
      unitOfMeasure: "message",
      meterConfig: null,
    } as unknown as Feature
  )
  store.events.push({
    id: "event_chat_request",
    projectId: PROJECT_ID,
    slug: "chat_request",
    name: "Chat request",
    availableProperties: [],
  } as unknown as Event)

  return {
    planRow,
    context: {
      deps,
      projectId: PROJECT_ID,
      caches: {
        features: new Map(store.features.map((feature) => [feature.slug, feature])),
        events: new Map(store.events.map((event) => [event.slug, event])),
        planVersionFeatureSlugs: new Map<string, Set<string>>(),
      },
    } as MaterializeContext,
  }
}

function seedVersion(
  store: ReturnType<typeof createHarness>["store"],
  {
    id,
    configHash,
    createdAtM,
    status = "draft",
    featureSlugs,
  }: {
    id: string
    configHash: string
    createdAtM: number
    status?: "draft" | "published"
    featureSlugs: string[]
  }
) {
  const version = {
    id,
    projectId: PROJECT_ID,
    planId: "plan_free",
    title: "Free",
    description: "",
    currency: "USD",
    paymentProvider: "stripe",
    status,
    configHash,
    createdAtM,
    billingConfig: {
      name: "monthly",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "recurring",
    },
    planFeatures: featureSlugs.map((slug) => ({
      id: `feature_version_${id}_${slug}`,
      featureId: `feature_${slug}`,
      unitOfMeasure: slug === "support" ? "access" : "message",
      feature: store.features.find((feature) => feature.slug === slug),
    })),
  } as unknown as StoredPlanVersion

  store.versions.push(version)
  return version
}

describe("applyMonetizationConfig", () => {
  it("creates events, features, plans, and one draft version per plan in an empty project", async () => {
    const { deps, store } = createHarness()

    const result = await applyMonetizationConfig(deps, {
      projectId: PROJECT_ID,
      config: baseConfig(),
    })
    const applied = expectApplied(result)

    expect(store.events.map(({ slug }) => slug)).toEqual(["chat_request"])
    expect(store.features.map(({ slug }) => slug)).toEqual(["support", "chat-messages"])
    expect(store.plans.map(({ slug }) => slug)).toEqual(["free", "pro"])
    expect(store.versions).toHaveLength(2)
    expect(store.versions.map(({ status }) => status)).toEqual(["draft", "draft"])
    expect(store.versions.every(({ configHash }) => typeof configHash === "string")).toBe(true)
    // Two plans priced differently must not collide onto one content address.
    expect(new Set(store.versions.map(({ configHash }) => configHash)).size).toBe(2)

    expect(applied.plans).toEqual([
      { slug: "free", planVersionId: "plan_version_1", status: "created" },
      { slug: "pro", planVersionId: "plan_version_2", status: "created" },
    ])
    expect(applied.staleDrafts).toEqual([])
    expect(applied.integrationContract.defaultPlan).toMatchObject({
      slug: "free",
      planVersionId: "plan_version_1",
    })

    expect(
      store.versions.map((version) => version.planFeatures.map(({ feature }) => feature.slug))
    ).toEqual([
      ["support", "chat-messages"],
      ["support", "chat-messages"],
    ])

    const metered = store.versions[0]?.planFeatures.find(
      ({ feature }) => feature.slug === "chat-messages"
    )
    // The boundary speaks event slugs; the stored snapshot has to carry the id.
    expect(metered?.meterConfig).toEqual({
      eventId: "event_chat_request",
      eventSlug: "chat_request",
      aggregationMethod: "count",
    })
    // The boundary speaks decimal strings; the stored snapshot has to be Dinero.
    expect(metered?.config).toMatchObject({
      usageMode: "unit",
      price: { displayAmount: "0.01", dinero: { amount: 1, scale: 2 } },
    })
    expect(metered?.featureType).toBe("usage")
    expect(metered?.limit).toBe(20)
    expect(metered?.resetConfig).toMatchObject({ resetInterval: "day", resetIntervalCount: 1 })
    expect(metered?.unitOfMeasure).toBe("message")
    // Order follows the document, so the dashboard shows what the agent wrote.
    expect(store.versions[0]?.planFeatures.map(({ order }) => order)).toEqual([1024, 2048])

    expect(store.plans.find(({ slug }) => slug === "free")?.defaultPlan).toBe(true)
    expect(store.plans.find(({ slug }) => slug === "pro")?.defaultPlan).toBe(false)
  })

  it("creates nothing and reports every plan unchanged on an identical second apply", async () => {
    const { deps, store, spies } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    spies.createPlanVersionRecord.mockClear()
    spies.createPlanVersionFeatureRecord.mockClear()
    spies.createFeatureRecord.mockClear()
    spies.createEvent.mockClear()
    spies.insert.mockClear()

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    expect(spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(spies.createPlanVersionFeatureRecord).not.toHaveBeenCalled()
    expect(spies.createFeatureRecord).not.toHaveBeenCalled()
    expect(spies.createEvent).not.toHaveBeenCalled()
    expect(spies.insert).not.toHaveBeenCalled()
    expect(store.versions).toHaveLength(2)
    expect(second.plans).toEqual([
      { slug: "free", planVersionId: first.plans[0]?.planVersionId, status: "unchanged" },
      { slug: "pro", planVersionId: first.plans[1]?.planVersionId, status: "unchanged" },
    ])
    expect(second.staleDrafts).toEqual([])
  })

  it("creates nothing when the document only reorders features", async () => {
    const { deps, store, spies } = createHarness()

    await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })

    const reordered = baseConfig()
    for (const plan of reordered.plans) {
      plan.version.features.reverse()
    }

    spies.createPlanVersionRecord.mockClear()
    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: reordered })
    )

    expect(spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(store.versions).toHaveLength(2)
    expect(second.plans.map(({ status }) => status)).toEqual(["unchanged", "unchanged"])
  })

  it("creates a new draft for a price change and leaves the published version untouched", async () => {
    const { deps, store, spies } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    // The human publishes in the dashboard. Everything below has to route around it.
    const published = store.versions.find(({ id }) => id === first.plans[0]?.planVersionId)
    if (!published) throw new Error("missing the version the first apply reported")
    published.status = "published"
    const publishedFeatureCount = published.planFeatures.length
    const publishedPrice = published.planFeatures.find(
      ({ feature }) => feature.slug === "chat-messages"
    )?.config

    const repriced = baseConfig()
    const meteredFeature = repriced.plans[0]?.version.features[1]
    if (!meteredFeature) throw new Error("fixture changed")
    meteredFeature.config.price = "0.02"

    spies.createPlanVersionRecord.mockClear()
    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: repriced })
    )

    expect(spies.createPlanVersionRecord).toHaveBeenCalledTimes(1)
    expect(versionsOfPlan(store, "free")).toHaveLength(2)
    expect(second.plans[0]).toMatchObject({ slug: "free", status: "created" })
    expect(second.plans[0]?.planVersionId).not.toBe(published.id)
    expect(second.plans[1]).toMatchObject({ slug: "pro", status: "unchanged" })

    // Untouched and still live.
    expect(published.status).toBe("published")
    expect(published.planFeatures).toHaveLength(publishedFeatureCount)
    expect(
      published.planFeatures.find(({ feature }) => feature.slug === "chat-messages")?.config
    ).toEqual(publishedPrice)
    expect(
      spies.createPlanVersionFeatureRecord.mock.calls.filter(
        ([input]) => input.planVersionId === published.id
      )
    ).toHaveLength(2)

    const draft = store.versions.find(({ id }) => id === second.plans[0]?.planVersionId)
    expect(draft?.status).toBe("draft")
    expect(
      draft?.planFeatures.find(({ feature }) => feature.slug === "chat-messages")?.config
    ).toMatchObject({ price: { displayAmount: "0.02" } })
  })

  it("finishes a half-materialized draft on the next apply without creating a duplicate version", async () => {
    const { deps, store, spies, control } = createHarness()

    control.failFeatureWrite = (input) => {
      if (input.featureId !== "feature_chat-messages") return null
      control.failFeatureWrite = null
      return new FetchError({ message: "simulated crash mid materialization", retry: true })
    }

    const crashed = await applyMonetizationConfig(deps, {
      projectId: PROJECT_ID,
      config: baseConfig(),
    })

    expect(crashed.err?.message).toBe("simulated crash mid materialization")
    expect(store.versions).toHaveLength(1)
    expect(store.versions[0]?.planFeatures.map(({ feature }) => feature.slug)).toEqual(["support"])

    // Order is not hashed, so a reordered document legitimately matches the same
    // half-written draft. Numbering the remainder from the document index would
    // land the second feature on top of the first.
    const reordered = baseConfig()
    for (const plan of reordered.plans) {
      plan.version.features.reverse()
    }

    const resumed = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: reordered })
    )

    // The half-materialized draft is finished in place: two plans, two versions.
    expect(store.versions).toHaveLength(2)
    expect(spies.createPlanVersionRecord).toHaveBeenCalledTimes(2)
    expect(store.versions[0]?.planFeatures.map(({ feature }) => feature.slug)).toEqual([
      "support",
      "chat-messages",
    ])
    expect(store.versions[0]?.planFeatures.map(({ order }) => order)).toEqual([1024, 2048])
    expect(
      spies.createPlanVersionFeatureRecord.mock.calls.filter(
        ([input]) =>
          input.planVersionId === store.versions[0]?.id && input.featureId === "feature_support"
      )
    ).toHaveLength(1)
    expect(resumed.plans.map(({ status }) => status)).toEqual(["created", "created"])
    expect(resumed.staleDrafts).toEqual([])
  })

  it("reports published and creates no draft when the hash matches a published version", async () => {
    const { deps, store, spies } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )
    const freeVersion = store.versions.find(({ id }) => id === first.plans[0]?.planVersionId)
    if (!freeVersion) throw new Error("fixture changed")

    // A draft left over from a concurrent apply, then the human publishes the
    // other one. The leftover now describes something already live.
    store.versions.push({
      ...freeVersion,
      id: "plan_version_twin",
      createdAtM: (freeVersion.createdAtM ?? 0) + 5,
      planFeatures: [...freeVersion.planFeatures],
    } as unknown as StoredPlanVersion)

    for (const version of store.versions) {
      if (version.id !== "plan_version_twin") version.status = "published"
    }

    spies.createPlanVersionRecord.mockClear()
    spies.createPlanVersionFeatureRecord.mockClear()

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    expect(spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(spies.createPlanVersionFeatureRecord).not.toHaveBeenCalled()
    expect(store.versions).toHaveLength(3)
    expect(second.plans).toEqual([
      { slug: "free", planVersionId: first.plans[0]?.planVersionId, status: "published" },
      { slug: "pro", planVersionId: first.plans[1]?.planVersionId, status: "published" },
    ])
    // The live version wins even though the draft is newer, and the draft is
    // handed back as something to clean up.
    expect(second.staleDrafts).toEqual([{ slug: "free", planVersionId: "plan_version_twin" }])
  })

  it("reports superseded drafts in staleDrafts without deleting them", async () => {
    const { deps, store } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )
    const supersededId = first.plans[0]?.planVersionId

    const repriced = baseConfig()
    const flatFeature = repriced.plans[0]?.version.features[0]
    if (!flatFeature) throw new Error("fixture changed")
    flatFeature.config.price = "1.00"

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: repriced })
    )

    expect(second.staleDrafts).toEqual([{ slug: "free", planVersionId: supersededId }])
    // The draft that pro still points at is current, not stale.
    expect(second.staleDrafts.map(({ planVersionId }) => planVersionId)).not.toContain(
      first.plans[1]?.planVersionId
    )
    expect(store.versions.map(({ id }) => id)).toContain(supersededId)
    expect(versionsOfPlan(store, "free")).toHaveLength(2)
  })

  it("leaves a dashboard-authored draft out of staleDrafts", async () => {
    const { deps, store } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )
    const freePlan = store.plans.find(({ slug }) => slug === "free")

    // A draft somebody started in the dashboard. It carries no content address,
    // so no document ever superseded it and apply must not call it stale.
    store.versions.push({
      id: "plan_version_handmade",
      projectId: PROJECT_ID,
      planId: freePlan?.id,
      status: "draft",
      configHash: null,
      createdAtM: 99,
      planFeatures: [],
    } as unknown as StoredPlanVersion)

    const repriced = baseConfig()
    const flatFeature = repriced.plans[0]?.version.features[0]
    if (!flatFeature) throw new Error("fixture changed")
    flatFeature.config.price = "1.00"

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: repriced })
    )

    expect(second.staleDrafts).toEqual([
      { slug: "free", planVersionId: first.plans[0]?.planVersionId },
    ])
  })

  it("keeps the newest of two same-hash drafts and reports the twin", async () => {
    const { deps, store, spies } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )
    const original = store.versions.find(({ id }) => id === first.plans[0]?.planVersionId)
    if (!original) throw new Error("fixture changed")

    // What a second apply racing the first would have left behind: the same
    // content address on a second row, because the index is not unique.
    store.versions.push({
      ...original,
      id: "plan_version_twin",
      createdAtM: (original.createdAtM ?? 0) - 1,
      planFeatures: [...original.planFeatures],
    } as unknown as StoredPlanVersion)

    spies.createPlanVersionRecord.mockClear()
    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    expect(spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(second.plans[0]).toMatchObject({
      planVersionId: original.id,
      status: "unchanged",
    })
    expect(second.staleDrafts).toEqual([{ slug: "free", planVersionId: "plan_version_twin" }])
    expect(store.versions.map(({ id }) => id)).toContain("plan_version_twin")
  })

  it("fails with slug_conflict before any write when a feature slug has another unitOfMeasure", async () => {
    const { deps, store, spies } = createHarness()

    store.features.push({
      id: "feature_chat-messages",
      projectId: PROJECT_ID,
      slug: "chat-messages",
      title: "Chat messages",
      description: "",
      unitOfMeasure: "token",
      meterConfig: null,
    } as unknown as Feature)

    const result = await applyMonetizationConfig(deps, {
      projectId: PROJECT_ID,
      config: baseConfig(),
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ state: "slug_conflict", slug: "chat-messages" })
    expect(store.events).toHaveLength(0)
    expect(store.plans).toHaveLength(0)
    expect(store.versions).toHaveLength(0)
    expect(spies.createEvent).not.toHaveBeenCalled()
    expect(spies.createFeatureRecord).not.toHaveBeenCalled()
    expect(spies.insert).not.toHaveBeenCalled()
    expect(spies.createPlanVersionRecord).not.toHaveBeenCalled()
  })

  it("sets defaultPlan on the plan row and moves it between plans without creating a version", async () => {
    const { deps, store, spies } = createHarness()

    await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })

    expect(store.plans.find(({ slug }) => slug === "free")?.defaultPlan).toBe(true)
    expect(store.plans.find(({ slug }) => slug === "pro")?.defaultPlan).toBe(false)

    const moved = baseConfig()
    const [free, pro] = moved.plans
    if (!free || !pro) throw new Error("fixture changed")
    free.defaultPlan = false
    pro.defaultPlan = true
    // The new holder comes first, so the old one is still holding the flag when
    // it is reached. Nothing in document order may decide whether this works.
    moved.plans = [pro, free]

    spies.createPlanVersionRecord.mockClear()
    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: moved })
    )

    expect(store.plans.find(({ slug }) => slug === "free")?.defaultPlan).toBe(false)
    expect(store.plans.find(({ slug }) => slug === "pro")?.defaultPlan).toBe(true)
    expect(spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(store.versions).toHaveLength(2)
    expect(second.plans.map(({ slug, status }) => [slug, status])).toEqual([
      ["pro", "unchanged"],
      ["free", "unchanged"],
    ])
    expect(second.integrationContract.defaultPlan.slug).toBe("pro")
  })

  it("renames the outgoing default plan when it is listed after the new one", async () => {
    const { deps, store, spies } = createHarness()

    await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })

    const moved = baseConfig()
    const [free, pro] = moved.plans
    if (!free || !pro) throw new Error("fixture changed")
    pro.defaultPlan = true
    free.defaultPlan = false
    // The outgoing holder is written after the flag has already moved, and it
    // has a label change of its own so it cannot be skipped. Its row was read
    // before the release, so anything computed off that snapshot is stale.
    free.title = "Free Tier"
    moved.plans = [pro, free]

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: moved })
    )

    expect(store.plans.find(({ slug }) => slug === "free")).toMatchObject({
      title: "Free Tier",
      defaultPlan: false,
    })
    expect(store.plans.find(({ slug }) => slug === "pro")?.defaultPlan).toBe(true)
    expect(second.plans.map(({ status }) => status)).toEqual(["unchanged", "unchanged"])
    expect(spies.createPlanVersionRecord).toHaveBeenCalledTimes(2)
  })

  it("takes the default from a plan the document does not mention", async () => {
    const { deps, store } = createHarness()

    store.plans.push({
      id: "plan_legacy",
      projectId: PROJECT_ID,
      slug: "legacy",
      title: "Legacy",
      description: "",
      active: true,
      defaultPlan: true,
      enterprisePlan: true,
    } as unknown as Plan)

    const applied = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    const legacy = store.plans.find(({ slug }) => slug === "legacy")
    expect(legacy?.defaultPlan).toBe(false)
    // updatePlanRecord rewrites both exclusivity flags, so releasing the default
    // must not quietly demote an enterprise plan as well.
    expect(legacy?.enterprisePlan).toBe(true)
    expect(store.plans.find(({ slug }) => slug === "free")?.defaultPlan).toBe(true)
    expect(applied.integrationContract.defaultPlan.slug).toBe("free")
  })

  it("refreshes a matched draft's unitOfMeasure snapshot but never a published one", async () => {
    const { deps, store, spies } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    // A dashboard edit renames the unit. It is excluded from the hash, so the
    // next apply matches the same versions and only the draft may be refreshed.
    const feature = store.features.find(({ slug }) => slug === "chat-messages")
    if (!feature) throw new Error("fixture changed")
    feature.unitOfMeasure = "messages"

    const publishedVersion = store.versions.find(({ id }) => id === first.plans[1]?.planVersionId)
    if (!publishedVersion) throw new Error("fixture changed")
    publishedVersion.status = "published"

    const renamed = baseConfig()
    for (const declared of renamed.features ?? []) {
      if (declared.slug === "chat-messages") declared.unitOfMeasure = "messages"
    }

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: renamed })
    )

    expect(second.plans.map(({ status }) => status)).toEqual(["unchanged", "published"])
    expect(store.versions).toHaveLength(2)

    const draftSnapshot = store.versions
      .find(({ id }) => id === first.plans[0]?.planVersionId)
      ?.planFeatures.find(({ feature: row }) => row.slug === "chat-messages")
    expect(draftSnapshot?.unitOfMeasure).toBe("messages")

    const publishedSnapshot = publishedVersion.planFeatures.find(
      ({ feature: row }) => row.slug === "chat-messages"
    )
    expect(publishedSnapshot?.unitOfMeasure).toBe("message")
    expect(
      spies.updatePlanVersionFeatureRecord.mock.calls.filter(
        ([input]) => input.planVersionId === publishedVersion.id
      )
    ).toHaveLength(0)
  })

  it("relabels renamed features and plans instead of reporting unchanged over stale rows", async () => {
    const { deps, store } = createHarness()

    const first = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    const relabelled = baseConfig()
    const declaredFeature = relabelled.features?.find(({ slug }) => slug === "support")
    const declaredPlan = relabelled.plans[0]
    if (!declaredFeature || !declaredPlan) throw new Error("fixture changed")
    declaredFeature.title = "Premium Support"
    declaredFeature.description = "24/7 support"
    declaredPlan.title = "Free Forever"
    declaredPlan.description = "The starting plan"

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: relabelled })
    )

    // Labels are unversioned, so nothing new is created — but nothing is dropped
    // on the floor either.
    expect(second.plans.map(({ status }) => status)).toEqual(["unchanged", "unchanged"])
    expect(store.versions).toHaveLength(2)

    const feature = store.features.find(({ slug }) => slug === "support")
    expect(feature).toMatchObject({
      title: "Premium Support",
      description: "24/7 support",
      // The unit was never in the document's drift, and must survive the write.
      unitOfMeasure: "access",
    })

    expect(store.plans.find(({ slug }) => slug === "free")).toMatchObject({
      title: "Free Forever",
      description: "The starting plan",
    })

    const draft = store.versions.find(({ id }) => id === first.plans[0]?.planVersionId)
    expect(draft).toMatchObject({ title: "Free Forever", description: "The starting plan" })
  })

  it("never leaves the project without a default plan, even with the default listed last", async () => {
    const { deps, store, defaultHolders } = createHarness()

    const threePlans = (): MonetizationConfigInput => {
      const config = baseConfig()
      const [free, pro] = config.plans
      if (!free || !pro) throw new Error("fixture changed")
      config.plans = [free, pro, { ...pro, slug: "scale", title: "Scale", defaultPlan: false }]
      return config
    }

    await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: threePlans() })
    expect(store.plans.find(({ slug }) => slug === "free")?.defaultPlan).toBe(true)

    const moved = threePlans()
    const [free, pro, scale] = moved.plans
    if (!free || !pro || !scale) throw new Error("fixture changed")
    free.defaultPlan = false
    // Last in the document, with two unrelated plan writes ahead of it.
    scale.defaultPlan = true
    free.title = "Free Tier"
    pro.title = "Pro Tier"

    defaultHolders.length = 0
    expectApplied(await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: moved }))

    expect(store.plans.find(({ slug }) => slug === "free")?.defaultPlan).toBe(false)
    expect(store.plans.find(({ slug }) => slug === "scale")?.defaultPlan).toBe(true)
    // The flag may be in flight across the release/claim pair and no longer.
    expect(
      defaultHolders.filter((count, index) => count === 0 && defaultHolders[index + 1] === 0)
    ).toEqual([])
    expect(defaultHolders.at(-1)).toBe(1)
  })

  it("refuses to demote an enterprise plan into the default plan", async () => {
    const { deps, store } = createHarness()

    store.plans.push({
      id: "plan_free",
      projectId: PROJECT_ID,
      slug: "free",
      title: "Free",
      description: "",
      active: true,
      defaultPlan: false,
      enterprisePlan: true,
    } as unknown as Plan)

    const result = await applyMonetizationConfig(deps, {
      projectId: PROJECT_ID,
      config: baseConfig(),
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "default_enterprise_conflict", planSlug: "free" })
    expect(store.plans.find(({ slug }) => slug === "free")?.enterprisePlan).toBe(true)
    expect(store.versions).toHaveLength(0)
  })

  it("keeps the billing cadence name when the document restates it as the reset cadence", async () => {
    const { deps, store } = createHarness()

    const config = baseConfig()
    const metered = config.plans[0]?.version.features[1]
    if (!metered) throw new Error("fixture changed")
    // Same cadence as billing, spelled out rather than omitted. Both spellings
    // have to store the cadence the writer derives, not a second name for it.
    metered.resetConfig = { interval: "month", intervalCount: 1 }

    expectApplied(await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config }))

    const stored = store.versions[0]?.planFeatures.find(
      ({ feature }) => feature.slug === "chat-messages"
    )
    expect(stored?.resetConfig).toMatchObject({
      name: "monthly",
      resetInterval: "month",
      resetIntervalCount: 1,
    })
  })

  it("says which plan and feature a write failure came from", async () => {
    const { deps, store, wideEvent } = createHarness()

    const config = baseConfig()
    const plan = config.plans[0]
    const metered = plan?.version.features[1]
    if (!plan || !metered) throw new Error("fixture changed")
    // The boundary validates the reset cadence against a monthly placeholder, so
    // a monthly reset on a daily plan parses clean and only fails at write time.
    plan.version.billingConfig = { name: "daily", interval: "day", intervalCount: 1 }
    metered.resetConfig = { interval: "month", intervalCount: 1 }

    const result = await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      state: "invalid_reset_config",
      planSlug: "free",
      featureSlug: "chat-messages",
    })
    expect(store.versions[0]?.planFeatures.map(({ feature }) => feature.slug)).toEqual(["support"])
    // The failing run is the one worth reading, so it still emits the event.
    expect(wideEvent).toHaveBeenCalledTimes(1)
    expect(wideEvent.mock.calls[0]?.[1]).toMatchObject({
      outcome: "invalid_reset_config",
      stoppedAt: "free",
    })
  })

  it("records per-plan hashes and how each version was obtained", async () => {
    const { deps, store, wideEvent } = createHarness()

    await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    const created = wideEvent.mock.calls[0]?.[1] as Record<string, unknown>

    expect(created).toMatchObject({
      outcome: "ok",
      created: 2,
      resumed: 0,
      unchanged: 0,
      published: 0,
      staleDrafts: 0,
    })
    expect(created.plans).toEqual([
      {
        slug: "free",
        planVersionId: "plan_version_1",
        status: "created",
        configHash: store.versions[0]?.configHash,
      },
      {
        slug: "pro",
        planVersionId: "plan_version_2",
        status: "created",
        configHash: store.versions[1]?.configHash,
      },
    ])

    for (const version of store.versions) {
      version.status = "published"
    }
    await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })

    expect(wideEvent.mock.calls[1]?.[1]).toMatchObject({
      outcome: "ok",
      created: 0,
      resumed: 0,
      unchanged: 0,
      published: 2,
    })
  })
})

describe("resolvePlanDraft", () => {
  it("reuses the newest of two drafts sharing a content address", async () => {
    const harness = createHarness()
    const { context, planRow } = seedDraftContext(harness)
    const plan = parsedFreePlan()
    const configHash = computeConfigHash(plan)

    seedVersion(harness.store, {
      id: "pv_older",
      configHash,
      createdAtM: 1,
      featureSlugs: ["support", "chat-messages"],
    })
    seedVersion(harness.store, {
      id: "pv_newer",
      configHash,
      createdAtM: 2,
      featureSlugs: ["support", "chat-messages"],
    })

    const resolved = await resolvePlanDraft(context, { plan, planRow })

    expect(resolved.err).toBeUndefined()
    expect(resolved.val).toMatchObject({
      state: "ok",
      origin: "unchanged",
      configHash,
      outcome: { slug: "free", planVersionId: "pv_newer", status: "unchanged" },
      staleDrafts: [{ slug: "free", planVersionId: "pv_older" }],
    })
    expect(harness.spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(harness.spies.createPlanVersionFeatureRecord).not.toHaveBeenCalled()
  })

  it("short circuits on a live version without touching it", async () => {
    const harness = createHarness()
    const { context, planRow } = seedDraftContext(harness)
    const plan = parsedFreePlan()
    const configHash = computeConfigHash(plan)

    // Deliberately incomplete: a published version is reported as it stands, not
    // finished, so completeness must not be consulted on this branch.
    seedVersion(harness.store, {
      id: "pv_live",
      configHash,
      createdAtM: 1,
      status: "published",
      featureSlugs: ["support"],
    })

    const resolved = await resolvePlanDraft(context, { plan, planRow })

    expect(resolved.val).toMatchObject({
      state: "ok",
      origin: "published",
      outcome: { planVersionId: "pv_live", status: "published" },
      staleDrafts: [],
    })
    expect(harness.spies.createPlanVersionFeatureRecord).not.toHaveBeenCalled()
    expect(harness.spies.updatePlanVersionRecord).not.toHaveBeenCalled()
    expect(harness.spies.updatePlanVersionFeatureRecord).not.toHaveBeenCalled()
  })

  it("finishes a half-written draft in place and reports it as created", async () => {
    const harness = createHarness()
    const { context, planRow } = seedDraftContext(harness)
    const plan = parsedFreePlan()
    const configHash = computeConfigHash(plan)

    const partial = seedVersion(harness.store, {
      id: "pv_partial",
      configHash,
      createdAtM: 1,
      featureSlugs: ["support"],
    })

    const resolved = await resolvePlanDraft(context, { plan, planRow })

    expect(resolved.val).toMatchObject({
      state: "ok",
      origin: "resumed",
      outcome: { planVersionId: "pv_partial", status: "created" },
      staleDrafts: [],
    })
    expect(harness.spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(partial.planFeatures.map(({ feature }) => feature.slug)).toEqual([
      "support",
      "chat-messages",
    ])
    // Only the missing feature is written, and it continues the existing order.
    expect(harness.spies.createPlanVersionFeatureRecord.mock.calls.map(([input]) => input)).toEqual(
      [expect.objectContaining({ featureId: "feature_chat-messages", order: 2048 })]
    )
  })
})
