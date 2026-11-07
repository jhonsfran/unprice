import type { BaseError, Result } from "@unprice/error"
import type { DbExecutor, Transaction } from "../deps"

/** Expected failures roll back the transaction, just as thrown failures do. */
export async function transactionResult<T, E extends BaseError>(
  db: DbExecutor,
  write: (tx: Transaction) => Promise<Result<T, E>>
): Promise<Result<T, E>> {
  class Rollback {
    constructor(readonly result: Result<T, E>) {}
  }

  try {
    return await db.transaction(async (tx) => {
      const result = await write(tx)
      if (result.err) throw new Rollback(result)
      return result
    })
  } catch (error) {
    if (error instanceof Rollback) return error.result
    throw error
  }
}
