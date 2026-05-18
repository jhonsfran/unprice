import type { Database } from "@unprice/db"

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

class RollbackOnly extends Error {
  readonly name = "RollbackOnly"
}

export async function withRollbackTransaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  let result: T | undefined
  let hasResult = false

  try {
    await db.transaction(async (tx) => {
      result = await fn(tx)
      hasResult = true
      throw new RollbackOnly()
    })
  } catch (error) {
    if (!(error instanceof RollbackOnly)) {
      throw error
    }
  }

  if (!hasResult) {
    throw new Error("Rollback transaction finished without returning a result")
  }

  return result as T
}
