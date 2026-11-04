import { reset, runInDurableObject } from "cloudflare:test"
import { env as workerEnv } from "cloudflare:workers"
import { upsertBudgetInternalInputSchema } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { BudgetJournalRow } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import type { BudgetCatalogService } from "@unprice/services/budget-catalog"
import { FakeWallet } from "@unprice/services/budgets/fake-wallet"
import { usdCard } from "@unprice/services/pricing/fixtures"
import {
  type MeterPayerUsageDeps,
  type PayerUsageResult,
  checkPayerAccess,
  executeBudgetCommand,
  meterPayerUsage,
} from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { afterEach, describe, expect, it } from "vitest"
import type { Env } from "~/env"
import type { BudgetDO } from "~/ingestion/budget/BudgetDO"
import { BudgetSqliteStore } from "~/ingestion/budget/budget-store"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"
import * as schema from "~/ingestion/budget/db/schema"
import migrations from "~/ingestion/budget/drizzle/migrations"
import { getBudgetStub } from "~/ingestion/do-placement"

// The pool types `env` as its own bindings; the worker reads them as `Env`.
const env = workerEnv as unknown as Env
const DAY = 24 * 60 * 60 * 1000
const PROJECT_ID = "proj_1"

afterEach(async () => {
  await reset()
})

/**
 * A payer budget compiled as billing's sync leaves it, through the real Durable Object: `images`
 * priced by the usd card under a hard limit of 2 a month, and one statement around the clock.
 */
async function payer() {
  const customerId = `cus_${crypto.randomUUID().slice(0, 8)}`
  const key = `unprice:customer:${customerId}`
  const journaled: BudgetJournalRow[] = []
  const pending: Promise<unknown>[] = []
  const deps: MeterPayerUsageDeps = {
    budgets: new CloudflareBudgetClient(env),
    cards: { read: async () => Ok([usdCard]) },
    wallet: new FakeWallet(),
    services: { budgetCatalog: { record: async () => {} } as unknown as BudgetCatalogService },
    logger: { error: () => {}, warn: () => {} } as unknown as Logger,
    waitUntil: (promise) => void pending.push(promise),
    journal: { send: async (rows) => void journaled.push(...rows) },
  }
  // `cacheCards` stores nothing for a key without a budget, so the first upsert finds its card here.
  await runInDurableObject(
    getBudgetStub(env, { projectId: PROJECT_ID, key }),
    async (_instance: BudgetDO, state) => {
      const db = drizzle(state.storage, { schema, logger: false })
      await migrate(db, migrations)
      new BudgetSqliteStore(db).atomically((tx) => tx.cacheCards([usdCard], Date.now()))
    }
  )
  const { unit, config } = upsertBudgetInternalInputSchema.parse({
    key,
    unit: "USD",
    limits: [{ feature: "images", amount: "2", window: "month" }],
    pricing: {
      cards: { base: usdCard.card.id },
      features: [
        {
          slug: "images",
          eventSlug: "image.generated",
          dimensions: ["size"],
          meterProperty: null,
          included: null,
          priced: true,
        },
      ],
      statements: "required",
      funding: { mode: "postpaid" },
    },
  })
  const address = { projectId: PROJECT_ID, key }
  const created = await executeBudgetCommand(deps, {
    ...address,
    request: { type: "upsert", unit, config, mayLoosen: true, setsPricing: true },
  })
  if (created.err) throw created.err
  const now = Date.now()
  const registered = await executeBudgetCommand(deps, {
    ...address,
    request: {
      type: "registerStatements",
      statements: [
        {
          periodId: "images:bp_current",
          statementKey: "inv_current",
          featureSlug: "images",
          start: now - DAY,
          end: now + 30 * DAY,
        },
      ],
    },
  })
  if (registered.err) throw registered.err

  const charged = (idempotencyKey: string, size: string) => ({
    projectId: PROJECT_ID,
    customerId,
    idempotencyKey,
    eventSlug: "image.generated",
    properties: { size },
  })
  const recorded = (idempotencyKey: string, size: string, occurredAt: number) => ({
    ...charged(idempotencyKey, size),
    occurredAt,
  })
  return {
    deps,
    customerId,
    charged,
    recorded,
    journaled,
    flush: () => Promise.all(pending.splice(0)),
  }
}

/** The budget's answer to each event: ok, the rejection, or UNAVAILABLE when never reached. */
const decided = (answer: PayerUsageResult) =>
  "unavailable" in answer ? "UNAVAILABLE" : answer.result

describe("usage through the payer budget's Durable Object", () => {
  it("records, replays, and refuses events, and journals each refusal", async () => {
    const { deps, recorded, journaled, flush } = await payer()
    const now = Date.now()

    const results = await meterPayerUsage(deps, {
      verb: "record",
      receivedAt: now,
      events: [
        recorded("e1", "1024", now - 1_000),
        recorded("e1", "1024", now - 1_000),
        recorded("e2", "2048", now - 1_000),
        recorded("e3", "1024", now - 2 * DAY),
      ],
    })
    await flush()

    expect(
      results.map((answer) => {
        const result = decided(answer)
        if (result === "UNAVAILABLE") return result
        return result.err ? result.err.code : [result.val.usage.amount, result.val.replayed]
      })
    ).toEqual([[BigInt(4_000_000), false], [BigInt(4_000_000), true], "NOT_PRICED", "TOO_LATE"])
    expect(journaled.map((row) => [row.operation_id, row.status, row.seq])).toEqual([
      ["r:e2", "rejected", 0],
      ["r:e3", "rejected", 0],
    ])
  })

  it("charges until the quantity limit, then denies, and the access check sees it", async () => {
    const { deps, customerId, charged } = await payer()
    const check = () =>
      checkPayerAccess(
        {
          budgets: deps.budgets,
          entitlements: { getCustomerEntitlementsForCustomer: async () => Ok([]) },
        },
        { projectId: PROJECT_ID, customerId, featureSlug: "images", now: Date.now() }
      )

    const results = await meterPayerUsage(deps, {
      verb: "charge",
      receivedAt: Date.now(),
      events: ["c1", "c2", "c3"].map((key) => charged(key, "512")),
    })

    expect(
      results.map((answer) => {
        const result = decided(answer)
        return result === "UNAVAILABLE" ? result : (result.err?.code ?? "ok")
      })
    ).toEqual(["ok", "ok", "LIMIT_EXCEEDED"])
    expect((await check()).val).toMatchObject({
      allowed: false,
      rejectionReason: "LIMIT_EXCEEDED",
      metered: true,
      usage: 2,
      limit: 2,
    })
  })
})
