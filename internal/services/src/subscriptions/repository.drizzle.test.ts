import type { Database } from "@unprice/db"
import { Err } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { UnPriceSubscriptionError } from "./errors"
import { DrizzleSubscriptionRepository } from "./repository.drizzle"

describe("DrizzleSubscriptionRepository", () => {
  it("rolls back while preserving Result errors from transaction callbacks", async () => {
    const tx = {} as Database
    let rolledBack = false
    const db = {
      transaction: vi.fn(async (callback: (tx: Database) => Promise<unknown>) => {
        try {
          return await callback(tx)
        } catch (error) {
          rolledBack = true
          throw error
        }
      }),
    } as unknown as Database
    const repo = new DrizzleSubscriptionRepository(db)
    const resultError = new UnPriceSubscriptionError({ message: "phase failed" })
    const expectedResult = Err(resultError)

    const result = await repo.withTransaction(async (_txRepo, txDb) => {
      expect(txDb).toBe(tx)
      return expectedResult
    })

    expect(result).toBe(expectedResult)
    expect(rolledBack).toBe(true)
  })
})
