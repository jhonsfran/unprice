import { DurableObject } from "cloudflare:workers"
import type { BudgetInspectQuery, BudgetInspectReply } from "@unprice/services/budgets"
import type { CardRows } from "@unprice/services/pricing"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import { createDoLogger } from "~/observability"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import { type BudgetJournal, discardJournal, pipelineJournal } from "./journal"
import { BudgetProcessor } from "./processor"

function creates(request: BudgetRequest): boolean {
  return request.type === "upsert" || ("ifMissing" in request && !!request.ifMissing)
}

/** How long cards cached for a key with no budget wait for the call that creates it. */
const CARDS_ONLY_TTL_MS = 60_000

/** Cloudflare adapter; budget behavior lives in BudgetProcessor and the pure core. */
export class BudgetDO extends DurableObject {
  private readonly db: ReturnType<typeof drizzle<typeof schema>>
  private readonly processor: BudgetProcessor
  /**
   * Settles once the schema exists. Null until the first upsert, or the first verb that carries
   * the budget to create: any other verb on a key that was never upserted must not create storage,
   * or every mistyped key would leave an object behind forever. Null again once a closed budget
   * deleted its storage.
   */
  private ready: Promise<void> | null
  /** The storage holds cards cached for a create that has not happened yet. */
  private cardsOnly = false

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.processor = new BudgetProcessor({
      journal: journalOf(env),
      clock: { now: () => Date.now() },
      logger: createDoLogger(this.ctx.id.toString()),
      runtime: { destroy: () => this.destroy() },
      scheduler: {
        getAlarm: () => this.ctx.storage.getAlarm(),
        setAlarm: (at) => this.ctx.storage.setAlarm(at),
      },
      store: new BudgetSqliteStore(this.db),
    })
    this.ready = this.hasSchema() ? this.prepare() : null
  }

  async execute(request: BudgetRequest): Promise<BudgetReply> {
    // Storage that holds no budget yet: a new key, or one whose cards were cached for its create.
    const fresh = !this.ready || this.cardsOnly
    const wasPrepared = this.ready !== null
    if (!this.ready) {
      if (!creates(request)) return { ok: false, rejection: { code: "BUDGET_NOT_FOUND" } }
      this.ready = this.prepare()
    }
    await this.ready
    const reply = await this.processor.execute(request)
    // A first call that was refused left a schema and no budget: the storage a mistyped key must
    // not keep. Drop it, so the key reads as never upserted again.
    // Cards cached for a create stay until that create is refused or their alarm drops them;
    // another call refused on the key meanwhile leaves them.
    const created = !wasPrepared || creates(request)
    if (fresh && created && !reply.ok && !this.processor.hasBudget()) await this.destroy()
    else if (reply.ok) this.cardsOnly = false
    return reply
  }

  /** Nothing interleaves: the next request finds no schema, as for a key never upserted. */
  private destroy(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.ready = null
      this.cardsOnly = false
    })
  }

  /**
   * Replaces the cached cards. A key with no budget caches them for the call that creates it: a
   * refused create, or an alarm CARDS_ONLY_TTL_MS later with still no budget, drops the storage.
   */
  async cacheCards(cards: CardRows[]): Promise<void> {
    if (!this.ready) {
      this.ready = this.prepare()
      this.cardsOnly = true
      await this.ready
      await this.ctx.storage.setAlarm(Date.now() + CARDS_ONLY_TTL_MS)
    }
    await this.ready
    this.processor.cacheCards(cards)
  }

  /** The dashboard's read beside the verbs. Like a verb, it creates no storage for an unknown key. */
  async inspect(query: BudgetInspectQuery): Promise<BudgetInspectReply> {
    if (!this.ready) return { ok: false, rejection: { code: "BUDGET_NOT_FOUND" } }
    await this.ready
    return this.processor.inspect(query)
  }

  override async alarm(): Promise<void> {
    if (!this.ready) return
    await this.ready
    if (!this.processor.hasBudget()) return this.destroy()
    return this.processor.alarm()
  }

  private prepare(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations)
      await this.processor.initialize()
    })
  }

  private hasSchema(): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
        .toArray().length > 0
    )
  }
}

/**
 * The journal stream when bound. Without one, local development discards rows so purges still
 * run; elsewhere rows wait, unpurged, until the binding exists.
 */
function journalOf(env: Env): BudgetJournal | null {
  if (env.PIPELINE_BUDGET_JOURNAL) return pipelineJournal(env.PIPELINE_BUDGET_JOURNAL)
  return env.APP_ENV === "development" ? discardJournal : null
}
