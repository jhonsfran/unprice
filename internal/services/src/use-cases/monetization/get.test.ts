import type { Database } from "@unprice/db"
import * as dbSchema from "@unprice/db/schema"
import type {
  BillingConfig,
  Event,
  Feature,
  MonetizationConfigInput,
  Plan,
  PlanVersion,
  PlanVersionFeature,
} from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { applyMonetizationConfig } from "./apply"
import {
  type GetMonetizationConfigOutput,
  getMonetizationConfig,
  monetizationConfigDocumentSchema,
} from "./get"

const PROJECT_ID = "proj_123"
const OTHER_PROJECT_ID = "proj_other"

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

const USD = { code: "USD", base: 10, exponent: 2 } as const

const RECURRING_RESET_CONFIG = {
  name: "monthly",
  resetInterval: "month",
  resetIntervalCount: 1,
  resetAnchor: "dayOfCreation",
  planType: "recurring",
} as const

const RECURRING_BILLING_CONFIG: BillingConfig = {
  name: "monthly",
  billingInterval: "month",
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
}

// ---------------------------------------------------------------------------
// A `where` clause evaluator, so the fake database actually filters.
//
// `getMonetizationConfig` scopes all three of its reads to the project in SQL.
// A fake that ignored `where` would return another project's plans and let a
// missing project filter — the one bug that leaks pricing across tenants — pass
// every test in this file.
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
  inArray:
    (column: Column, values: readonly unknown[]): Predicate =>
    (row) =>
      values.includes(row[column.column]),
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
// In-memory project shared by both use cases: `applyMonetizationConfig` writes
// through the service fakes, `getMonetizationConfig` reads back through the
// database fake. The round trip is only meaningful if both see the same rows.
// ---------------------------------------------------------------------------

function createHarness() {
  const store = {
    plans: [] as Plan[],
    features: [] as Feature[],
    events: [] as Event[],
    versions: [] as StoredPlanVersion[],
  }
  let planVersionSequence = 0

  const insert = vi.fn((table: unknown) => ({
    values: (row: Record<string, unknown>) => ({
      returning: async () => {
        if (table !== dbSchema.plans) {
          throw new Error("wrote to a table this flow does not own")
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
        // `get` asks for each version's feature *ids* only, so the fake hands
        // back exactly that. Returning the full rows here would let a regression
        // that reads features straight off the plan query pass, when the real
        // query no longer carries them.
        findMany: vi.fn(async (args?: QueryArgs) =>
          runQuery(store.plans, args).map((plan) => ({
            ...plan,
            versions: store.versions
              .filter((version) => version.planId === plan.id)
              .map((version) => ({
                ...version,
                planFeatures: version.planFeatures.map(({ id }) => ({ id })),
              })),
          }))
        ),
      },
      planVersionFeatures: {
        findMany: vi.fn(async (args?: QueryArgs) =>
          runQuery(
            // A feature row belongs to exactly one version in the database, so
            // the parent's id wins. Tests that clone a version by spreading it
            // carry the original's `planVersionId` on the copied rows, which
            // would otherwise return one row under two versions.
            store.versions.flatMap((version) =>
              version.planFeatures.map((planFeature) => ({
                ...planFeature,
                planVersionId: version.id,
              }))
            ),
            args
          )
        ),
      },
      features: {
        findMany: vi.fn(async (args?: QueryArgs) => runQuery(store.features, args)),
      },
      events: {
        findMany: vi.fn(async (args?: QueryArgs) => runQuery(store.events, args)),
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
      active: true,
      latest: false,
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
    const planVersion = store.versions.find(({ id }) => id === input.planVersionId)
    if (!planVersion) return Ok({ state: "plan_version_not_found" as const })
    if (planVersion.status === "published") return Ok({ state: "plan_version_published" as const })

    const feature = store.features.find(({ id }) => id === input.featureId)
    if (!feature) return Ok({ state: "feature_not_found" as const })

    const planVersionFeature = {
      ...input,
      id: `feature_version_${input.planVersionId}_${feature.slug}`,
      unitOfMeasure: input.unitOfMeasure ?? feature.unitOfMeasure ?? "units",
      // Mirrors `plans/service.ts` exactly, including the `limit === 0 -> null`
      // coercion. That branch is unreachable *through the boundary* now that it
      // rejects a zero limit, and it stays anyway: this fake models the
      // collaborator's behaviour, not the caller's current constraints. The
      // dashboard and direct SQL still reach the real writer, and rows carrying
      // that coercion are exactly the population `unrepresentablePlans` exists
      // to absorb. Narrowing it to today's boundary would stop it catching the
      // thing it was built to catch.
      limit: input.limit === 0 ? null : (input.limit ?? null),
      resetConfig: input.featureType === "usage" ? (input.resetConfig ?? null) : null,
      meterConfig: input.featureType === "usage" ? (input.meterConfig ?? null) : null,
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

  const updateFeatureRecord = vi.fn(
    async (input: { projectId: string; id: string; title?: string; description?: string }) => {
      const feature = store.features.find(({ id }) => id === input.id)
      if (!feature) return Ok({ state: "not_found" as const })

      if (input.title !== undefined) feature.title = input.title
      if (input.description !== undefined) feature.description = input.description

      return Ok({ state: "ok" as const, feature })
    }
  )

  const updatePlanVersionRecord = vi.fn(
    async (input: { projectId: string; id: string; title?: string; description?: string }) => {
      const planVersion = store.versions.find(({ id }) => id === input.id)
      if (!planVersion) return Ok({ state: "not_found" as const })

      if (input.title !== undefined) planVersion.title = input.title
      if (input.description !== undefined) planVersion.description = input.description

      return Ok({ state: "ok" as const, planVersion })
    }
  )

  const createFeatureRecord = vi.fn(async (input: CreateFeatureInput) => {
    const feature = {
      id: `feature_${input.slug}`,
      projectId: PROJECT_ID,
      slug: input.slug,
      title: input.title,
      description: input.description ?? null,
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
      updatePlanVersionRecord,
    },
    features: { getFeatureBySlug, createFeatureRecord, updateFeatureRecord },
    events: { listEventsByProject, createEvent, updateEvent },
  } as unknown as Pick<ServiceContext, "plans" | "features" | "events">

  const logger = createLogger()

  return {
    store,
    applyDeps: { services, db, logger },
    getDeps: { db, logger },
    logger,
    /**
     * Every way this project can be written to. The round trip touches none.
     *
     * `updateFeatureRecord` and `updatePlanVersionRecord` are here because
     * `apply` calls both to reconcile unversioned labels; without them a
     * regression that started writing through either would throw a `TypeError`
     * rather than be caught by the assertion that names them.
     */
    writeSpies: {
      insert,
      updatePlanRecord,
      updatePlanVersionRecord,
      createPlanVersionRecord,
      createPlanVersionFeatureRecord,
      updatePlanVersionFeatureRecord,
      createFeatureRecord,
      updateFeatureRecord,
      createEvent,
      updateEvent,
    },
  }
}

function baseConfig(): MonetizationConfigInput {
  return {
    events: [
      { slug: "chat_request", name: "Chat request" },
      { slug: "storage_snapshot", name: "Storage snapshot", availableProperties: ["gigabytes"] },
    ],
    // Every feature declares a description, so the assertions below do not
    // depend on how `apply` happens to normalize an absent one. The omitted
    // case is covered by the dashboard-authored plan, which is seeded directly.
    features: [
      { slug: "support", title: "Support", description: "Human support", unitOfMeasure: "access" },
      {
        slug: "chat-messages",
        title: "Chat messages",
        description: "Messages exchanged with the assistant",
        unitOfMeasure: "message",
      },
      { slug: "storage", title: "Storage", description: "Stored data", unitOfMeasure: "GB" },
      { slug: "seats", title: "Seats", description: "Team seats", unitOfMeasure: "seats" },
      { slug: "bandwidth", title: "Bandwidth", description: "Data transfer", unitOfMeasure: "GB" },
    ],
    plans: [
      {
        slug: "free",
        title: "Free",
        description: "Free forever",
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
              // A reset cadence that differs from billing: it must survive the
              // round trip verbatim.
              resetConfig: { interval: "day" },
            },
            {
              featureSlug: "storage",
              featureType: "usage",
              config: {
                usageMode: "tier",
                tierMode: "graduated",
                tiers: [
                  { firstUnit: 1, lastUnit: 10, unitPrice: "0.10", flatPrice: "0" },
                  { firstUnit: 11, lastUnit: null, unitPrice: "0.05", flatPrice: "0" },
                ],
              },
              meterConfig: {
                eventSlug: "storage_snapshot",
                aggregationMethod: "max",
                aggregationField: "gigabytes",
              },
              // No `resetConfig` and no `limit`: the reset cadence is stored as a
              // copy of the billing cadence, and `limit` is stored as NULL.
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
            // `package` and `tier` are here so every pricing mode makes the
            // get -> apply trip, not only flat and the two usage modes.
            {
              featureSlug: "seats",
              featureType: "package",
              config: { price: "10.00", units: 5 },
            },
            {
              featureSlug: "bandwidth",
              featureType: "tier",
              config: {
                tierMode: "volume",
                tiers: [
                  { firstUnit: 1, lastUnit: 100, unitPrice: "0.02", flatPrice: "5.00" },
                  { firstUnit: 101, lastUnit: null, unitPrice: "0.01", flatPrice: "0" },
                ],
              },
            },
          ],
        },
      },
    ],
  }
}

/** Narrows to the success branch and fails the test with the real state otherwise. */
function expectRead(
  result: Awaited<ReturnType<typeof getMonetizationConfig>>
): Extract<GetMonetizationConfigOutput, { state: "ok" }> {
  expect(result.err).toBeUndefined()
  if (result.val?.state !== "ok") {
    throw new Error(`expected a successful read, got ${JSON.stringify(result.val)}`)
  }
  return result.val
}

async function seedProject(harness: ReturnType<typeof createHarness>) {
  const applied = await applyMonetizationConfig(harness.applyDeps, {
    projectId: PROJECT_ID,
    config: baseConfig(),
  })
  if (applied.val?.state !== "ok") {
    throw new Error(`seeding failed: ${JSON.stringify(applied.val ?? applied.err)}`)
  }
  for (const spy of Object.values(harness.writeSpies)) spy.mockClear()
  return applied.val
}

function planOf(store: ReturnType<typeof createHarness>["store"], slug: string) {
  const plan = store.plans.find((candidate) => candidate.slug === slug)
  if (!plan) throw new Error(`fixture changed: no plan "${slug}"`)
  return plan
}

function versionOf(store: ReturnType<typeof createHarness>["store"], id: string) {
  const version = store.versions.find((candidate) => candidate.id === id)
  if (!version) throw new Error(`fixture changed: no plan version "${id}"`)
  return version
}

describe("getMonetizationConfig", () => {
  it("returns empty arrays for a project with nothing in it", async () => {
    const { getDeps } = createHarness()

    const read = expectRead(await getMonetizationConfig(getDeps, { projectId: PROJECT_ID }))

    expect(read.config).toEqual({ events: [], features: [], plans: [] })
    expect(read.plans).toEqual([])
    expect(read.unrepresentablePlans).toEqual([])
    expect(read.integrationContract).toBeNull()
  })

  it("reads back everything apply wrote, in the shape apply accepts", async () => {
    const harness = createHarness()
    await seedProject(harness)

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.events).toEqual([
      { slug: "chat_request", name: "Chat request", availableProperties: [] },
      {
        slug: "storage_snapshot",
        name: "Storage snapshot",
        availableProperties: ["gigabytes"],
      },
    ])
    // Title, description, and unit come from the feature row, which is the only
    // thing that owns them.
    expect(read.config.features).toEqual([
      { slug: "bandwidth", title: "Bandwidth", description: "Data transfer", unitOfMeasure: "GB" },
      {
        slug: "chat-messages",
        title: "Chat messages",
        description: "Messages exchanged with the assistant",
        unitOfMeasure: "message",
      },
      { slug: "seats", title: "Seats", description: "Team seats", unitOfMeasure: "seats" },
      { slug: "storage", title: "Storage", description: "Stored data", unitOfMeasure: "GB" },
      { slug: "support", title: "Support", description: "Human support", unitOfMeasure: "access" },
    ])
    // Package and tier survive the projection with exactly the keys their
    // feature type keeps.
    expect(read.config.plans[1]?.version.features).toEqual([
      { featureSlug: "support", featureType: "flat", config: { price: "20.00" } },
      {
        featureSlug: "chat-messages",
        featureType: "usage",
        config: { usageMode: "unit", price: "0.005" },
        meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
        resetConfig: { interval: "month", intervalCount: 1 },
      },
      { featureSlug: "seats", featureType: "package", config: { price: "10.00", units: 5 } },
      {
        featureSlug: "bandwidth",
        featureType: "tier",
        config: {
          tierMode: "volume",
          tiers: [
            { firstUnit: 1, lastUnit: 100, unitPrice: "0.02", flatPrice: "5.00" },
            { firstUnit: 101, lastUnit: null, unitPrice: "0.01", flatPrice: "0" },
          ],
        },
      },
    ])
    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free", "pro"])

    const free = read.config.plans[0]
    expect(free).toMatchObject({
      slug: "free",
      title: "Free",
      description: "Free forever",
      defaultPlan: true,
    })
    expect(free?.version.currency).toBe("USD")
    expect(free?.version.paymentProvider).toBe("stripe")
    expect(free?.version.billingConfig).toEqual({
      name: "monthly",
      interval: "month",
      intervalCount: 1,
    })
    // Feature order follows the stored display order, not the database order.
    expect(free?.version.features.map(({ featureSlug }) => featureSlug)).toEqual([
      "support",
      "chat-messages",
      "storage",
    ])

    expect(free?.version.features[0]).toEqual({
      featureSlug: "support",
      featureType: "flat",
      // Prices cross the boundary as the decimal string they were written with.
      config: { price: "0.00" },
    })
    expect(free?.version.features[1]).toEqual({
      featureSlug: "chat-messages",
      featureType: "usage",
      config: { usageMode: "unit", price: "0.01" },
      meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
      limit: 20,
      resetConfig: { interval: "day", intervalCount: 1 },
    })
    expect(free?.version.features[2]).toEqual({
      featureSlug: "storage",
      featureType: "usage",
      config: {
        usageMode: "tier",
        tierMode: "graduated",
        tiers: [
          { firstUnit: 1, lastUnit: 10, unitPrice: "0.10", flatPrice: "0" },
          { firstUnit: 11, lastUnit: null, unitPrice: "0.05", flatPrice: "0" },
        ],
      },
      meterConfig: {
        eventSlug: "storage_snapshot",
        aggregationMethod: "max",
        aggregationField: "gigabytes",
      },
      // The billing cadence, spelled out. Hashes the same as omitting it.
      resetConfig: { interval: "month", intervalCount: 1 },
    })

    expect(read.integrationContract?.defaultPlan.slug).toBe("free")
  })

  it("never emits limit when the stored allowance is unlimited", async () => {
    const harness = createHarness()
    await seedProject(harness)

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    const storage = read.config.plans[0]?.version.features.find(
      ({ featureSlug }) => featureSlug === "storage"
    )
    expect(storage).toBeDefined()
    // `null` means unlimited in the database and the boundary rejects it
    // outright, so the only legal spelling is an absent key.
    expect(storage && "limit" in storage).toBe(false)
  })

  it("reports the published version and every draft for each plan", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    const freeVersionId = applied.plans[0]?.planVersionId ?? ""
    versionOf(harness.store, freeVersionId).status = "published"
    versionOf(harness.store, freeVersionId).latest = true

    // A second, superseded draft on the same plan.
    harness.store.versions.push({
      ...versionOf(harness.store, freeVersionId),
      id: "plan_version_free_draft",
      status: "draft",
      latest: false,
      configHash: "another-hash",
      createdAtM: 99,
    })

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.plans).toEqual([
      {
        slug: "free",
        publishedVersionId: freeVersionId,
        draftVersionIds: ["plan_version_free_draft"],
      },
      {
        slug: "pro",
        publishedVersionId: null,
        draftVersionIds: [applied.plans[1]?.planVersionId],
      },
    ])
    // The published version is the current configuration, not the newer draft.
    expect(read.integrationContract?.defaultPlan.planVersionId).toBe(freeVersionId)
  })

  it("round-trips through apply without creating a version or writing anything", async () => {
    const harness = createHarness()
    await seedProject(harness)

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    const versionsBefore = harness.store.versions.map(({ id }) => id)

    const reapplied = await applyMonetizationConfig(harness.applyDeps, {
      projectId: PROJECT_ID,
      config: read.config,
    })

    expect(reapplied.err).toBeUndefined()
    if (reapplied.val?.state !== "ok") {
      throw new Error(`re-apply failed: ${JSON.stringify(reapplied.val)}`)
    }

    expect(reapplied.val.plans.map(({ status }) => status)).toEqual(["unchanged", "unchanged"])
    expect(reapplied.val.staleDrafts).toEqual([])
    expect(harness.store.versions.map(({ id }) => id)).toEqual(versionsBefore)

    for (const [name, spy] of Object.entries(harness.writeSpies)) {
      expect(`${name}:${spy.mock.calls.length}`).toBe(`${name}:0`)
    }
  })

  it("round-trips a published configuration as published, still without writing", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    for (const outcome of applied.plans) {
      const version = versionOf(harness.store, outcome.planVersionId)
      version.status = "published"
      version.latest = true
    }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))
    const reapplied = await applyMonetizationConfig(harness.applyDeps, {
      projectId: PROJECT_ID,
      config: read.config,
    })

    if (reapplied.val?.state !== "ok") {
      throw new Error(`re-apply failed: ${JSON.stringify(reapplied.val)}`)
    }
    expect(reapplied.val.plans.map(({ status }) => status)).toEqual(["published", "published"])
    expect(harness.store.versions).toHaveLength(2)

    for (const [name, spy] of Object.entries(harness.writeSpies)) {
      expect(`${name}:${spy.mock.calls.length}`).toBe(`${name}:0`)
    }
  })

  it("round-trips a published plan that does not require a payment method", async () => {
    const harness = createHarness()
    const config = baseConfig()
    const free = config.plans[0]
    if (!free) throw new Error("fixture changed: no free plan")
    ;(
      free.version as typeof free.version & { paymentMethodRequired?: boolean }
    ).paymentMethodRequired = false

    const applied = await applyMonetizationConfig(harness.applyDeps, {
      projectId: PROJECT_ID,
      config,
    })
    if (applied.val?.state !== "ok") {
      throw new Error(`seeding failed: ${JSON.stringify(applied.val ?? applied.err)}`)
    }

    for (const outcome of applied.val.plans) {
      const version = versionOf(harness.store, outcome.planVersionId)
      version.status = "published"
      version.latest = true
    }
    for (const spy of Object.values(harness.writeSpies)) spy.mockClear()

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))
    const readFree = read.config.plans.find(({ slug }) => slug === "free")
    expect(readFree?.version.paymentMethodRequired).toBe(false)

    const reapplied = await applyMonetizationConfig(harness.applyDeps, {
      projectId: PROJECT_ID,
      config: read.config,
    })

    if (reapplied.val?.state !== "ok") {
      throw new Error(`re-apply failed: ${JSON.stringify(reapplied.val)}`)
    }
    expect(reapplied.val.plans.map(({ status }) => status)).toEqual(["published", "published"])
    expect(harness.store.versions).toHaveLength(2)

    for (const [name, spy] of Object.entries(harness.writeSpies)) {
      expect(`${name}:${spy.mock.calls.length}`).toBe(`${name}:0`)
    }
  })

  it("reads only the caller's project", async () => {
    const harness = createHarness()
    await seedProject(harness)

    harness.store.plans.push({
      id: "plan_other",
      projectId: OTHER_PROJECT_ID,
      slug: "other-plan",
      title: "Other",
      description: "",
      active: true,
      defaultPlan: true,
      enterprisePlan: false,
    } as unknown as Plan)
    harness.store.features.push({
      id: "feature_other",
      projectId: OTHER_PROJECT_ID,
      slug: "other-feature",
      title: "Other feature",
      description: null,
      unitOfMeasure: "units",
      meterConfig: null,
    } as unknown as Feature)
    harness.store.events.push({
      id: "event_other",
      projectId: OTHER_PROJECT_ID,
      slug: "other_event",
      name: "Other event",
      availableProperties: [],
    } as unknown as Event)

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free", "pro"])
    expect(read.config.features.map(({ slug }) => slug)).not.toContain("other-feature")
    expect(read.config.events.map(({ slug }) => slug)).not.toContain("other_event")
    expect(read.unrepresentablePlans).toEqual([])
  })

  it("reads a plan authored in the dashboard, with no config hash behind it", async () => {
    const harness = createHarness()

    harness.store.features.push({
      id: "feature_seats",
      projectId: PROJECT_ID,
      slug: "seats",
      title: "Seats",
      description: null,
      unitOfMeasure: "seats",
      meterConfig: null,
    } as unknown as Feature)
    harness.store.plans.push({
      id: "plan_team",
      projectId: PROJECT_ID,
      slug: "team",
      title: "Team",
      description: "",
      active: true,
      defaultPlan: true,
      enterprisePlan: false,
    } as unknown as Plan)
    harness.store.versions.push({
      id: "plan_version_dashboard",
      projectId: PROJECT_ID,
      planId: "plan_team",
      status: "draft",
      active: true,
      latest: false,
      // Authored in the dashboard: no document, so no content address.
      configHash: null,
      currency: "EUR",
      paymentProvider: "stripe",
      billingConfig: RECURRING_BILLING_CONFIG,
      createdAtM: 1,
      planFeatures: [
        {
          id: "feature_version_dashboard_seats",
          projectId: PROJECT_ID,
          planVersionId: "plan_version_dashboard",
          featureId: "feature_seats",
          featureType: "package",
          order: 1024,
          defaultQuantity: 1,
          limit: 5,
          unitOfMeasure: "seats",
          billingConfig: RECURRING_BILLING_CONFIG,
          resetConfig: null,
          meterConfig: null,
          config: {
            price: {
              dinero: { amount: 5000, currency: { code: "EUR", base: 10, exponent: 2 }, scale: 2 },
              displayAmount: "50.00",
            },
            units: 5,
          },
          feature: harness.store.features[0],
        },
      ],
    } as unknown as StoredPlanVersion)

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.unrepresentablePlans).toEqual([])
    expect(read.config.features).toEqual([
      { slug: "seats", title: "Seats", unitOfMeasure: "seats" },
    ])
    expect(read.config.plans[0]?.version).toEqual({
      currency: "EUR",
      paymentProvider: "stripe",
      paymentMethodRequired: true,
      billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
      features: [
        {
          featureSlug: "seats",
          featureType: "package",
          config: { price: "50.00", units: 5 },
          limit: 5,
        },
      ],
    })
    expect(read.plans).toEqual([
      { slug: "team", publishedVersionId: null, draftVersionIds: ["plan_version_dashboard"] },
    ])
  })

  it("strips config keys that do not apply to the feature type", async () => {
    const harness = createHarness()
    await seedProject(harness)

    // A row written before the normalizer existed: a tier feature carrying a
    // price and a usage mode, both of which the server discards on write.
    const version = versionOf(harness.store, "plan_version_2")
    const support = version.planFeatures[0]
    if (!support) throw new Error("fixture changed")
    support.featureType = "tier"
    const usd = USD
    support.config = {
      tierMode: "volume",
      tiers: [
        {
          firstUnit: 1,
          lastUnit: null,
          unitPrice: { dinero: { amount: 100, currency: usd, scale: 2 }, displayAmount: "1.00" },
          flatPrice: { dinero: { amount: 0, currency: usd, scale: 2 }, displayAmount: "0" },
        },
      ],
      price: { dinero: { amount: 2000, currency: usd, scale: 2 }, displayAmount: "20.00" },
      usageMode: "unit",
    } as unknown as PlanVersionFeature["config"]

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    const emitted = read.config.plans[1]?.version.features[0]
    expect(emitted?.featureType).toBe("tier")
    expect(emitted?.config).toEqual({
      tierMode: "volume",
      tiers: [{ firstUnit: 1, lastUnit: null, unitPrice: "1.00", flatPrice: "0" }],
    })
  })

  it("takes plan title and description from the plan row, not the plan version snapshot", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // The plan was renamed after this version was cut. The version keeps the
    // title it was created with; the document must describe the plan as it is.
    const plan = planOf(harness.store, "free")
    plan.title = "Starter"
    plan.description = "Renamed in the dashboard"

    const version = versionOf(harness.store, applied.plans[0]?.planVersionId ?? "")
    expect(version.title).toBe("Free")

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans[0]).toMatchObject({
      slug: "free",
      title: "Starter",
      description: "Renamed in the dashboard",
    })
  })

  it("takes unitOfMeasure from the feature row, not the plan version snapshot", async () => {
    const harness = createHarness()
    await seedProject(harness)

    // The dashboard renamed the unit. A published version legitimately keeps the
    // label it was published with; the feature declaration must not.
    const feature = harness.store.features.find(({ slug }) => slug === "chat-messages")
    if (!feature) throw new Error("fixture changed")
    feature.unitOfMeasure = "messages"

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.features.find(({ slug }) => slug === "chat-messages")?.unitOfMeasure).toBe(
      "messages"
    )
    expect(
      harness.store.versions[0]?.planFeatures.find(
        ({ feature: row }) => row.slug === "chat-messages"
      )?.unitOfMeasure
    ).toBe("message")
  })

  it("excludes a plan whose current version prices nothing", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    versionOf(harness.store, applied.plans[1]?.planVersionId ?? "").planFeatures = []

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free"])
    expect(read.plans.map(({ slug }) => slug)).toEqual(["free"])
    expect(read.unrepresentablePlans).toEqual([
      { slug: "pro", reason: "no_features", message: expect.any(String) },
    ])
  })

  it("excludes a plan whose billing anchor the document cannot express", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // Reachable from the dashboard: monthly plans offer days 1-31 as an anchor.
    versionOf(harness.store, applied.plans[1]?.planVersionId ?? "").billingConfig = {
      ...RECURRING_BILLING_CONFIG,
      billingAnchor: 15,
    }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free"])
    expect(read.unrepresentablePlans).toEqual([
      { slug: "pro", reason: "unsupported_billing_config", message: expect.any(String) },
    ])
  })

  it("excludes a plan that is not a recurring plan version", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // The dashboard offers "Onetime" as a billing interval in production. The
    // document has no field for plan type, so it would round-trip to recurring.
    versionOf(harness.store, applied.plans[1]?.planVersionId ?? "").billingConfig = {
      ...RECURRING_BILLING_CONFIG,
      planType: "onetime",
    }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free"])
    expect(read.unrepresentablePlans).toEqual([
      { slug: "pro", reason: "unsupported_billing_config", message: expect.any(String) },
    ])
    expect(read.unrepresentablePlans[0]?.message).toContain("onetime")
  })

  it("excludes a plan whose usage feature resets on its own anchor", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    const version = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    const metered = version.planFeatures[1]
    if (!metered) throw new Error("fixture changed")
    expect(metered.featureType).toBe("usage")
    metered.resetConfig = {
      ...(metered.resetConfig ?? RECURRING_RESET_CONFIG),
      resetAnchor: 15,
    }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free"])
    expect(read.unrepresentablePlans).toEqual([
      { slug: "pro", reason: "unsupported_billing_config", message: expect.any(String) },
    ])
  })

  it("keeps a plan whose stale reset anchor sits on a feature that is no longer usage", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // The writer preserves the old reset cadence when a feature is converted
    // away from usage, and then ignores it. `toBoundaryFeature` drops it, so
    // excluding the plan over it would hide a describable plan — and if it were
    // the default plan, the whole project with it.
    const version = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    const converted = version.planFeatures[1]
    if (!converted) throw new Error("fixture changed")
    converted.featureType = "flat"
    converted.config = {
      price: { dinero: { amount: 500, currency: USD, scale: 2 }, displayAmount: "5.00" },
    } as unknown as PlanVersionFeature["config"]
    converted.meterConfig = null
    converted.resetConfig = {
      ...(converted.resetConfig ?? RECURRING_RESET_CONFIG),
      resetAnchor: 15,
    }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.unrepresentablePlans).toEqual([])
    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free", "pro"])
    expect(read.config.plans[1]?.version.features[1]).toEqual({
      featureSlug: "chat-messages",
      featureType: "flat",
      config: { price: "5.00" },
    })
  })

  it("excludes a plan whose feature bills on its own cadence", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // The dashboard's per-feature "Feature Billing" select; the document has no
    // place to say a feature bills differently from its plan version.
    const version = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    const overridden = version.planFeatures[1]
    if (!overridden) throw new Error("fixture changed")
    overridden.billingConfig = {
      ...RECURRING_BILLING_CONFIG,
      name: "yearly",
      billingInterval: "year",
    }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free"])
    expect(read.unrepresentablePlans).toEqual([
      { slug: "pro", reason: "unsupported_billing_config", message: expect.any(String) },
    ])
  })

  it("fails when the project has no default plan", async () => {
    const harness = createHarness()
    await seedProject(harness)

    planOf(harness.store, "free").defaultPlan = false

    const result = await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ state: "no_default_plan" })
  })

  it("fails when the default plan itself cannot be expressed", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    versionOf(harness.store, applied.plans[0]?.planVersionId ?? "").planFeatures = []

    const result = await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID })

    expect(result.val).toMatchObject({ state: "no_default_plan" })
    expect(result.val && "message" in result.val ? result.val.message : "").toContain("free")
  })

  it("fails the same way whether or not one describable plan survives", async () => {
    // A project with plans and no expressible default has one answer, not two.
    // Previously "no describable plans at all" short-circuited to an ok result
    // with an empty config, while "one describable plan plus an unrepresentable
    // default" reported no_default_plan — near-identical situations, two states.
    const everyPlanBroken = createHarness()
    const brokenApplied = await seedProject(everyPlanBroken)
    for (const outcome of brokenApplied.plans) {
      versionOf(everyPlanBroken.store, outcome.planVersionId).planFeatures = []
    }

    const onlyDefaultBroken = createHarness()
    const partialApplied = await seedProject(onlyDefaultBroken)
    versionOf(onlyDefaultBroken.store, partialApplied.plans[0]?.planVersionId ?? "").planFeatures =
      []

    const both = await Promise.all([
      getMonetizationConfig(everyPlanBroken.getDeps, { projectId: PROJECT_ID }),
      getMonetizationConfig(onlyDefaultBroken.getDeps, { projectId: PROJECT_ID }),
    ])

    expect(both.map((result) => result.val?.state)).toEqual(["no_default_plan", "no_default_plan"])
  })

  it("fails when two plans claim the default", async () => {
    const harness = createHarness()
    await seedProject(harness)

    planOf(harness.store, "pro").defaultPlan = true

    const result = await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ state: "multiple_default_plans" })
  })

  it("excludes a plan with no versions at all and keeps reading the rest", async () => {
    const harness = createHarness()
    await seedProject(harness)

    harness.store.plans.push({
      id: "plan_empty",
      projectId: PROJECT_ID,
      slug: "empty",
      title: "Empty",
      description: "",
      active: true,
      defaultPlan: false,
      enterprisePlan: false,
    } as unknown as Plan)

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free", "pro"])
    expect(read.unrepresentablePlans).toEqual([
      { slug: "empty", reason: "no_version", message: expect.any(String) },
    ])
  })

  it("writes nothing, and never backfills a content address onto a version without one", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // A version with no content address behind it. Asserting that every version
    // still *has* a hash would pass no matter what this code does, because
    // `apply` wrote one onto all of them — the invariant only bites on a version
    // that starts out null.
    const unhashed = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    unhashed.configHash = null

    await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID })

    for (const [name, spy] of Object.entries(harness.writeSpies)) {
      expect(`${name}:${spy.mock.calls.length}`).toBe(`${name}:0`)
    }
    expect(unhashed.configHash).toBeNull()
  })

  it("re-applying a dashboard-authored plan mints a draft, because apply matches only by hash", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // Exactly what a version authored in the dashboard looks like.
    const dashboardVersion = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    dashboardVersion.configHash = null

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))
    const versionsBefore = harness.store.versions.length

    const reapplied = await applyMonetizationConfig(harness.applyDeps, {
      projectId: PROJECT_ID,
      config: read.config,
    })
    if (reapplied.val?.state !== "ok") {
      throw new Error(`re-apply failed: ${JSON.stringify(reapplied.val)}`)
    }

    // This is the documented cost of never backfilling a hash on read, not a bug.
    expect(reapplied.val.plans.map(({ slug, status }) => [slug, status])).toEqual([
      ["free", "unchanged"],
      ["pro", "created"],
    ])
    expect(harness.store.versions).toHaveLength(versionsBefore + 1)
    // The version that was already content-addressed is still reused untouched.
    expect(dashboardVersion.configHash).toBeNull()
  })

  it("excludes a plan whose stored limit is a zero allowance", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // Not reachable through the boundary any more, but the dashboard and direct
    // SQL still write it, and a zero limit is stored as null by the real writer.
    const version = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    const metered = version.planFeatures[1]
    if (!metered) throw new Error("fixture changed")
    metered.limit = 0

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free"])
    expect(read.unrepresentablePlans).toEqual([
      { slug: "pro", reason: "invalid_version", message: expect.any(String) },
    ])
    // The rejection comes from the boundary itself, carried through verbatim:
    // `planVersionFeatureInsertBaseSchema` coerces and would accept 0, so it is
    // the plan-level parse that catches it.
    expect(read.unrepresentablePlans[0]?.message).toContain("limit cannot be 0")
  })

  it("skips an empty newer draft and reads the newest draft that prices something", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    const older = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    harness.store.versions.push({
      ...older,
      id: "plan_version_pro_empty",
      configHash: "another-hash",
      createdAtM: 999,
      planFeatures: [],
    })

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    // The half-built draft is progress, not a configuration.
    expect(read.config.plans.map(({ slug }) => slug)).toEqual(["free", "pro"])
    expect(read.config.plans[1]?.version.features).toHaveLength(4)
    // It is still reported, newest first, so nothing is hidden.
    expect(read.plans[1]?.draftVersionIds).toEqual(["plan_version_pro_empty", older.id])
  })

  it("drops a stale reset cadence left on a feature that is no longer usage", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // `plans/service.ts` only writes resetConfig when the incoming feature type
    // is usage, so converting a usage feature to flat leaves the old row value
    // behind. The boundary rejects resetConfig on a non-usage feature.
    const version = versionOf(harness.store, applied.plans[1]?.planVersionId ?? "")
    const converted = version.planFeatures[1]
    if (!converted) throw new Error("fixture changed")
    expect(converted.resetConfig).not.toBeNull()
    converted.featureType = "flat"
    converted.config = {
      price: { dinero: { amount: 500, currency: USD, scale: 2 }, displayAmount: "5.00" },
    } as unknown as PlanVersionFeature["config"]
    converted.meterConfig = null

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.unrepresentablePlans).toEqual([])
    expect(read.config.plans[1]?.version.features[1]).toEqual({
      featureSlug: "chat-messages",
      featureType: "flat",
      config: { price: "5.00" },
    })
  })

  it("warns about inert meter fields instead of dropping them silently", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    const version = versionOf(harness.store, applied.plans[0]?.planVersionId ?? "")
    const metered = version.planFeatures[1]
    if (!metered) throw new Error("fixture changed")
    metered.meterConfig = {
      ...metered.meterConfig,
      windowSize: "HOUR",
      groupBy: ["region"],
    } as unknown as PlanVersionFeature["meterConfig"]

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    // The plan is still emitted: the document is silent about these, not wrong.
    expect(read.unrepresentablePlans).toEqual([])
    expect(read.config.plans[0]?.version.features[1]?.meterConfig).toEqual({
      eventSlug: "chat_request",
      aggregationMethod: "count",
    })
    expect(read.warnings).toEqual([
      {
        planSlug: "free",
        featureSlug: "chat-messages",
        code: "meter_fields_dropped",
        message: expect.stringContaining("groupBy, windowSize"),
      },
    ])
    // The message must not tell the reader the warning is safe to skip. Severity
    // lives in the code, where a caller can act on it, and the fact that nothing
    // reads these fields today is context for a human in the skill doc, not
    // permission for an agent to move on.
    expect(read.warnings[0]?.message).not.toContain("behaviour is unchanged")
  })

  it("warns about plan version settings the document cannot carry", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // All dashboard-editable, all money-path: when the customer is first charged
    // and how much wallet credit they are granted every period.
    const version = versionOf(harness.store, applied.plans[0]?.planVersionId ?? "")
    version.trialUnits = 14
    version.whenToBill = "pay_in_arrear"
    version.metadata = { includedCreditAmount: 500_000_000 }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.unrepresentablePlans).toEqual([])
    expect(read.warnings).toEqual([
      {
        planSlug: "free",
        featureSlug: null,
        code: "version_settings_dropped",
        message: expect.stringContaining(
          "whenToBill, trialUnits, metadata.includedCreditAmount (wallet credit granted every billing period)"
        ),
      },
    ])
    // A human deciding whether to approve needs to know the live version is safe.
    expect(read.warnings[0]?.message).toContain("The version you read stays exactly as it is")
  })

  it("separates enforcement-changing feature settings from cosmetic ones", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    const version = versionOf(harness.store, applied.plans[0]?.planVersionId ?? "")
    const metered = version.planFeatures[1]
    if (!metered) throw new Error("fixture changed")
    // A real dashboard row materializes every metadata default, so this also
    // proves the fields sitting at their defaults stay quiet.
    metered.metadata = {
      realtime: false,
      notifyUsageThreshold: 95,
      blockCustomer: false,
      overageStrategy: "always",
      hidden: true,
    }
    metered.defaultQuantity = 5

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.unrepresentablePlans).toEqual([])

    // Two warnings, not one: a caller decides whether to stop by reading the
    // code, so a limit-enforcement bypass must never share a code with a display
    // flag. `overageStrategy: "always"` skips the limit check entirely and
    // `defaultQuantity` is the allowance a subscription starts with.
    const enforcement = read.warnings.find(({ code }) => code === "enforcement_settings_dropped")
    expect(enforcement?.message).toContain("metadata.overageStrategy")
    expect(enforcement?.message).toContain("defaultQuantity")
    expect(enforcement?.message).not.toContain("metadata.hidden")

    const cosmetic = read.warnings.find(({ code }) => code === "feature_settings_dropped")
    expect(cosmetic?.message).toContain("metadata.hidden")
    expect(cosmetic?.message).not.toContain("overageStrategy")
    expect(cosmetic?.message).not.toContain("defaultQuantity")

    expect(read.warnings.map(({ code }) => code).sort()).toEqual([
      "enforcement_settings_dropped",
      "feature_settings_dropped",
    ])
  })

  it("reports an enforcement change alone when nothing cosmetic is set", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    const version = versionOf(harness.store, applied.plans[0]?.planVersionId ?? "")
    const metered = version.planFeatures[1]
    if (!metered) throw new Error("fixture changed")
    metered.defaultQuantity = 5

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.warnings).toEqual([
      {
        planSlug: "free",
        featureSlug: "chat-messages",
        code: "enforcement_settings_dropped",
        message: expect.stringContaining("defaultQuantity"),
      },
    ])
  })

  it("warns about tags and an external id, which the document also cannot carry", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    const version = versionOf(harness.store, applied.plans[0]?.planVersionId ?? "")
    version.tags = ["popular"]
    version.metadata = { externalId: "price_abc123" }

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    const message = read.warnings[0]?.message ?? ""
    expect(read.warnings[0]?.code).toBe("version_settings_dropped")
    expect(message).toContain("metadata.externalId")
    expect(message).toContain("tags")
    // The credit branch is a different key and must not fire for an externalId.
    expect(message).not.toContain("includedCreditAmount")
  })

  it("does not call an absent defaultQuantity an enforcement change", async () => {
    const harness = createHarness()
    const applied = await seedProject(harness)

    // `null` is how the writer spells "ask for the quantity at subscription
    // time" — the document produces the same thing, so there is nothing to warn
    // about. Treating it as a change would raise the one code that stops an
    // agent, on a plan where nothing was lost.
    const version = versionOf(harness.store, applied.plans[0]?.planVersionId ?? "")
    const metered = version.planFeatures[1]
    if (!metered) throw new Error("fixture changed")
    metered.defaultQuantity = null as unknown as PlanVersionFeature["defaultQuantity"]

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.warnings).toEqual([])
  })

  it("reports no warnings for a project apply wrote end to end", async () => {
    const harness = createHarness()
    await seedProject(harness)

    const read = expectRead(await getMonetizationConfig(harness.getDeps, { projectId: PROJECT_ID }))

    expect(read.warnings).toEqual([])
  })
})

describe("monetizationConfigDocumentSchema", () => {
  function document(overrides: (config: MonetizationConfigInput) => void): unknown {
    const config = baseConfig()
    overrides(config)
    return config
  }

  it("accepts a document with no plans at all", () => {
    const parsed = monetizationConfigDocumentSchema.safeParse({
      events: [],
      features: [],
      plans: [],
    })

    expect(parsed.success).toBe(true)
  })

  it("accepts what apply accepts", () => {
    expect(monetizationConfigDocumentSchema.safeParse(baseConfig()).success).toBe(true)
  })

  // The whole point of relaxing only `plans.min(1)`: this schema is exported and
  // is the `config` field of the output, so whatever it advertises is what a
  // caller will believe `apply` accepts.
  it.each([
    [
      "two default plans",
      (config: MonetizationConfigInput) => {
        const pro = config.plans[1]
        if (pro) pro.defaultPlan = true
      },
    ],
    [
      "a duplicate feature slug",
      (config: MonetizationConfigInput) => {
        const first = config.features?.[0]
        if (first) config.features?.push({ ...first })
      },
    ],
    [
      "a plan pricing a feature the document does not declare",
      (config: MonetizationConfigInput) => {
        const priced = config.plans[0]?.version.features[0]
        if (priced) priced.featureSlug = "not-declared"
      },
    ],
    [
      "a duplicate event slug in a plan-less document",
      (config: MonetizationConfigInput) => {
        const first = config.events?.[0]
        if (first) config.events?.push({ ...first })
        config.plans = []
      },
    ],
  ])("rejects %s, exactly as apply does", (_label, mutate) => {
    expect(monetizationConfigDocumentSchema.safeParse(document(mutate)).success).toBe(false)
  })
})
