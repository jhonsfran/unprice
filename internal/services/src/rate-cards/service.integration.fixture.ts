import { eq } from "@unprice/db"
import {
  features as featuresTable,
  planVersionFeatures as planVersionFeaturesTable,
  versions as versionsTable,
} from "@unprice/db/schema"
import {
  type MeterConfig,
  type RateRow,
  type RateRowDraft,
  createRateCardInputSchema,
  rateRowDraftSchema,
} from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { formatAmount } from "@unprice/money"
import { afterAll, beforeEach, vi } from "vitest"
import type { Cache } from "../cache/service"
import { FeatureService } from "../features/service"
import { NoopMetrics } from "../metrics/noop"
import { PlanService } from "../plans/service"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { publishRateRows } from "../use-cases/rate-cards"
import { RateCardService } from "./service"

export const projectId = "proj_test"
export const NOW = Date.parse("2026-11-10T12:00:00.000Z")
export const MINUTE = 60_000

export async function value<T>(result: Promise<{ val?: T; err?: Error }>): Promise<T> {
  const { val, err } = await result
  if (err) throw err
  return val as T
}

export async function rejection(result: Promise<{ err?: Error & { rejection?: unknown } }>) {
  const { err } = await result
  return err?.rejection
}

export function gpt41(input: string, output: string): RateRowDraft {
  return rateRowDraftSchema.parse({
    featureSlug: "llm_tokens",
    match: { model: "gpt-4.1" },
    price: {
      type: "unit",
      components: [
        { property: "input_tokens", rate: input, per: 1_000_000 },
        { property: "output_tokens", rate: output, per: 1_000_000 },
      ],
    },
    cost: null,
  })
}

/** [from, to, output rate] per row: the shape of a card's price history. */
export function intervals(rows: readonly RateRow[]) {
  return rows.map((row) => [
    row.effectiveFrom - NOW,
    row.effectiveTo === null ? null : row.effectiveTo - NOW,
    row.price.type === "unit" ? row.price.components.map((c) => formatAmount(c.rate)) : [],
  ])
}

export const LIVE_VERSION = "pv_test_monthly_arrear"
const MONTHLY = {
  name: "monthly",
  billingInterval: "month",
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} as const
export const TOKENS_METER: MeterConfig = {
  eventId: "evt_tokens",
  eventSlug: "tokens",
  aggregationMethod: "sum",
  aggregationField: "input_tokens",
  groupBy: ["model"],
}

/** A usage feature on the seeded version, metered as given. */
export function planFeature(
  id: string,
  featureId: string,
  meterConfig: MeterConfig,
  order: number
) {
  return {
    id,
    projectId,
    planVersionId: LIVE_VERSION,
    featureId,
    featureType: "usage" as const,
    unitOfMeasure: "unit",
    config: { usageMode: "unit" as const },
    billingConfig: { ...MONTHLY },
    metadata: null,
    order,
    meterConfig,
  }
}

export function createRateCardIntegrationFixture() {
  const db = createTestDatabaseConnection()
  const rateCards = new RateCardService({ db })
  const features = new FeatureService({ db, logger: { error: vi.fn() } as unknown as Logger })
  const logger = {
    set: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger
  const plans = new PlanService({
    db,
    rateCards,
    logger,
    waitUntil: vi.fn(),
    cache: {} as Cache,
    metrics: new NoopMetrics(),
  })
  const services = { rateCards, features, plans }

  async function createCard(marginPolicy: object = { type: "manual" }, name = "Standard") {
    const input = createRateCardInputSchema.parse({
      name,
      unit: "money:USD",
      marginPolicy,
    })
    return value(rateCards.createCard(projectId, input))
  }

  /**
   * A USD card a published version prices with, so every change on it takes the notice. The
   * seeded version turns USD and carries `planFeatures` as its own, since the card is checked
   * against the features of the versions assigned to it.
   */
  async function liveCard(planFeatures: ReturnType<typeof planFeature>[]) {
    await seedTestDb({ db, fixtures: ["plan-monthly-arrear.sql"] })
    await db
      .update(versionsTable)
      .set({ status: "draft", currency: "USD" })
      .where(eq(versionsTable.id, LIVE_VERSION))
    if (planFeatures.length > 0) await db.insert(planVersionFeaturesTable).values(planFeatures)
    const card = await createCard()
    await value(
      rateCards.assignToPlanVersion(projectId, {
        planVersionId: LIVE_VERSION,
        currency: "USD",
        cardId: card.id,
      })
    )
    return card
  }

  function publish(cardId: string, rows: RateRowDraft[], effectiveFrom: number, now = NOW) {
    return publishRateRows({ services }, { projectId, cardId, rows, effectiveFrom, now })
  }

  async function cardRows(cardId: string) {
    return (await value(rateCards.getCard(projectId, cardId))).rows
  }

  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures: ["base-project.sql"] })
    await db.insert(featuresTable).values({
      id: "ft_llm_tokens",
      projectId,
      slug: "llm_tokens",
      title: "LLM tokens",
      meterConfig: {
        eventId: "evt_tokens",
        eventSlug: "tokens",
        aggregationMethod: "sum",
        aggregationField: "input_tokens",
        groupBy: ["model"],
      },
    })
  })

  return {
    db,
    rateCards,
    features,
    plans,
    logger,
    services,
    createCard,
    liveCard,
    publish,
    cardRows,
  }
}
