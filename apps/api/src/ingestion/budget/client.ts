import { Err, Ok, type Result } from "@unprice/error"
import { type BudgetOutcome, UnPriceBudgetError } from "@unprice/services/budgets"
import type { BudgetAddress, BudgetClient, BudgetRequest } from "@unprice/services/use-cases"
import type { Env } from "~/env"
import { getBudgetStub } from "../do-placement"

/** Transport failures throw: they are not budget decisions, and the route turns them into a 500. */
export class CloudflareBudgetClient implements BudgetClient {
  constructor(private readonly env: Pick<Env, "APP_ENV" | "budget">) {}

  async execute(
    address: BudgetAddress,
    request: BudgetRequest
  ): Promise<Result<BudgetOutcome, UnPriceBudgetError>> {
    const reply = await getBudgetStub(this.env, address).execute(request)
    return reply.ok ? Ok(reply.outcome) : Err(new UnPriceBudgetError(reply.rejection))
  }
}
