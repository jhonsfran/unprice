import {
  type BudgetBalance,
  type BudgetHandle,
  type BudgetHold,
  BudgetSettleError,
  toDecimal,
} from "@unprice/budgets"
import { withDeadline } from "./deadline"

/** What was reserved, what was consumed, and the balance that answered the accounting. */
export interface BudgetStepSettlement {
  readonly holdId: string
  readonly hold: string
  readonly actual: string
  readonly balance: BudgetBalance
  readonly exceeded: boolean
}

/** One immutable accounting intent. Every attempt replays the same requests. */
export function createSettlement({
  budget,
  hold,
  actual,
  idempotencyKey,
  timeoutMs,
}: {
  budget: BudgetHandle
  hold: BudgetHold
  actual: number
  idempotencyKey: string
  timeoutMs: number
}): () => Promise<BudgetStepSettlement> {
  const amount = toDecimal(actual)
  const excess = toDecimal(Math.max(0, Number(amount) - Number(hold.amount)))
  const record =
    Number(excess) > 0
      ? Object.freeze({
          amount: excess,
          idempotencyKey: `${idempotencyKey}:excess`,
          occurredAt: Date.now(),
        })
      : undefined
  const recovery = Object.freeze({
    amount: record ? hold.amount : amount,
    ...(record ? { record } : {}),
  })
  let pending: Promise<BudgetStepSettlement> | undefined

  function settle(): Promise<BudgetStepSettlement> {
    if (pending) return pending
    pending = apply().catch((error: unknown) => {
      pending = undefined
      throw error
    })
    return pending
  }

  const failed = (
    failure:
      | { error: NonNullable<Awaited<ReturnType<BudgetHold["settle"]>>["error"]> }
      | { cause: unknown }
  ) =>
    new BudgetSettleError({
      value: undefined,
      actual,
      hold,
      idempotencyKey,
      recovery,
      retry: async () => {
        await settle()
      },
      ...failure,
    })

  async function apply(): Promise<BudgetStepSettlement> {
    try {
      // Keep the reservation until excess usage is durable. If this reply is lost, replay the
      // same event; if the process stops afterwards, hold/lease expiry still counts the reserve.
      const recorded = record
        ? await withDeadline(() => budget.record(record), { timeoutMs })
        : undefined
      if (recorded?.error) throw failed({ error: recorded.error })
      const settled = await withDeadline(() => hold.settle({ amount: recovery.amount }), {
        timeoutMs,
      })
      if (settled.error) throw failed({ error: settled.error })
      // Local settlement returns the lease's cached balance. Read the shared budget after an
      // overrun so neither that cache nor the earlier record reply hides the completed writes.
      let balance = settled.result.balance
      if (record) {
        const current = await withDeadline(() => budget.get(), { timeoutMs })
        if (current.error) throw failed({ error: current.error })
        balance = current.result.budget.balance
      }
      return {
        holdId: hold.id,
        hold: hold.amount,
        actual: amount,
        balance,
        exceeded: record !== undefined,
      }
    } catch (cause) {
      throw cause instanceof BudgetSettleError ? cause : failed({ cause })
    }
  }

  return settle
}
