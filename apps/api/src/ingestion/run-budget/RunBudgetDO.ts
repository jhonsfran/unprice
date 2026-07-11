import { DurableObject } from "cloudflare:workers"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import { createDoLogger } from "~/observability"
import { serializeRunBudgetApply } from "./apply-serialization"
import type {
  ApplyRunSyncEventInput,
  EndRunInput,
  FlushRunBudgetCapturesForInvoicingInput,
  FlushRunBudgetCapturesForInvoicingResult,
  GetRunStatusInput,
  RunBudgetDecision,
  RunBudgetSummary,
  StartRunInput,
} from "./contracts"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import type { RunBudgetWalletOps } from "./ports"
import { createRunBudgetPricingDelegate } from "./pricing-adapter"
import { RunBudgetProcessor } from "./processor"
import { RunBudgetStore } from "./run-budget-store"

/** Cloudflare adapter; run-budget behavior lives in RunBudgetProcessor. */
export class RunBudgetDO extends DurableObject {
  private readonly processor: RunBudgetProcessor
  private readonly ready: Promise<void>
  private readonly runtimeEnv: Env

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)
    this.runtimeEnv = env

    const db = drizzle(this.ctx.storage, { schema, logger: false })
    const logger = createDoLogger(this.ctx.id.toString())
    this.processor = new RunBudgetProcessor({
      clock: { now: () => Date.now() },
      logger,
      pricing: createRunBudgetPricingDelegate(env),
      scheduler: {
        getAlarm: () => this.ctx.storage.getAlarm(),
        setAlarm: (at) => this.ctx.storage.setAlarm(at),
      },
      store: new RunBudgetStore(db),
      wallet: { create: () => this.createWalletOps() },
    })
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations)
    })
  }

  async startRun(input: StartRunInput): Promise<RunBudgetSummary> {
    await this.ready
    return this.processor.startRun(input)
  }

  async applySyncEvent(input: ApplyRunSyncEventInput): Promise<RunBudgetDecision> {
    await this.ready
    return serializeRunBudgetApply(this.ctx, () => this.processor.applySyncEvent(input))
  }

  async endRun(input: EndRunInput): Promise<RunBudgetSummary> {
    await this.ready
    return this.processor.endRun(input)
  }

  async getRunStatus(input: GetRunStatusInput): Promise<RunBudgetSummary> {
    await this.ready
    return this.processor.getRunStatus(input)
  }

  async flushCaptures(): Promise<void> {
    await this.ready
    return this.processor.flushCaptures()
  }

  async flushCapturesForInvoicing(
    input: FlushRunBudgetCapturesForInvoicingInput
  ): Promise<FlushRunBudgetCapturesForInvoicingResult> {
    await this.ready
    return this.processor.flushCapturesForInvoicing(input)
  }

  override async alarm(): Promise<void> {
    await this.ready
    return this.processor.alarm()
  }

  private async createWalletOps(): Promise<RunBudgetWalletOps> {
    const [{ createConnection }, { LedgerGateway }, { WalletService }] = await Promise.all([
      import("@unprice/db"),
      import("@unprice/services/ledger"),
      import("@unprice/services/wallet"),
    ])
    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: false,
      singleton: false,
    })
    const logger = createDoLogger(this.ctx.id.toString())
    const ledgerGateway = new LedgerGateway({ db, logger })
    return new WalletService({ db, logger, ledgerGateway })
  }
}
