import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import { createSubscription } from "./create"

describe("createSubscription use case", () => {
  it("rolls back the transaction when phase creation returns a Result error", async () => {
    const phaseError = new UnPriceSubscriptionError({
      message: "phase create failed",
    })
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
    const subscription = {
      id: "sub_123",
      customerId: "cus_123",
      projectId: "proj_123",
    }
    const createSubscriptionService = vi.fn().mockResolvedValue(Ok(subscription))
    const createPhase = vi.fn().mockResolvedValue(Err(phaseError))

    const result = await createSubscription(
      {
        db,
        logger: {
          set: vi.fn(),
        } as never,
        services: {
          subscriptions: {
            createSubscription: createSubscriptionService,
            createPhase,
          },
        } as never,
      },
      {
        projectId: "proj_123",
        input: {
          customerId: "cus_123",
          phases: [
            {
              planVersionId: "version_123",
              startAt: Date.parse("2026-05-02T12:00:00.000Z"),
            },
          ],
        } as never,
      }
    )

    expect(result.err).toBe(phaseError)
    expect(rolledBack).toBe(true)
    expect(createSubscriptionService).toHaveBeenCalledWith(
      expect.objectContaining({
        db: tx,
      })
    )
    expect(createPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        db: tx,
      })
    )
  })
})
