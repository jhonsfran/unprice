import type {
  AuthorizeBudgetInput,
  ChargeBudgetInput,
  ReleaseBudgetInput,
  SettleBudgetInput,
  UpsertBudgetInput,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import {
  type Amount,
  type BudgetOutcome,
  UnPriceBudgetError,
  parseAmount,
  parseBudgetConfig,
} from "../../budgets"
import type { BudgetClient, BudgetRequest } from "./budget-client"

/** A verb as an adapter receives it: wire amounts and config, the key carried beside it. */
export type BudgetVerbRequest =
  | ({ type: "upsert" } & Omit<UpsertBudgetInput, "key">)
  | ({ type: "authorize" } & Omit<AuthorizeBudgetInput, "key">)
  | ({ type: "settle" } & Omit<SettleBudgetInput, "key">)
  | ({ type: "release" } & Omit<ReleaseBudgetInput, "key">)
  | ({ type: "charge" } & Omit<ChargeBudgetInput, "key">)
  | ({ type: "record" } & Omit<ChargeBudgetInput, "key">)
  | { type: "get" }

export type ExecuteBudgetCommandDeps = { budgets: BudgetClient }

export type ExecuteBudgetCommandInput = {
  projectId: string
  key: string
  request: BudgetVerbRequest
}

/**
 * The one owner of every budget verb: the API routes call it now, ingestion `record` and
 * subscription-created budgets later. It turns wire amounts and config into the core's types,
 * and an upsert always configures the budget at the address it is sent to.
 */
export async function executeBudgetCommand(
  deps: ExecuteBudgetCommandDeps,
  input: ExecuteBudgetCommandInput
): Promise<Result<BudgetOutcome, UnPriceBudgetError>> {
  const request = toBudgetRequest(input)
  if (request.err) return request
  return deps.budgets.execute({ projectId: input.projectId, key: input.key }, request.val)
}

function toBudgetRequest({
  projectId,
  key,
  request,
}: ExecuteBudgetCommandInput): Result<BudgetRequest, UnPriceBudgetError> {
  switch (request.type) {
    case "upsert": {
      const config = parseBudgetConfig({
        limits: request.limits.map((limit) => ({ ...limit, id: limit.id ?? limit.window })),
        holds: request.holds,
        onUnavailable: request.onUnavailable,
      })
      if (config.err) return config
      const unit = /^[A-Z]{3}$/.test(request.unit) ? `money:${request.unit}` : request.unit
      return Ok({ type: "upsert", key, projectId, unit, config: config.val })
    }
    case "authorize": {
      const amount = amountOf(request.amount)
      if (amount.err) return amount
      const { idempotencyKey, ttlMs } = request
      return Ok({ type: "authorize", idempotencyKey, ttlMs, cost: { amount: amount.val } })
    }
    case "settle": {
      const amount = amountOf(request.amount)
      if (amount.err) return amount
      return Ok({ type: "settle", holdId: request.holdId, cost: { amount: amount.val } })
    }
    case "release":
      return Ok({ type: "release", holdId: request.holdId })
    case "charge":
    case "record": {
      const amount = amountOf(request.amount)
      if (amount.err) return amount
      const { type, idempotencyKey } = request
      return Ok({ type, idempotencyKey, cost: { amount: amount.val } })
    }
    case "get":
      return Ok({ type: "get" })
  }
}

function amountOf(text: string): Result<Amount, UnPriceBudgetError> {
  const parsed = parseAmount(text)
  if (parsed.ok) return Ok(parsed.amount)
  return Err(new UnPriceBudgetError({ code: "INVALID_AMOUNT", amount: text }))
}
