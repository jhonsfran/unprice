import { and, eq, sql } from "@unprice/db"
import {
  planVersionFeatures,
  planVersionRateCards,
  rateCardRows,
  rateCards,
  versions,
} from "@unprice/db/schema"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { UnPriceBudgetError } from "../../budgets"
import { MemoryBudgetStore } from "../../budgets/memory-store.fixture"
import type { Cache } from "../../cache"
import { type ServiceContext, createServiceContext } from "../../context"
import type { Metrics } from "../../metrics"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import {
  type BudgetClient,
  type BudgetVerbRequest,
  InProcessPayerBudgetGateway,
  type PayerBudgetSyncCaller,
  type SyncPayerBudgetDeps,
  executeBudgetCommand,
  payerBudgetKey,
  rateCardSource,
  syncPayerBudgetWithRetry,
} from "../../use-cases/budgets"
import { FakeWallet } from "../../use-cases/budgets/fake-wallet.fixture"

const db = createTestDatabaseConnection()

const projectId = "proj_test"
const customerId = "cus_test"
const subscriptionId = "sub_test_monthly_arrear"
const starterPhaseId = "phase_test_monthly_arrear"
const hour = 60 * 60 * 1000
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const jan10 = Date.parse("2026-01-10T00:00:00.000Z")
const jan16 = Date.parse("2026-01-16T00:00:00.000Z")
const jan20 = Date.parse("2026-01-20T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const key = payerBudgetKey(customerId)

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

function createCache(): Cache {
  return {
    accessControlList: {
      get: vi.fn(async () => Ok(null)),
      remove: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    },
  } as unknown as Cache
}

/** The billing services with the payer budget behind a memory store instead of a Durable Object. */
function createHarness() {
  const store = new MemoryBudgetStore()
  const clock = { now: jan10 }
  const sleeps: number[] = []
  const logger = createLogger()
  const budgets: BudgetClient = {
    async execute(_address, request) {
      const result = store.run(request, clock.now)
      if (result.err) return result
      if (!result.val.ok) return Err(new UnPriceBudgetError(result.val.rejection))
      return Ok(result.val.outcome)
    },
    async cacheCards(_address, cards) {
      store.cacheCardsAt(clock.now, ...cards)
    },
  }
  let deps: SyncPayerBudgetDeps | null = null
  const ready = () => {
    if (!deps) throw new Error("harness not ready")
    return deps
  }
  // As the API wires it: the sync runs in process.
  const gateway = new InProcessPayerBudgetGateway(ready)
  const services: ServiceContext = createServiceContext({
    payerBudgets: gateway,
    db,
    logger,
    waitUntil: (promise) => {
      void promise
    },
    cache: createCache(),
    metrics: {} as Metrics,
  })
  deps = {
    db,
    budgets,
    cards: rateCardSource(services.rateCards),
    wallet: new FakeWallet(),
    services: { budgetCatalog: services.budgetCatalog, rateCards: services.rateCards },
    logger,
    waitUntil: () => {},
    now: () => clock.now,
  }
  const run = (request: BudgetVerbRequest) =>
    executeBudgetCommand(ready(), { projectId, key, request })
  const record = (idempotencyKey: string, events: number, occurredAt: number) =>
    run({
      type: "record",
      idempotencyKey,
      occurredAt,
      event: { slug: "completions", properties: { events } },
    })
  const sync = (caller: PayerBudgetSyncCaller) =>
    syncPayerBudgetWithRetry(
      gateway,
      { projectId, customerId },
      {
        caller,
        now: () => clock.now,
        // A retry waits on the budget's clock, and the alarm sweeps what expired meanwhile.
        sleep: async (ms) => {
          sleeps.push(ms)
          clock.now += ms
          store.run({ type: "sweep" }, clock.now)
        },
      }
    )
  return { store, clock, services, logger, record, run, sync, sleeps }
}

/** A EUR card that prices each event at 0.001, assigned to the plan version in EUR. */
async function priceWithCard(planVersionId: string, cardId: string, rate: string) {
  await db.insert(rateCards).values({
    id: cardId,
    projectId,
    name: cardId,
    unit: "money:EUR",
    marginPolicy: { type: "manual" },
  })
  await db.insert(rateCardRows).values({
    id: `rr_${cardId}`,
    projectId,
    rateCardId: cardId,
    featureSlug: "events",
    match: {},
    price: { type: "unit", components: [{ property: "events", rate, per: 1 }] },
    cost: null,
    effectiveFrom: 0,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
  // The seeded plan already prices with its own card; this one replaces it.
  await db
    .insert(planVersionRateCards)
    .values({
      id: `pvrc_${planVersionId}`,
      projectId,
      planVersionId,
      currency: "EUR",
      rateCardId: cardId,
    })
    .onConflictDoUpdate({
      target: [
        planVersionRateCards.projectId,
        planVersionRateCards.planVersionId,
        planVersionRateCards.currency,
      ],
      set: { rateCardId: cardId },
    })
}

/**
 * A second published version of the plan: the same features, a larger allowance, billed and reset
 * on the 1st, so a change mid-month keeps the month.
 */
async function addScaleVersion() {
  const where = (id: string) => and(eq(versions.projectId, projectId), eq(versions.id, id))
  const [starter] = await db.select().from(versions).where(where("pv_test_monthly_arrear"))
  if (!starter) throw new Error("seeded plan version missing")
  const onTheFirst = { ...starter.billingConfig, billingAnchor: 1 }
  await db.insert(versions).values({
    ...starter,
    id: "pv_test_scale",
    version: 2,
    latest: false,
    billingConfig: onTheFirst,
  })
  const features = await db
    .select()
    .from(planVersionFeatures)
    .where(eq(planVersionFeatures.planVersionId, "pv_test_monthly_arrear"))
  await db.insert(planVersionFeatures).values(
    features.map((feature) => ({
      ...feature,
      id: `${feature.id}_scale`,
      planVersionId: "pv_test_scale",
      limit: feature.limit === null ? null : 50_000,
      billingConfig: { ...feature.billingConfig, billingAnchor: 1 },
      resetConfig: feature.resetConfig && { ...feature.resetConfig, resetAnchor: 1 },
      included: feature.meterConfig ? "100" : null,
    }))
  )
}

function statementsOf(store: MemoryBudgetStore) {
  return [...store.statements.values()]
    .sort((a, b) => a.start - b.start)
    .map(({ periodId, start, end, state, events, amount }) => ({
      periodId,
      start,
      end,
      state,
      events,
      amount,
    }))
}

function eventsLimit(store: MemoryBudgetStore, clockMs: number) {
  const result = store.run({ type: "get" }, clockMs)
  if (result.err || !result.val.ok || result.val.outcome.type !== "get") {
    throw new Error("expected the payer budget")
  }
  const { budget } = result.val.outcome
  const limit = budget.balance.limits.find((row) => row.measure.type === "quantity")
  return { budget, limit }
}

/** The usage lines of the subscription's invoices: what each sealed statement billed. */
async function usageLines(services: ServiceContext) {
  const invoices = await db.query.invoices.findMany({
    where: (row, ops) =>
      ops.and(ops.eq(row.projectId, projectId), ops.eq(row.subscriptionId, subscriptionId)),
  })
  const lines = []
  for (const invoice of invoices) {
    const ledger = await services.ledger.getInvoiceLines({
      projectId,
      statementKey: invoice.statementKey,
    })
    if (ledger.err) throw ledger.err
    for (const line of ledger.val) {
      if (line.metadata?.kind !== "usage") continue
      lines.push({
        billingPeriodId: line.metadata.billing_period_id,
        amount: Number(line.amount.toJSON().amount),
        quantity: line.metadata.quantity,
      })
    }
  }
  return lines
}

/** A decimal at the ledger scale, as budget amounts and quantities are held. */
const scaled = (decimal: string) => BigInt(Math.round(Number(decimal) * 1e8))

describe("payer budget sync over Postgres", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({
      db,
      fixtures: [
        "base-project.sql",
        "plan-monthly-arrear.sql",
        "customer-active.sql",
        "subscription-monthly-arrear-active.sql",
      ],
    })
    await priceWithCard("pv_test_monthly_arrear", "rc_test_starter", "0.001")
  })

  it("keeps the period's usage across a mid-period plan change", async () => {
    await addScaleVersion()
    await priceWithCard("pv_test_scale", "rc_test_scale", "0.0005")
    const { store, clock, services, logger, record } = createHarness()

    await services.billing.syncPayerBudget({ projectId, customerId, caller: "request" })
    const recorded = await record("r1", 300, jan10)
    expect(recorded.err).toBeUndefined()
    expect(eventsLimit(store, jan10).limit?.consumed).toBe(scaled("300"))

    const closed = await services.subscriptions.updatePhase({
      input: {
        id: starterPhaseId,
        projectId,
        subscriptionId,
        startAt: jan1,
        endAt: jan16,
        items: [],
      },
      subscriptionId,
      projectId,
      now: jan16,
    } as never)
    expect(closed.err).toBeUndefined()
    const created = await services.subscriptions.createPhase({
      // Phases end inclusively: the next one starts a millisecond later.
      input: { subscriptionId, planVersionId: "pv_test_scale", startAt: jan16 + 1 },
      projectId,
      now: jan16 + 1,
    } as never)
    expect(created.err).toBeUndefined()
    // Period generation truncates the starter period, opens the scale one, and syncs the budget.
    clock.now = jan16 + hour
    const generated = await services.billing.generateBillingPeriods({
      subscriptionId,
      projectId,
      now: clock.now,
    })
    expect(generated.err).toBeUndefined()
    expect(logger.error).not.toHaveBeenCalled()

    const { budget, limit } = eventsLimit(store, clock.now)
    expect(budget.pricing?.cards).toEqual({ base: "rc_test_scale" })
    expect([limit?.amount, limit?.consumed]).toEqual([scaled("50000"), scaled("300")])

    clock.now = jan20
    expect((await record("r2", 200, jan20)).err).toBeUndefined()
    expect(eventsLimit(store, jan20).limit?.consumed).toBe(scaled("500"))
    const scalePeriod = await db.execute<{ id: string }>(sql`
      SELECT id FROM unprice_billing_periods
      WHERE project_id = ${projectId} AND subscription_phase_id = ${created.val?.id}
        AND cycle_start_at_m = ${jan16 + 1}
        AND subscription_item_id IN (
          SELECT id FROM unprice_subscription_items
          WHERE feature_plan_version_id = 'fv_test_arrear_events_scale'
        )
    `)
    const scalePeriodId = scalePeriod.rows[0]?.id
    // Contiguous: the starter phase's last millisecond (jan16) is in its statement.
    expect(statementsOf(store)).toEqual([
      {
        periodId: "events:bp_test_arrear_events_jan",
        start: jan1,
        end: jan16 + 1,
        state: "open",
        events: 1,
        amount: scaled("0.3"),
      },
      {
        periodId: `events:${scalePeriodId}`,
        start: jan16 + 1,
        end: feb1,
        state: "open",
        events: 1,
        // 200 events with 100 included, at the scale card's 0.0005
        amount: scaled("0.05"),
      },
    ])
  })

  it("closes the budget where a canceled subscription ends and cuts its statement there", async () => {
    const { store, clock, services, logger, record } = createHarness()
    await services.billing.syncPayerBudget({ projectId, customerId, caller: "request" })
    expect((await record("r1", 40, jan10)).err).toBeUndefined()

    const canceled = await services.subscriptions.cancelSubscription({
      subscriptionId,
      projectId,
      endAt: jan20,
      now: jan10,
    })
    expect(canceled.err).toBeUndefined()
    expect(eventsLimit(store, jan10).budget.closesAt).toBe(jan20)

    clock.now = jan20 + hour
    const generated = await services.billing.generateBillingPeriods({
      subscriptionId,
      projectId,
      now: clock.now,
    })
    expect(generated.err).toBeUndefined()
    expect(logger.error).not.toHaveBeenCalled()
    expect(statementsOf(store)).toEqual([
      {
        periodId: "events:bp_test_arrear_events_jan",
        start: jan1,
        end: jan20 + 1,
        state: "open",
        events: 1,
        amount: scaled("0.04"),
      },
    ])

    // The invoicing job bills the canceled subscription's last statement once its grace passed.
    expect((await services.ledger.ensureCustomerAccounts(customerId, "EUR")).err).toBeUndefined()
    const invoiced = await services.subscriptions.invoiceSubscription({
      subscriptionId,
      projectId,
      now: clock.now,
    })
    expect(invoiced.err).toBeUndefined()
    expect(await usageLines(services)).toEqual([
      { billingPeriodId: "bp_test_arrear_events_jan", amount: 4_000_000, quantity: 40 },
    ])
    expect(statementsOf(store).map((statement) => statement.state)).toEqual(["completed"])
  })

  it("caps an immediate cancel's last statement on the request and invoices it from the job", async () => {
    const { store, clock, services, logger, record } = createHarness()
    await services.billing.syncPayerBudget({ projectId, customerId, caller: "request" })
    expect((await record("r1", 40, jan10 - hour)).err).toBeUndefined()
    expect((await services.ledger.ensureCustomerAccounts(customerId, "EUR")).err).toBeUndefined()

    // The budget's clock runs a moment past the request that canceled.
    clock.now = jan10 + 1_000
    const canceled = await services.subscriptions.cancelSubscription({
      subscriptionId,
      projectId,
      now: jan10,
    })

    expect(canceled.err).toBeUndefined()
    expect(logger.error).not.toHaveBeenCalled()
    // The request only caps and syncs: nothing is invoiced or sealed yet.
    expect(await usageLines(services)).toEqual([])
    expect(statementsOf(store)).toEqual([
      expect.objectContaining({ end: jan10 + 1, state: "open", amount: scaled("0.04") }),
    ])

    // The invoicing job bills the canceled subscription once the late-usage grace passed.
    clock.now = jan10 + 2 * hour
    const invoiced = await services.subscriptions.invoiceSubscription({
      subscriptionId,
      projectId,
      now: clock.now,
    })

    expect(invoiced.val).toEqual({ status: "canceled" })
    expect(await usageLines(services)).toEqual([
      { billingPeriodId: "bp_test_arrear_events_jan", amount: 4_000_000, quantity: 40 },
    ])
    expect(statementsOf(store)).toEqual([
      expect.objectContaining({ end: jan10 + 1, state: "completed", amount: scaled("0.04") }),
    ])
  })

  it("leaves a pricing change refused by open holds to a job, which waits them out", async () => {
    const { store, clock, services, logger, run, sync, sleeps } = createHarness()
    expect((await sync("request")).val?.status).toBe("synced")
    const hold = await run({
      type: "authorize",
      idempotencyKey: "job-1",
      ttlMs: 60_000,
      event: { slug: "completions", properties: { events: 10 } },
    })
    expect(hold.err).toBeUndefined()

    // The plan version moves to another card: a pricing change while the hold is open.
    await db.insert(rateCards).values({
      id: "rc_test_repriced",
      projectId,
      name: "rc_test_repriced",
      unit: "money:EUR",
      marginPolicy: { type: "manual" },
    })
    await db.insert(rateCardRows).values({
      id: "rr_rc_test_repriced",
      projectId,
      rateCardId: "rc_test_repriced",
      featureSlug: "events",
      match: {},
      price: { type: "unit", components: [{ property: "events", rate: "0.002", per: 1 }] },
      cost: null,
      effectiveFrom: 0,
      effectiveTo: null,
      source: "manual",
      sourceRef: null,
    })
    await db
      .update(planVersionRateCards)
      .set({ rateCardId: "rc_test_repriced" })
      .where(eq(planVersionRateCards.planVersionId, "pv_test_monthly_arrear"))

    // A request syncs once and never waits: the budget keeps its pricing, and billing warns.
    expect((await sync("request")).val).toEqual({ status: "reservations_open", key })
    await services.billing.syncPayerBudget({ projectId, customerId, caller: "request" })
    expect(sleeps).toEqual([])
    expect([
      vi.mocked(logger.error).mock.calls.length,
      vi.mocked(logger.warn).mock.calls.length,
    ]).toEqual([0, 1])
    expect(eventsLimit(store, clock.now).budget.pricing?.cards).toEqual({ base: "rc_test_starter" })

    const synced = await sync("job")
    expect(synced.val?.status).toBe("synced")
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(60_000)
    expect(eventsLimit(store, clock.now).budget.pricing?.cards).toEqual({
      base: "rc_test_repriced",
    })
  })
})
