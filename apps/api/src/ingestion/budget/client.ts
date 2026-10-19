import { Err, Ok, type Result } from "@unprice/error"
import { type BudgetOutcome, UnPriceBudgetError } from "@unprice/services/budgets"
import type { BudgetAddress, BudgetClient, BudgetRequest } from "@unprice/services/use-cases"
import type { Env } from "~/env"
import { getBudgetStub } from "../do-placement"
import type { BudgetTelemetry } from "./BudgetDO"

/** Transport failures throw: they are not budget decisions, and the route turns them into a 500. */
export class CloudflareBudgetClient implements BudgetClient {
  /** How the object served the last verb, for the wide event and Server-Timing. */
  telemetry: BudgetTelemetry | undefined

  constructor(private readonly env: Pick<Env, "APP_ENV" | "budget">) {}

  async execute(
    address: BudgetAddress,
    request: BudgetRequest
  ): Promise<Result<BudgetOutcome, UnPriceBudgetError>> {
    const reply = await getBudgetStub(this.env, address).execute(request)
    this.telemetry = reply.telemetry
    return reply.ok ? Ok(reply.outcome) : Err(new UnPriceBudgetError(reply.rejection))
  }
}
