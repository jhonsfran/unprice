import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test"
import { env as workerEnv } from "cloudflare:workers"
import { upsertBudgetInternalInputSchema } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { BudgetCatalogService } from "@unprice/services/budget-catalog"
import { UnPriceBudgetError } from "@unprice/services/budgets"
import { FakeWallet } from "@unprice/services/budgets/fake-wallet"
import { CARD_FROM, usdCard } from "@unprice/services/pricing/fixtures"
import {
  type BudgetClient,
  type BudgetVerbRequest,
  executeBudgetCommand,
} from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { afterEach, describe, expect, it } from "vitest"
import type { Env } from "~/env"
import { getBudgetStub } from "~/ingestion/do-placement"
import type { BudgetDO } from "./BudgetDO"
import { BudgetSqliteStore } from "./budget-store"
import { CloudflareBudgetClient } from "./client"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import { discardJournal } from "./journal"
import { BudgetProcessor } from "./processor"

// The pool types `env` as its own bindings; the worker reads them as `Env`.
const env = workerEnv as unknown as Env
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const image = { slug: "image.generated", properties: { size: "1024" } }
const prepaid = { mode: "prepaid" as const, customerId: "cus_acme" }

afterEach(async () => {
  await reset()
})

function definition(funding: typeof prepaid | null) {
  const { unit, config } = upsertBudgetInternalInputSchema.parse({
    key: "unprice:customer:cus_acme",
    unit: "USD",
    limits: [],
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
      ...(funding && { funding }),
    },
  })
  return { type: "upsert" as const, unit, config, mayLoosen: true, setsPricing: true }
}

/** `executeBudgetCommand` against `budgets` with a fake wallet and a card source of one card. */
function harness(budgets: BudgetClient, key: string, balance: bigint) {
  const wallet = new FakeWallet(balance)
  const deps = {
    budgets,
    cards: { read: async () => Ok([usdCard]) },
    wallet,
    services: { budgetCatalog: { record: async () => {} } as unknown as BudgetCatalogService },
    logger: { error: () => {} } as unknown as Logger,
    waitUntil: () => {},
  }
  const execute = <R extends BudgetVerbRequest>(request: R) =>
    executeBudgetCommand(deps, { projectId: "proj_1", key, request })
  return { execute, wallet }
}

/** A payer budget through the real RPC, with one statement around the real clock. */
async function payerOverRpc(funding: typeof prepaid | null, balance: bigint) {
  const key = `unprice:customer:${crypto.randomUUID()}`
  const address = { projectId: "proj_1", key }
  const h = harness(new CloudflareBudgetClient(env), key, balance)
  const stub = getBudgetStub(env, address)
  // `cacheCards` stores nothing for a key without a budget, so the first upsert finds its card here.
  await runInDurableObject(stub, async (_instance: BudgetDO, state) => {
    const db = drizzle(state.storage, { schema, logger: false })
    await migrate(db, migrations)
    new BudgetSqliteStore(db).atomically((tx) => tx.cacheCards([usdCard], Date.now()))
  })
  const created = await h.execute(definition(funding))
  if (created.err) throw created.err
  const now = Date.now()
  const statement = {
    periodId: "images:current",
    statementKey: "inv_current",
    featureSlug: "images",
    start: now - DAY,
    end: now + 30 * DAY,
  }
  const registered = await h.execute({ type: "registerStatements", statements: [statement] })
  if (registered.err) throw registered.err
  return { ...h, stub }
}

function fundingRows(state: DurableObjectState) {
  return state.storage.sql.exec("SELECT statement_key, state FROM budget_funding").toArray()
}

describe("BudgetDO funding over RPC", () => {
  it("replays the same seq after a crash between the intent and the wallet's answer", async () => {
    const { execute, wallet, stub } = await payerOverRpc(prepaid, BigInt(1_000_000_000))
    wallet.failNext = true

    await expect(execute({ type: "charge", idempotencyKey: "c1", event: image })).rejects.toThrow(
      "wallet unavailable"
    )
    await evictDurableObject(stub)
    const charged = await execute({ type: "charge", idempotencyKey: "c1", event: image })

    expect(charged.val?.usage.amount).toBe(BigInt(4_000_000))
    expect(
      wallet.calls.map((call) => [call.kind, call.seq, call.reservationId, call.amount])
    ).toEqual([
      ["reserve", 1, null, BigInt(104_000_000)],
      ["reserve", 1, null, BigInt(104_000_000)],
    ])
    await runInDurableObject(stub, (_instance: BudgetDO, state) => {
      const store = new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false }))
      const [row] = store.atomically((tx) => tx.readFunding(["inv_current"]))
      expect(row).toMatchObject({
        reservationId: "res_1",
        allocated: BigInt(104_000_000),
        consumed: BigInt(4_000_000),
        seq: 1,
        pending: null,
        state: "open",
      })
    })
  })

  it("denies a priced charge with WALLET_EMPTY when the wallet has nothing", async () => {
    const { execute, wallet, stub } = await payerOverRpc(prepaid, BigInt(0))

    const denied = await execute({ type: "charge", idempotencyKey: "c1", event: image })

    expect(denied.err?.rejection).toEqual({
      code: "WALLET_EMPTY",
      statementKey: "inv_current",
      required: BigInt(4_000_000),
      available: BigInt(0),
    })
    expect(wallet.calls).toHaveLength(1)
    await runInDurableObject(stub, (_instance: BudgetDO, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM budget_operations").one()).toEqual({
        n: 0,
      })
    })
  })

  it("never calls the wallet for a postpaid budget", async () => {
    const { execute, wallet, stub } = await payerOverRpc(null, BigInt(0))

    const charged = await execute({ type: "charge", idempotencyKey: "c1", event: image })
    const held = await execute({ type: "authorize", idempotencyKey: "a1", event: image })

    expect([charged.val?.usage.amount, held.val?.reserved.amount]).toEqual([
      BigInt(4_000_000),
      BigInt(4_000_000),
    ])
    expect(wallet.calls).toEqual([])
    await runInDurableObject(stub, (_instance: BudgetDO, state) => {
      expect(fundingRows(state)).toEqual([])
    })
  })
})

describe("BudgetDO funding at statement seal", () => {
  /** Two image charges on a prepaid November statement, sealed in SQLite; `free` marks a trial. */
  async function sealNovember(key: string, free: boolean) {
    const NOV = CARD_FROM
    const DEC = Date.parse("2026-12-01T00:00:00.000Z")
    const stub = getBudgetStub(env, { projectId: "proj_1", key })
    let now = NOV + 3 * DAY
    return runInDurableObject(stub, async (_instance: BudgetDO, state) => {
      await migrate(drizzle(state.storage), migrations)
      const processor = new BudgetProcessor({
        journal: discardJournal,
        clock: { now: () => now },
        logger: { error: () => {} },
        runtime: { destroy: async () => {} },
        scheduler: {
          getAlarm: () => state.storage.getAlarm(),
          setAlarm: (at) => state.storage.setAlarm(at),
        },
        store: new BudgetSqliteStore(drizzle(state.storage, { schema, logger: false })),
      })
      const budgets: BudgetClient = {
        async execute(_address, request) {
          const reply = await processor.execute(request)
          return reply.ok ? Ok(reply.outcome) : Err(new UnPriceBudgetError(reply.rejection))
        },
        async cacheCards(_address, cards) {
          processor.cacheCards(cards)
        },
      }
      const { execute, wallet } = harness(budgets, key, BigInt(1_000_000_000))
      expect((await execute(definition(prepaid))).err).toBeUndefined()
      const period = {
        periodId: "images:nov",
        statementKey: "inv_nov",
        featureSlug: "images",
        start: NOV,
        end: DEC,
        ...(free && { free: true }),
      }
      await execute({ type: "registerStatements", statements: [period] })
      await execute({ type: "charge", idempotencyKey: "c1", event: image })
      await execute({ type: "charge", idempotencyKey: "c2", event: image })

      now = DEC + HOUR
      const sealed = await execute({ type: "sealStatements", statementKey: "inv_nov", at: DEC })
      return {
        statements: sealed.val?.statements.map((s) => [s.state, s.free, s.amount]),
        calls: wallet.calls.map((call) => [call.kind, call.seq, call.amount]),
        reservation: wallet.reservations.get("res_1"),
        balance: wallet.balance,
        rows: fundingRows(state),
      }
    })
  }

  it("captures the statement and releases the reservation when its statement seals", async () => {
    expect(await sealNovember("unprice:customer:cus_seal", false)).toEqual({
      statements: [["sealed", false, BigInt(8_000_000)]],
      calls: [
        ["reserve", 1, BigInt(104_000_000)],
        ["close", 2, BigInt(8_000_000)],
      ],
      reservation: { allocated: BigInt(104_000_000), captured: BigInt(8_000_000), closed: true },
      balance: BigInt(992_000_000),
      rows: [{ statement_key: "inv_nov", state: "closed" }],
    })
  })

  it("prices trial usage without touching the wallet", async () => {
    expect(await sealNovember("unprice:customer:cus_trial", true)).toEqual({
      statements: [["sealed", true, BigInt(8_000_000)]],
      calls: [],
      reservation: undefined,
      balance: BigInt(1_000_000_000),
      rows: [],
    })
  })
})
