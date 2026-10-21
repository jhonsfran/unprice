import type { TSchema, Usage } from "@earendil-works/pi-ai"
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"
import { type AmountInput, toDecimal } from "@unprice/budgets"
import type { UnpriceBudgetOptions } from "./index"

export type UnpriceToolOptions = Pick<UnpriceBudgetOptions, "getBudget"> & {
  /** Fixed execution fee in USD, charged before the tool runs. */
  amount: AmountInput
  /** Stable identifier of the Harness storage, shared across its restarts. */
  sessionId: string
}

/** Charge a Pi Durable tool and include its fixed fee in native tool usage. */
export function withUnpriceTool<
  TParameters extends TSchema,
  TDetails extends Exclude<ToolExecutionResult["details"], undefined>,
>(
  tool: ToolRegistration<TParameters, TDetails>,
  config: UnpriceToolOptions
): ToolRegistration<TParameters, TDetails> {
  const { getBudget, sessionId } = config
  const amount = toDecimal(config.amount)
  const fee = Number(amount)
  if (!Number.isFinite(fee) || fee < 0 || amount.trim().length === 0)
    throw new RangeError("Tool amount must be a finite, nonnegative USD amount")
  if (sessionId.length === 0) throw new Error("sessionId is required for tool charge replay")

  const execute: typeof tool.execute = async (args, api, context) => {
    const result = await tool.execute(args, api, context)
    const usage: Usage = result.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    return {
      ...result,
      usage: { ...usage, cost: { ...usage.cost, total: usage.cost.total + fee } },
    }
  }
  return {
    ...tool,
    execute: async (args, api, context) => {
      const budget = await getBudget()
      if ("mode" in budget && budget.mode === "local")
        throw new Error("Durable tool charges require a remote budget handle for charge replay")
      const call = { ...api, toolCallId: `tool:${sessionId}:${api.taskId}` }
      return budget.wrap({ amount }, execute)(args, call, context)
    },
  }
}
