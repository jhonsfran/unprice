/**
 * `monetization.apply` against a real database.
 *
 * The unit tests in `use-cases/monetization/apply.test.ts` prove the same
 * decisions against an in-memory harness. What they cannot prove is that the
 * decisions survive Postgres, because the mechanism they exercise is a Drizzle
 * relational query and a `configHash` column:
 *
 * - the superseded-draft query filters `isNotNull(configHash)` *and*
 *   `ne(configHash, hash)`. In SQL a comparison against NULL is NULL, not true,
 *   so the two predicates overlap in a way a JavaScript `!==` fake does not
 *   reproduce in either direction;
 * - nothing here runs inside one transaction, which is the whole reason a
 *   half-materialized draft is a resumable progress record rather than a
 *   rollback. Only a real connection can show that the partial write committed;
 * - `publishPlanVersion` flips a real enum column, and the draft/published pair
 *   has to coexist on one plan afterwards.
 *
 * Everything runs in `proj_test` against the sandbox payment provider seeded by
 * `base-project.sql`. No customer, subscription, usage, or payment is created.
 */
import type { Analytics } from "@unprice/analytics"
import * as schema from "@unprice/db/schema"
import type { MonetizationConfigInput } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../../cache"
import { type ServiceContext, createServiceContext } from "../../context"
import type { Metrics } from "../../metrics"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { applyMonetizationConfig } from "../../use-cases/monetization/apply"
import { publishPlanVersion } from "../../use-cases/plan-version/publish"

const db = createTestDatabaseConnection()

/** Seeds the workspace, project, owner user, and the sandbox provider config. */
const fixtures = ["base-project.sql"]

const projectId = "proj_test"
const userId = "user_test_owner"
const workspaceUnPriceCustomerId = "cus_test_owner"

const CRASH_MESSAGE = "simulated crash mid-materialization"

type PlansService = ServiceContext["plans"]

function createLogger(): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createAnalytics(): Analytics {
  return {
    getUsageBillingFeatures: vi.fn(async () => Ok([])),
    ingestEvents: vi.fn(),
  } as unknown as Analytics
}

function createCache(): Cache {
  return {
    accessControlList: {
      get: vi.fn(async () => Ok(null)),
      remove: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    },
  } as unknown as Cache
}

function createServices(): { logger: Logger; services: ServiceContext } {
  const logger = createLogger()

  return {
    logger,
    services: createServiceContext({
      db,
      logger,
      analytics: createAnalytics(),
      waitUntil: (promise) => {
        void promise
      },
      cache: createCache(),
      metrics: {} as Metrics,
    }),
  }
}

/**
 * The real plan service with one write rigged to throw. `Object.create` keeps
 * every other method — and the instance's own fields — reachable through the
 * prototype chain, so the writes before the crash go through the real service
 * and really commit. That is the point: a fake that buffered them would prove
 * nothing about resumability.
 */
function withFeatureWriteCrash(plans: PlansService, crashOnCall: number): PlansService {
  let calls = 0
  const crashing: PlansService = Object.create(plans)

  crashing.createPlanVersionFeatureRecord = async (input) => {
    calls += 1

    if (calls === crashOnCall) {
      throw new Error(CRASH_MESSAGE)
    }

    return plans.createPlanVersionFeatureRecord(input)
  }

  return crashing
}

/** Feature slugs deliberately unused by `base-project.sql`, so nothing collides. */
function buildConfig({ seatPrice }: { seatPrice: string }): MonetizationConfigInput {
  return {
    events: [{ slug: "token_usage", name: "Token usage" }],
    features: [
      { slug: "seats", title: "Seats", unitOfMeasure: "seat" },
      { slug: "tokens", title: "Tokens", unitOfMeasure: "token" },
    ],
    plans: [
      {
        slug: "starter",
        title: "Starter",
        defaultPlan: true,
        version: {
          currency: "USD",
          paymentProvider: "sandbox",
          billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
          features: [
            { featureSlug: "seats", featureType: "flat", config: { price: "0.00" } },
            {
              featureSlug: "tokens",
              featureType: "usage",
              config: { usageMode: "unit", price: "0.00" },
              meterConfig: {
                eventSlug: "token_usage",
                aggregationMethod: "sum",
                aggregationField: "tokens",
              },
              limit: 1000,
            },
          ],
        },
      },
      {
        slug: "pro",
        title: "Pro",
        defaultPlan: false,
        version: {
          currency: "USD",
          paymentProvider: "sandbox",
          billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
          features: [
            { featureSlug: "seats", featureType: "flat", config: { price: seatPrice } },
            {
              featureSlug: "tokens",
              featureType: "usage",
              config: { usageMode: "unit", price: "0.000002" },
              meterConfig: {
                eventSlug: "token_usage",
                aggregationMethod: "sum",
                aggregationField: "tokens",
              },
              // Omitted `limit` is the single canonical spelling of unlimited.
            },
          ],
        },
      },
    ],
  }
}

async function readPlanVersions(planSlug: string) {
  const plan = await db.query.plans.findFirst({
    where: (row, { and, eq }) => and(eq(row.projectId, projectId), eq(row.slug, planSlug)),
  })

  if (!plan) return []

  return db.query.versions.findMany({
    with: { planFeatures: { with: { feature: true } } },
    where: (row, { and, eq }) => and(eq(row.projectId, projectId), eq(row.planId, plan.id)),
    orderBy: (row, { asc }) => asc(row.createdAtM),
  })
}

/** Reads the decimal price back out of a stored Dinero config without a cast to `any`. */
function storedPrice(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) return undefined
  return (config as { price?: { displayAmount?: string } }).price?.displayAmount
}

describe("monetization apply lifecycle against the database", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("applies to an empty project, no-ops on re-apply, and keeps a published version live across a price change", async () => {
    const { logger, services } = createServices()
    const deps = { services, db, logger }

    // The project is seeded with features and an event but no plans at all.
    expect(await readPlanVersions("starter")).toEqual([])
    expect(await readPlanVersions("pro")).toEqual([])

    // ---- empty-project apply -------------------------------------------------
    const first = await applyMonetizationConfig(deps, {
      projectId,
      config: buildConfig({ seatPrice: "10.00" }),
    })

    expect(first.err).toBeUndefined()
    if (first.val?.state !== "ok") throw new Error(`expected ok, got ${first.val?.state}`)

    expect(first.val.plans).toEqual([
      { slug: "starter", planVersionId: expect.any(String), status: "created" },
      { slug: "pro", planVersionId: expect.any(String), status: "created" },
    ])
    expect(first.val.staleDrafts).toEqual([])

    const proVersionId = first.val.plans[1]?.planVersionId ?? ""
    const starterVersionId = first.val.plans[0]?.planVersionId ?? ""

    const afterFirst = await readPlanVersions("pro")
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]?.status).toBe("draft")
    expect(afterFirst[0]?.configHash).toEqual(expect.any(String))
    expect(
      afterFirst[0]?.planFeatures.map((planFeature) => planFeature.feature.slug).sort()
    ).toEqual(["seats", "tokens"])
    // `limit` omitted means unlimited, which the plan service stores as null.
    expect(
      afterFirst[0]?.planFeatures.find((planFeature) => planFeature.feature.slug === "tokens")
        ?.limit
    ).toBeNull()

    // ---- identical re-apply is a no-op --------------------------------------
    const second = await applyMonetizationConfig(deps, {
      projectId,
      config: buildConfig({ seatPrice: "10.00" }),
    })

    expect(second.err).toBeUndefined()
    if (second.val?.state !== "ok") throw new Error(`expected ok, got ${second.val?.state}`)

    expect(second.val.plans).toEqual([
      { slug: "starter", planVersionId: starterVersionId, status: "unchanged" },
      { slug: "pro", planVersionId: proVersionId, status: "unchanged" },
    ])
    expect(second.val.staleDrafts).toEqual([])

    // No second row, and no duplicated feature rows on the row that was reused.
    const afterSecond = await readPlanVersions("pro")
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]?.id).toBe(proVersionId)
    expect(afterSecond[0]?.planFeatures).toHaveLength(2)

    // ---- publish through publishPlanVersion ---------------------------------
    const published = await publishPlanVersion(
      { services, db, logger, userId },
      { id: proVersionId, projectId, workspaceUnPriceCustomerId }
    )

    expect(published.err).toBeUndefined()
    expect(published.val?.state).toBe("ok")

    const afterPublish = await readPlanVersions("pro")
    expect(afterPublish).toHaveLength(1)
    expect(afterPublish[0]?.status).toBe("published")

    // ---- a price change drafts a new version, the live one is untouched ------
    const third = await applyMonetizationConfig(deps, {
      projectId,
      config: buildConfig({ seatPrice: "12.00" }),
    })

    expect(third.err).toBeUndefined()
    if (third.val?.state !== "ok") throw new Error(`expected ok, got ${third.val?.state}`)

    expect(third.val.plans).toEqual([
      // Starter did not change, so its draft is reused rather than re-drafted.
      { slug: "starter", planVersionId: starterVersionId, status: "unchanged" },
      { slug: "pro", planVersionId: expect.any(String), status: "created" },
    ])

    const repricedVersionId = third.val.plans[1]?.planVersionId ?? ""
    expect(repricedVersionId).not.toBe(proVersionId)

    const afterReprice = await readPlanVersions("pro")
    expect(afterReprice).toHaveLength(2)

    const liveVersion = afterReprice.find((version) => version.id === proVersionId)
    const repricedVersion = afterReprice.find((version) => version.id === repricedVersionId)

    // The published version keeps its status and its original price.
    expect(liveVersion?.status).toBe("published")
    expect(
      storedPrice(liveVersion?.planFeatures.find((pf) => pf.feature.slug === "seats")?.config)
    ).toBe("10.00")

    expect(repricedVersion?.status).toBe("draft")
    expect(
      storedPrice(repricedVersion?.planFeatures.find((pf) => pf.feature.slug === "seats")?.config)
    ).toBe("12.00")

    // ---- staleDrafts reporting ----------------------------------------------
    const fourth = await applyMonetizationConfig(deps, {
      projectId,
      config: buildConfig({ seatPrice: "15.00" }),
    })

    expect(fourth.err).toBeUndefined()
    if (fourth.val?.state !== "ok") throw new Error(`expected ok, got ${fourth.val?.state}`)

    // The 12.00 draft was made by a now-superseded document. The published
    // version is not stale, and the unchanged starter draft is not stale either.
    expect(fourth.val.staleDrafts).toEqual([{ slug: "pro", planVersionId: repricedVersionId }])

    const afterStale = await readPlanVersions("pro")
    expect(afterStale).toHaveLength(3)

    // Reported, never deleted.
    expect(afterStale.map((version) => version.id)).toContain(repricedVersionId)
    expect(afterStale.find((version) => version.id === repricedVersionId)?.status).toBe("draft")
    expect(afterStale.find((version) => version.id === proVersionId)?.status).toBe("published")

    // ---- a dashboard-authored draft is never this document's to call stale ---
    // It carries no content address. In SQL `configHash <> $1` against NULL is
    // NULL rather than true, so the row cannot match the superseded query even
    // before the isNotNull guard — the two predicates agree here, and a
    // JavaScript `!==` fake would disagree with both and report it as stale.
    const liveRow = afterStale.find((version) => version.id === proVersionId)
    if (!liveRow) throw new Error("expected the published version to still be readable")

    const { planFeatures: _planFeatures, ...liveColumns } = liveRow

    await db.insert(schema.versions).values({
      ...liveColumns,
      id: "pv_dashboard_authored",
      status: "draft",
      configHash: null,
      latest: false,
      publishedAt: null,
      publishedBy: null,
    })

    const fifth = await applyMonetizationConfig(deps, {
      projectId,
      config: buildConfig({ seatPrice: "15.00" }),
    })

    expect(fifth.err).toBeUndefined()
    if (fifth.val?.state !== "ok") throw new Error(`expected ok, got ${fifth.val?.state}`)

    const reportedStale = fifth.val.staleDrafts.map((draft) => draft.planVersionId)
    expect(reportedStale).not.toContain("pv_dashboard_authored")
    // The hashed draft from the 12.00 document is still reported, so the
    // assertion above is an exclusion and not an empty list.
    expect(reportedStale).toContain(repricedVersionId)
  })

  it("resumes a draft left half-materialized by a crash instead of creating a second version", async () => {
    const { logger, services } = createServices()
    const config = buildConfig({ seatPrice: "10.00" })

    // Starter is the first plan in the document and prices two features, so the
    // second feature write is starter's `tokens`.
    const crashingDeps = {
      services: {
        plans: withFeatureWriteCrash(services.plans, 2),
        features: services.features,
        events: services.events,
      },
      db,
      logger,
    }

    await expect(applyMonetizationConfig(crashingDeps, { projectId, config })).rejects.toThrow(
      CRASH_MESSAGE
    )

    // The crash committed a draft carrying only the feature written before it.
    const afterCrash = await readPlanVersions("starter")
    expect(afterCrash).toHaveLength(1)
    expect(afterCrash[0]?.status).toBe("draft")
    expect(afterCrash[0]?.planFeatures.map((planFeature) => planFeature.feature.slug)).toEqual([
      "seats",
    ])

    const partialVersionId = afterCrash[0]?.id

    // ---- the next apply finishes it in place --------------------------------
    const resumed = await applyMonetizationConfig({ services, db, logger }, { projectId, config })

    expect(resumed.err).toBeUndefined()
    if (resumed.val?.state !== "ok") throw new Error(`expected ok, got ${resumed.val?.state}`)

    // Same version id, and "created" because this apply is what finished it.
    expect(resumed.val.plans[0]).toEqual({
      slug: "starter",
      planVersionId: partialVersionId,
      status: "created",
    })
    expect(resumed.val.staleDrafts).toEqual([])

    const afterResume = await readPlanVersions("starter")

    // No second version was minted for the same content address.
    expect(afterResume).toHaveLength(1)
    expect(afterResume[0]?.id).toBe(partialVersionId)

    // The missing feature was written exactly once across both runs, and the one
    // written before the crash was not written a second time.
    const writtenSlugs = afterResume[0]?.planFeatures.map((pf) => pf.feature.slug) ?? []
    expect(writtenSlugs.filter((slug) => slug === "tokens")).toEqual(["tokens"])
    expect(writtenSlugs.filter((slug) => slug === "seats")).toEqual(["seats"])
    expect(writtenSlugs).toHaveLength(2)
  })
})
