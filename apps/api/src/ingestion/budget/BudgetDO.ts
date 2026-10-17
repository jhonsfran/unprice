import { DurableObject } from "cloudflare:workers"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import { createDoLogger } from "~/observability"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import { BudgetProcessor } from "./processor"

/** Cloudflare adapter; budget behavior lives in BudgetProcessor and the pure core. */
export class BudgetDO extends DurableObject {
  private readonly db: ReturnType<typeof drizzle<typeof schema>>
  private readonly processor: BudgetProcessor
  /**
   * Settles once the schema exists. Null until the first upsert: a verb on a key that was never
   * upserted must not create storage, or every mistyped key would leave an object behind forever.
   */
  private ready: Promise<void> | null

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.processor = new BudgetProcessor({
      clock: { now: () => Date.now() },
      logger: createDoLogger(this.ctx.id.toString()),
      scheduler: {
        getAlarm: () => this.ctx.storage.getAlarm(),
        setAlarm: (at) => this.ctx.storage.setAlarm(at),
      },
      store: new BudgetSqliteStore(this.db),
    })
    this.ready = this.hasSchema() ? this.prepare() : null
  }

  async execute(request: BudgetRequest): Promise<BudgetReply> {
    if (!this.ready) {
      if (request.type !== "upsert") return { ok: false, rejection: { code: "BUDGET_NOT_FOUND" } }
      this.ready = this.prepare()
    }
    await this.ready
    return this.processor.execute(request)
  }

  override async alarm(): Promise<void> {
    if (!this.ready) return
    await this.ready
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
