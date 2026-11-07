import {
  type BudgetHandle,
  type BudgetHandleOptions,
  type LocalBudgetHandle,
  type LocalBudgetOptions,
  type LocalLeases,
  type SpendSettlement,
  type Transport,
  type UnpriceOptions,
  createLocalLeases,
  createTransport,
  openBudgetHandle,
} from "@unprice/budgets"
import { name, version } from "../package.json"
import type { ApiError } from "./errors"
import { type GeneratedSdkResources, createGeneratedSdkResources } from "./generated/sdk-resources"
import type { paths } from "./openapi"
import type { ApiResult, Result } from "./result"

export type { ApiResult, Result, UnpriceOptions }

export class Unprice implements GeneratedSdkResources {
  private readonly settlement: SpendSettlement
  private readonly local: LocalLeases
  public readonly access: GeneratedSdkResources["access"]
  public readonly usage: GeneratedSdkResources["usage"]
  public readonly budgets: GeneratedSdkResources["budgets"]
  public readonly customers: GeneratedSdkResources["customers"]
  public readonly features: GeneratedSdkResources["features"]
  public readonly planVersions: GeneratedSdkResources["planVersions"]
  public readonly subscriptions: GeneratedSdkResources["subscriptions"]
  public readonly paymentMethods: GeneratedSdkResources["paymentMethods"]
  public readonly wallet: GeneratedSdkResources["wallet"]
  public readonly walletCredits: GeneratedSdkResources["walletCredits"]
  public readonly invoices: GeneratedSdkResources["invoices"]
  public readonly analytics: GeneratedSdkResources["analytics"]
  public readonly ingestionEvents: GeneratedSdkResources["ingestionEvents"]
  public readonly monetization: GeneratedSdkResources["monetization"]
  public readonly retry: Transport<paths>["retry"]

  constructor(opts: UnpriceOptions) {
    const transport = createTransport<paths>(opts, { name, version, source: "sdk" })
    this.settlement = transport.settlement
    this.retry = transport.retry

    const resources = createGeneratedSdkResources(transport.openapi, transport.toResult)

    this.access = resources.access
    this.usage = resources.usage
    this.budgets = resources.budgets
    this.local = createLocalLeases({ transport: this.budgets, settlement: this.settlement })
    this.customers = resources.customers
    this.features = resources.features
    this.planVersions = resources.planVersions
    this.subscriptions = resources.subscriptions
    this.paymentMethods = resources.paymentMethods
    this.wallet = resources.wallet
    this.walletCredits = resources.walletCredits
    this.invoices = resources.invoices
    this.analytics = resources.analytics
    this.ingestionEvents = resources.ingestionEvents
    this.monetization = resources.monetization
  }

  /**
   * A handle bound to one budget key. It never changes an existing budget. With `ifMissing`, its
   * first authorize, charge, or lease creates the budget from that definition when the key has
   * none. With `{ mode: "local" }`, a long-lived process spends from a lease held in its memory,
   * one lease per key however many handles it takes.
   *
   * @throws RangeError when the key has an open local lease with other lease options.
   */
  budget(key: string, options: LocalBudgetOptions & BudgetHandleOptions): LocalBudgetHandle
  budget(key: string, options?: BudgetHandleOptions): BudgetHandle
  budget(
    key: string,
    options?: BudgetHandleOptions | (LocalBudgetOptions & BudgetHandleOptions)
  ): BudgetHandle | LocalBudgetHandle {
    const { budgets, settlement, local } = this
    return openBudgetHandle({ budgets, settlement, local }, key, options)
  }

  /**
   * Final-reports every open local lease, returning its unused capacity. Call it before the
   * process exits. Resolves with the keys whose lease was not returned; those expire and count in
   * full.
   */
  close(): Promise<Array<{ key: string; error: ApiError }>> {
    return this.local.close()
  }
}
