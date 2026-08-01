import type { Database } from "@unprice/db"
import * as dbSchema from "@unprice/db/schema"
import type {
  Event,
  Feature,
  MonetizationConfigInput,
  Plan,
  PlanVersion,
  PlanVersionFeature,
} from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { type ApplyMonetizationConfigOutput, applyMonetizationConfig } from "./apply"

const PROJECT_ID = "proj_123"

type CreatePlanVersionInput = Parameters<ServiceContext["plans"]["createPlanVersionRecord"]>[0]
type CreatePlanVersionFeatureInput = Parameters<
  ServiceContext["plans"]["createPlanVersionFeatureRecord"]
>[0]
type UpdatePlanVersionFeatureInput = Parameters<
  ServiceContext["plans"]["updatePlanVersionFeatureRecord"]
>[0]
type UpdatePlanInput = Parameters<ServiceContext["plans"]["updatePlanRecord"]>[0]
type CreateFeatureInput = Parameters<ServiceContext["features"]["createFeatureRecord"]>[0]
type CreateEventInput = Parameters<ServiceContext["events"]["createEvent"]>[0]
type UpdateEventInput = Parameters<ServiceContext["events"]["updateEvent"]>[0]

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

function createLogger(): Logger {
  return {
    set: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
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
        findMany: vi.fn(async (args?: QueryArgs) => runQuery(store.versions, args)),
      },
      plans: {
        findFirst: vi.fn(async (args?: QueryArgs) => runQuery(store.plans, args)[0]),
      },
    },
    insert,
  } as unknown as Database

  const getPlanBySlug = vi.fn(async ({ slug }: { slug: string }) =>
    Ok(store.plans.find((plan) => plan.slug === slug) ?? null)
  )

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

    return Ok({ state: "ok" as const, plan })
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
    return Ok({ state: "ok" as const, planVersion })
  })

  const createPlanVersionFeatureRecord = vi.fn(async (input: CreatePlanVersionFeatureInput) => {
    const failure = control.failFeatureWrite?.(input)
    if (failure) return Err(failure)

    const planVersion = store.versions.find(({ id }) => id === input.planVersionId)
    if (!planVersion) return Ok({ state: "plan_version_not_found" as const })
    if (planVersion.status === "published") return Ok({ state: "plan_version_published" as const })

    const feature = store.features.find(({ id }) => id === input.featureId)
    if (!feature) return Ok({ state: "feature_not_found" as const })

    const planVersionFeature = {
      ...input,
      id: `feature_version_${input.planVersionId}_${feature.slug}`,
      unitOfMeasure: input.unitOfMeasure ?? feature.unitOfMeasure ?? "units",
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

    if (input.unitOfMeasure !== undefined) {
      planVersionFeature.unitOfMeasure = input.unitOfMeasure
    }

    return Ok({ state: "ok" as const, planVersionFeature })
  })

  const getFeatureBySlug = vi.fn(async ({ slug }: { slug: string }) =>
    Ok(store.features.find((feature) => feature.slug === slug) ?? null)
  )

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
    return Ok(feature)
  })

  const listEventsByProject = vi.fn(async () => Ok(store.events))

  const createEvent = vi.fn(async (input: CreateEventInput) => {
    const event = {
      id: `event_${input.slug}`,
      projectId: PROJECT_ID,
      slug: input.slug,
      name: input.name,
      availableProperties: input.availableProperties ?? [],
    } as unknown as Event

    store.events.push(event)
    return Ok(event)
  })

  const updateEvent = vi.fn(async (input: UpdateEventInput) => {
    const event = store.events.find(({ id }) => id === input.id)
    if (!event) return Ok({ state: "not_found" as const })

    if (input.hasAvailableProperties) {
      event.availableProperties = Array.from(
        new Set([...(event.availableProperties ?? []), ...(input.availableProperties ?? [])])
      )
    }

    return Ok({ state: "ok" as const, event })
  })

  const services = {
    plans: {
      getPlanBySlug,
      updatePlanRecord,
      createPlanVersionRecord,
      createPlanVersionFeatureRecord,
      updatePlanVersionFeatureRecord,
    },
    features: { getFeatureBySlug, createFeatureRecord },
    events: { listEventsByProject, createEvent, updateEvent },
  } as unknown as Pick<ServiceContext, "plans" | "features" | "events">

  return {
    store,
    control,
    deps: { services, db, logger: createLogger() },
    spies: {
      insert,
      getPlanBySlug,
      updatePlanRecord,
      createPlanVersionRecord,
      createPlanVersionFeatureRecord,
      updatePlanVersionFeatureRecord,
      createFeatureRecord,
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

    const resumed = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    // The half-materialized draft is finished in place: two plans, two versions.
    expect(store.versions).toHaveLength(2)
    expect(spies.createPlanVersionRecord).toHaveBeenCalledTimes(2)
    expect(store.versions[0]?.planFeatures.map(({ feature }) => feature.slug)).toEqual([
      "support",
      "chat-messages",
    ])
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
    for (const version of store.versions) {
      version.status = "published"
    }

    spies.createPlanVersionRecord.mockClear()
    spies.createPlanVersionFeatureRecord.mockClear()

    const second = expectApplied(
      await applyMonetizationConfig(deps, { projectId: PROJECT_ID, config: baseConfig() })
    )

    expect(spies.createPlanVersionRecord).not.toHaveBeenCalled()
    expect(spies.createPlanVersionFeatureRecord).not.toHaveBeenCalled()
    expect(store.versions).toHaveLength(2)
    expect(second.plans).toEqual([
      { slug: "free", planVersionId: first.plans[0]?.planVersionId, status: "published" },
      { slug: "pro", planVersionId: first.plans[1]?.planVersionId, status: "published" },
    ])
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

    expect(second.staleDrafts).toEqual([supersededId])
    // The draft that pro still points at is current, not stale.
    expect(second.staleDrafts).not.toContain(first.plans[1]?.planVersionId)
    expect(store.versions.map(({ id }) => id)).toContain(supersededId)
    expect(versionsOfPlan(store, "free")).toHaveLength(2)
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
})
