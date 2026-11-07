import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { createRateCardsFake } from "../../rate-cards/memory.fixture"
import { planPublish } from "../../rate-cards/publish"
import { duplicatePlanVersion } from "./duplicate"

type InsertedValues = Record<string, unknown>

const NOW = Date.parse("2026-11-10T12:00:00.000Z")

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
      slug: "free",
      defaultPlan: true,
    },
    planFeatures: [
      {
        id: "pf_source",
        projectId: "proj_123",
        planVersionId: "pv_source",
        featureId: "feature_123",
        feature: { slug: "base" },
        metadata: { hidden: false },
        createdAtM: 1,
        updatedAtM: 1,
      },
      { id: "pf_seats", featureId: "ft_seats", feature: { slug: "seats" }, metadata: {} },
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
      values: vi.fn((values: InsertedValues | InsertedValues[]) => {
        if (Array.isArray(values)) throw new Error("unexpected batch insert")
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

  const query = { versions: { findFirst: vi.fn().mockResolvedValue(planVersionData) } }
  const db = {
    query,
    transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback({ ...tx, query })),
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

function createDeps(db: Database) {
  const cards = createRateCardsFake()
  const services = {
    features: { listFeaturesByProject: vi.fn(async () => Ok([])) },
    rateCards: cards.rateCards,
  } as unknown as Pick<ServiceContext, "features" | "rateCards">
  return { cards, deps: { db, logger: createLogger(), services } }
}

describe("duplicatePlanVersion", () => {
  it("forks the source's card: its policy and the rows in force, on a card named after the copy", async () => {
    vi.useFakeTimers({ now: NOW })
    try {
      const { db } = createDbMocks(createPlanVersion())
      const { cards, deps } = createDeps(db)
      const source = cards.seedPlanVersionCard("pv_source", "USD", [
        { featureSlug: "base", featureType: "flat", price: "10" },
        {
          featureSlug: "seats",
          featureType: "tier",
          tiers: [{ firstUnit: 1, lastUnit: null, unitPrice: "8", flatPrice: "0" }],
        },
      ])
      const [base, seats] = cards.rows
      if (!base || !seats) throw new Error("fixture")
      // A successor scheduled past now, which ends the base row there; and a row that already ended.
      base.effectiveTo = NOW + 60_000
      cards.rows.push(
        { ...base, id: "rr_base_next", effectiveFrom: NOW + 60_000, effectiveTo: null },
        { ...seats, id: "rr_seats_old", effectiveFrom: 0, effectiveTo: NOW - 1 }
      )
      cards.published.add("pv_source")

      const result = await duplicatePlanVersion(deps, { id: "pv_source", projectId: "proj_123" })

      if (!result.val || result.val.state !== "ok") throw new Error("expected a duplicate")
      const copyId = result.val.planVersion.id
      const copy = [...cards.cards.values()].find((card) => card.id !== source.id)
      expect(copy).toMatchObject({ name: `free ${copyId} USD`, unit: "money:USD" })
      expect(cards.assignments.get(`${copyId}:USD`)).toBe(copy?.id)
      expect(
        cards.rows
          .filter((row) => row.rateCardId === copy?.id)
          .map(({ featureSlug, price, effectiveFrom, effectiveTo, source: rowSource }) => ({
            featureSlug,
            price,
            effectiveFrom,
            effectiveTo,
            source: rowSource,
          }))
      ).toEqual([
        {
          featureSlug: "base",
          price: base.price,
          effectiveFrom: NOW,
          effectiveTo: null,
          source: "manual",
        },
        {
          featureSlug: "seats",
          price: seats.price,
          effectiveFrom: NOW,
          effectiveTo: null,
          source: "manual",
        },
      ])
      expect(copyId).not.toBe("pv_source")
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a copy of a version without a card unpriced", async () => {
    const { db } = createDbMocks(createPlanVersion())
    const { cards, deps } = createDeps(db)

    const result = await duplicatePlanVersion(deps, { id: "pv_source", projectId: "proj_123" })

    expect(result.val?.state).toBe("ok")
    expect(cards.cards.size).toBe(0)
    expect(cards.rateCards.assignToPlanVersion).not.toHaveBeenCalled()
  })

  it("duplicates default plan versions without preserving a stale payment method requirement", async () => {
    const { db, inserted } = createDbMocks(createPlanVersion())

    const result = await duplicatePlanVersion(createDeps(db).deps, {
      id: "pv_source",
      projectId: "proj_123",
    })

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
      // The source was published; the copy was not, so its card is not live.
      publishedAt: null,
      publishedBy: null,
      archived: false,
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
          slug: "paid",
          defaultPlan: false,
        },
      })
    )

    const result = await duplicatePlanVersion(createDeps(db).deps, {
      id: "pv_source",
      projectId: "proj_123",
    })

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

it("copies only the features carried by the source version from a shared card", async () => {
  const source = createPlanVersion({
    planFeatures: [
      { id: "pf_base", featureId: "ft_base", feature: { slug: "base" }, metadata: {} },
    ],
  })
  const { db } = createDbMocks(source)
  const { cards, deps } = createDeps(db)
  const original = cards.seedPlanVersionCard("pv_source", "USD", [
    { featureSlug: "base", featureType: "flat", price: "10" },
    { featureSlug: "other_version_feature", featureType: "flat", price: "20" },
  ])
  deps.services.rateCards.featuresPricingWith = vi.fn(async () => ({
    features: [{ slug: "base", dimensions: [], meterProperty: null, included: null }],
    unpriceable: [],
  }))
  cards.rateCards.publishRows.mockImplementation(async (request) => {
    const card = cards.cards.get(request.cardId)
    if (!card) throw new Error("fixture")
    const planned = planPublish({
      ...request,
      card,
      rows: [],
      noticeMs: 0,
      newRowId: () => "rr_regression",
    })
    return planned.err
      ? Err(planned.err)
      : Ok({
          inserted: [...planned.val.inserts],
          closed: [...planned.val.closes],
          unchanged: planned.val.unchanged,
        })
  })
  const result = await duplicatePlanVersion(deps, { id: "pv_source", projectId: "proj_123" })
  expect(result.err).toBeUndefined()
  expect(result.val?.state).toBe("ok")
  const publish = cards.rateCards.publishRows.mock.calls[0]?.[0]
  expect(publish?.drafts.map((row) => row.featureSlug)).toEqual(["base"])
  expect(publish?.cardId).not.toBe(original.id)
})
