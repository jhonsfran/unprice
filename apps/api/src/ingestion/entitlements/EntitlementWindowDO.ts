import { DurableObject } from "cloudflare:workers"
import { createConnection } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { LedgerGateway } from "@unprice/services/ledger"
import { WalletService } from "@unprice/services/wallet"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import { createDoLogger, runDoOperation } from "~/observability"
import type {
  ApplyBatchInput,
  ApplyBatchResultRow,
  ApplyInput,
  ApplyResult,
  EnforcementStateInput,
  EnforcementStateResult,
  EntitlementWindowStatus,
  FlushReservationForInvoicingInput,
  FlushReservationForInvoicingResult,
} from "./contracts"
import { schema } from "./db/schema"
import migrations from "./drizzle/migrations"
import { EntitlementWindowStore } from "./entitlement-window-store"
import { EntitlementWindowProcessor } from "./processor"
import { inactivityThresholdMs, maxFlushIntervalMs } from "./utils"

export { entitlementWindowStatusSchema } from "./contracts"
export type { EntitlementWindowStatus } from "./contracts"

/**
 * Cloudflare adapter for one entitlement window. All business orchestration
 * lives in EntitlementWindowProcessor; this class only owns Durable Object
 * construction, SQLite migration/bootstrap, the SQLite store implementation,
 * lazy WalletService wiring, and RPC forwarding. See ./ports.ts for the
 * guarantees a non-Cloudflare backend must reproduce.
 */
export class EntitlementWindowDO extends DurableObject {
  private readonly logger: Logger
  private readonly processor: EntitlementWindowProcessor
  private readonly ready: Promise<void>
  private readonly runtimeEnv: Env
  private readonly store: EntitlementWindowStore
  // Lazily constructed on the first wallet call so a DO that never
  // opens a reservation never opens a Postgres connection.
  private walletService: WalletService | null = null

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    this.runtimeEnv = env

    const requestId = this.ctx.id.toString()
    this.logger = createDoLogger(requestId)
    this.logger.set({
      requestId,
      service: "entitlementwindow",
      request: {
        id: requestId,
      },
      cloud: {
        platform: "cloudflare",
        durable_object_id: requestId,
      },
    })

    const db = drizzle(this.ctx.storage, { schema, logger: false })
    this.store = new EntitlementWindowStore(db, this.logger, () =>
      this.processor.invalidateEnforcementStateCache()
    )
    this.processor = new EntitlementWindowProcessor({
      clock: { now: () => Date.now() },
      instrument: (operation, fn, baseFields) =>
        runDoOperation(
          {
            requestId,
            service: "entitlementwindow",
            operation,
            waitUntil: (promise) => this.ctx.waitUntil(promise),
            baseFields,
          },
          fn
        ),
      logger: this.logger,
      runtime: {
        instanceId: requestId,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        destroyWindow: async () => {
          await this.ctx.storage.deleteAlarm()
          await this.ctx.storage.deleteAll()
        },
      },
      scheduler: {
        getAlarm: () => this.ctx.storage.getAlarm(),
        setAlarm: (at) => this.ctx.storage.setAlarm(at),
        deleteAlarm: () => this.ctx.storage.deleteAlarm(),
      },
      store: this.store,
      timing: {
        inactivityThresholdMs: inactivityThresholdMs(env),
        maxFlushIntervalMs: maxFlushIntervalMs(env),
      },
      wallet: { get: () => this.getWalletService() },
    })
    // Keep cold start minimal: the idempotency result cache hydrates lazily on
    // first lookup, so alarm-only wakes of dormant windows never pay the scan.
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations)
      await this.processor.initialize()
    })
  }

  public async apply(rawInput: ApplyInput): Promise<ApplyResult> {
    await this.ready

    return this.processor.apply(rawInput)
  }

  public async applyBatch(rawInput: ApplyBatchInput): Promise<{
    results: ApplyBatchResultRow[]
  }> {
    await this.ready

    return this.processor.applyBatch(rawInput)
  }

  public async getEnforcementState(
    rawInput: EnforcementStateInput
  ): Promise<EnforcementStateResult> {
    await this.ready

    return this.processor.getEnforcementState(rawInput)
  }

  public async getStatus(): Promise<EntitlementWindowStatus> {
    await this.ready

    return this.processor.getStatus()
  }

  async alarm(): Promise<void> {
    await this.ready

    return this.processor.alarm()
  }

  public async requestDeletion(): Promise<void> {
    await this.ready

    return this.processor.requestDeletion()
  }

  public async flushReservationForInvoicing(
    input: FlushReservationForInvoicingInput
  ): Promise<FlushReservationForInvoicingResult> {
    await this.ready

    return this.processor.flushReservationForInvoicing(input)
  }

  // Construct the wallet service on first use. Each DO instance opens at
  // most one connection — pool lifetime is the DO's lifetime.
  private getWalletService(): WalletService {
    if (this.walletService) return this.walletService

    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: this.runtimeEnv.DRIZZLE_LOG?.toString() === "true",
      singleton: false,
    })

    const ledger = new LedgerGateway({ db, logger: this.logger })
    this.walletService = new WalletService({
      db,
      logger: this.logger,
      ledgerGateway: ledger,
    })
    return this.walletService
  }
}
