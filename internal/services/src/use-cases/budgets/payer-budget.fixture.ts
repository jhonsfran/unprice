import { upsertBudgetInternalInputSchema } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { BudgetJournalRow } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import type { BudgetCatalogService } from "../../budget-catalog"
import { UnPriceBudgetError } from "../../budgets"
import { MemoryBudgetStore } from "../../budgets/memory-store.fixture"
import { CARD_FROM, usdCard } from "../../pricing/fixtures"
import type { BudgetAddress, BudgetClient, CardSource } from "./budget-client"
import { payerBudgetKey } from "./compile-payer-budget"
import { executeBudgetCommand } from "./execute-budget-command"
import { FakeWallet } from "./fake-wallet.fixture"
import type { MeterPayerUsageDeps } from "./meter-payer-usage"

export const NOV = CARD_FROM
export const DEC = Date.parse("2026-12-01T00:00:00.000Z")
export const PROJECT_ID = "proj_1"

/** An image event the usd card prices at 0.04 (1024) or 0.018 (512); it has no 2048 row. */
export const image = (size: string) => ({ eventSlug: "image.generated", properties: { size } })

/**
 * Payer budgets in memory, one store per address, priced with the usd card, as billing's compile
 * leaves them: `images` metered and priced, one statement for November, an optional quantity limit,
 * and postpaid or prepaid funding.
 */
export function payerHarness() {
  const stores = new Map<string, MemoryBudgetStore>()
  const clock = { now: NOV + 3_600_000 }
  const storeOf = ({ projectId, key }: BudgetAddress) => {
    const id = `${projectId}/${key}`
    const store = stores.get(id) ?? new MemoryBudgetStore()
    stores.set(id, store)
    return store
  }
  const calls: { address: BudgetAddress; type: string }[] = []
  const budgets: BudgetClient = {
    async execute(address, request) {
      calls.push({ address, type: request.type })
      const result = storeOf(address).run(request, clock.now)
      if (result.err) return result
      if (!result.val.ok) return Err(new UnPriceBudgetError(result.val.rejection))
      return Ok(result.val.outcome)
    },
    async cacheCards(address, cards) {
      storeOf(address).cacheCardsAt(clock.now, ...cards)
    },
  }
  const cards: CardSource = { read: async () => Ok([usdCard]) }
  const wallet = new FakeWallet()
  const pending: Promise<unknown>[] = []
  const journaled: BudgetJournalRow[] = []
  const logged: { level: "warn" | "error"; message: unknown; fields: unknown }[] = []
  const logger = {
    warn: (message: unknown, fields: unknown) => logged.push({ level: "warn", message, fields }),
    error: (message: unknown, fields: unknown) => logged.push({ level: "error", message, fields }),
  } as unknown as Logger
  const deps: MeterPayerUsageDeps = {
    budgets,
    cards,
    wallet,
    services: { budgetCatalog: { record: async () => {} } as unknown as BudgetCatalogService },
    logger,
    waitUntil: (promise) => void pending.push(promise),
    journal: {
      async send(rows) {
        journaled.push(...rows)
      },
    },
  }

  /** Compiles a payer budget for `customerId` the way billing's sync does, straight to the store. */
  async function createPayer(
    customerId: string,
    options: { imagesLimit?: number; prepaid?: boolean } = {}
  ) {
    const key = payerBudgetKey(customerId)
    const { unit, config } = upsertBudgetInternalInputSchema.parse({
      key,
      unit: "USD",
      limits:
        options.imagesLimit === undefined
          ? []
          : [{ feature: "images", amount: String(options.imagesLimit), window: "month" }],
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
        funding: options.prepaid ? { mode: "prepaid", customerId } : { mode: "postpaid" },
      },
    })
    const address = { projectId: PROJECT_ID, key }
    const upserted = await executeBudgetCommand(deps, {
      ...address,
      request: { type: "upsert", unit, config, mayLoosen: true, setsPricing: true },
    })
    if (upserted.err) throw upserted.err
    const registered = await executeBudgetCommand(deps, {
      ...address,
      request: {
        type: "registerStatements",
        statements: [
          {
            periodId: "images:bp_nov",
            statementKey: "inv_nov",
            featureSlug: "images",
            start: NOV,
            end: DEC,
          },
        ],
      },
    })
    if (registered.err) throw registered.err
  }

  const flush = () => Promise.all(pending.splice(0))

  return { deps, budgets, clock, wallet, calls, journaled, logged, createPayer, flush, storeOf }
}
