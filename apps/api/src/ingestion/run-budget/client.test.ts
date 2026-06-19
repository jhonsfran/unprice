import { describe, expect, it, vi } from "vitest"
import { CloudflareRunBudgetClient } from "./client"

describe("CloudflareRunBudgetClient", () => {
  it("scopes run budget durable objects by app environment", async () => {
    const startRun = vi.fn().mockResolvedValue({
      runId: "brun_123",
      status: "running",
      budgetAmount: 100,
      consumedAmount: 0,
      remainingAmount: 100,
      walletReservationId: "res_123",
    })
    const getByName = vi.fn().mockReturnValue({ startRun })

    const env = {
      APP_ENV: "preview",
      runbudget: { getByName },
    } as unknown as ConstructorParameters<typeof CloudflareRunBudgetClient>[0]
    const client = new CloudflareRunBudgetClient(env)

    await client.startRun({
      projectId: "proj_123",
      customerId: "cus_123",
      runId: "brun_123",
      budgetAmount: 100,
      currency: "USD",
      idempotencyKey: "idem_123",
    })

    expect(getByName).toHaveBeenCalledWith("preview:proj_123:cus_123:brun_123")
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_123",
        customerId: "cus_123",
        runId: "brun_123",
      })
    )
  })
})
