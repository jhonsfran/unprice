import { name, version } from "../package.json"
import {
  type LocalBudgetHandle,
  type LocalBudgetOptions,
  type LocalLeases,
  createLocalLeases,
} from "./budget-local"
import {
  type BudgetDefinitionInput,
  type BudgetHandle,
  type SpendSettlement,
  createBudgetHandle,
} from "./budgets"
import type { ApiError } from "./errors"
import { type GeneratedSdkResources, createGeneratedSdkResources } from "./generated/sdk-resources"
import { type ModelCatalog, type ModelRate, createModelCatalog } from "./model-catalog"
import type { paths } from "./openapi"
import type { ApiResult, Result } from "./result"
import { type Transport, type UnpriceOptions, createTransport } from "./transport"

export type { ApiResult, Result, UnpriceOptions }

/**
 * The budget client: the nine budget operations under `budgets`, handles from `budget(key)`, and
 * `close()` for local leases. It sends the same requests and retries as `Unprice` from
 * `@unprice/api`, which builds on the same transport and re-exports this package's handles and
 * errors, so code written against one runs against the other with only the import changed.
 */
export class Unprice implements GeneratedSdkResources {
  private readonly settlement: SpendSettlement
  private readonly local: LocalLeases
  private readonly catalog: ModelCatalog
  public readonly budgets: GeneratedSdkResources["budgets"]
  public readonly retry: Transport<paths>["retry"]

  constructor(opts: UnpriceOptions) {
    const transport = createTransport<paths>(opts, { name, version, source: "budgets" })
    this.settlement = transport.settlement
    this.retry = transport.retry

    const resources = createGeneratedSdkResources(transport.openapi, transport.toResult)

    this.budgets = resources.budgets
    this.local = createLocalLeases({ transport: this.budgets, settlement: this.settlement })
    this.catalog = createModelCatalog({
      transport: (ids) => this.budgets.models({ ids: ids.join(",") }),
    })
  }

  /**
   * A model's token rates and limits from the Unprice catalog, by `provider/model` id. Fetched
   * once an hour per process; every adapter in the process shares the row.
   */
  model(id: string): Promise<ApiResult<ModelRate>> {
    return this.catalog.get(id)
  }

  /**
   * A handle bound to one budget key. It never changes an existing budget. With `ifMissing`, its
   * first authorize, charge, or lease creates the budget from that definition when the key has
   * none (ADR-0006 D8). With `{ mode: "local" }`, a long-lived process spends from a lease held in
   * its memory, one lease per key however many handles it takes.
   *
   * @throws RangeError when the key has an open local lease with other lease options.
   */
  budget(key: string, options?: { ifMissing?: BudgetDefinitionInput }): BudgetHandle
  budget(
    key: string,
    options: LocalBudgetOptions & { ifMissing?: BudgetDefinitionInput }
  ): LocalBudgetHandle
  budget(
    key: string,
    options?:
      | { ifMissing?: BudgetDefinitionInput }
      | (LocalBudgetOptions & { ifMissing?: BudgetDefinitionInput })
  ): BudgetHandle | LocalBudgetHandle {
    const remote = createBudgetHandle(this.budgets, key, this.settlement, options?.ifMissing)
    if (!options || !("mode" in options)) return remote
    return this.local.budget(remote, key, options.lease, options.ifMissing)
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
