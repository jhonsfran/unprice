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
  private readonly processor: BudgetProcessor
  private readonly ready: Promise<void>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    const db = drizzle(this.ctx.storage, { schema, logger: false })
    this.processor = new BudgetProcessor({
      clock: { now: () => Date.now() },
      logger: createDoLogger(this.ctx.id.toString()),
      scheduler: {
        getAlarm: () => this.ctx.storage.getAlarm(),
        setAlarm: (at) => this.ctx.storage.setAlarm(at),
      },
      store: new BudgetSqliteStore(db),
    })
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations)
      await this.processor.initialize()
    })
  }

  async execute(request: BudgetRequest): Promise<BudgetReply> {
    await this.ready
    return this.processor.execute(request)
  }

  override async alarm(): Promise<void> {
    await this.ready
    return this.processor.alarm()
  }
}
