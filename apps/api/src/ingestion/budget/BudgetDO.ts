import { DurableObject } from "cloudflare:workers"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import { reportsPlacement } from "~/middleware/placement-timing"
import { createDoLogger } from "~/observability"
import { BudgetSqliteStore } from "./budget-store"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import { BudgetProcessor } from "./processor"

/** Where the object ran and whether this request woke it; reported outside production only. */
export type BudgetPlacement = Readonly<{ colo: string; cold: boolean }>

/** Cloudflare adapter; budget behavior lives in BudgetProcessor and the pure core. */
export class BudgetDO extends DurableObject {
  private readonly db: ReturnType<typeof drizzle<typeof schema>>
  private readonly processor: BudgetProcessor
  /**
   * Settles once the schema exists. Null until the first upsert: a verb on a key that was never
   * upserted must not create storage, or every mistyped key would leave an object behind forever.
   * Null again once a closed budget deleted its storage.
   */
  private ready: Promise<void> | null
  /** This object's colo: `unknown` until the trace answers, `local` off preview, null in production. */
  private colo: string | null = null
  /** Set by the first request or alarm on this instance: that one woke it. */
  private woken = false

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.processor = new BudgetProcessor({
      clock: { now: () => Date.now() },
      logger: createDoLogger(this.ctx.id.toString()),
      runtime: {
        // Nothing interleaves: the next request finds no schema, as for a key never upserted.
        destroy: () =>
          this.ctx.blockConcurrencyWhile(async () => {
            await this.ctx.storage.deleteAlarm()
            await this.ctx.storage.deleteAll()
            this.ready = null
          }),
      },
      scheduler: {
        getAlarm: () => this.ctx.storage.getAlarm(),
        setAlarm: (at) => this.ctx.storage.setAlarm(at),
      },
      store: new BudgetSqliteStore(this.db),
    })
    this.ready = this.hasSchema() ? this.prepare() : null
    if (reportsPlacement(env.APP_ENV)) this.traceColo(env.APP_ENV)
  }

  async execute(request: BudgetRequest): Promise<BudgetReply & { placement?: BudgetPlacement }> {
    const cold = !this.woken
    this.woken = true
    const reply = await this.run(request)
    return this.colo === null ? reply : { ...reply, placement: { colo: this.colo, cold } }
  }

  override async alarm(): Promise<void> {
    this.woken = true
    if (!this.ready) return
    await this.ready
    return this.processor.alarm()
  }

  private async run(request: BudgetRequest): Promise<BudgetReply> {
    if (!this.ready) {
      if (request.type !== "upsert") return { ok: false, rejection: { code: "BUDGET_NOT_FOUND" } }
      this.ready = this.prepare()
    }
    await this.ready
    return this.processor.execute(request)
  }

  /**
   * Never awaited: a request reports `unknown` rather than wait for the colo. Only preview asks
   * Cloudflare, so local runs and tests stay off the network.
   */
  private traceColo(appEnv: string): void {
    if (appEnv !== "preview") {
      this.colo = "local"
      return
    }
    this.colo = "unknown"
    fetch("https://cloudflare.com/cdn-cgi/trace")
      .then((response) => response.text())
      .then((trace) => {
        this.colo = /^colo=(\w+)$/m.exec(trace)?.[1] ?? "unknown"
      })
      .catch(() => undefined)
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
