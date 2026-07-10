import { RunBudgetError } from "@unprice/services/use-cases"
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

  it("flushes captures for invoicing through the scoped durable object", async () => {
    const flushCapturesForInvoicing = vi
      .fn()
      .mockResolvedValue({ ok: true, flushed: 2, skipped: 1 })
    const getByName = vi.fn().mockReturnValue({ flushCapturesForInvoicing })
    const env = {
      APP_ENV: "preview",
      runbudget: { getByName },
    } as unknown as ConstructorParameters<typeof CloudflareRunBudgetClient>[0]
    const client = new CloudflareRunBudgetClient(env)

    const result = await client.flushCapturesForInvoicing({
      projectId: "proj_123",
      customerId: "cus_123",
      runId: "brun_123",
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })

    expect(result.val).toEqual({ flushed: 2, skipped: 1 })
    expect(getByName).toHaveBeenCalledWith("preview:proj_123:cus_123:brun_123")
    expect(flushCapturesForInvoicing).toHaveBeenCalledWith({
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })
  })

  it("returns a RunBudgetError when an invoicing flush fails", async () => {
    const cause = new RunBudgetError({ message: "capture unavailable" })
    const getByName = vi.fn().mockReturnValue({
      flushCapturesForInvoicing: vi.fn().mockRejectedValue(cause),
    })
    const env = {
      APP_ENV: "production",
      runbudget: { getByName },
    } as unknown as ConstructorParameters<typeof CloudflareRunBudgetClient>[0]
    const client = new CloudflareRunBudgetClient(env)

    const result = await client.flushCapturesForInvoicing({
      projectId: "proj_123",
      customerId: "cus_123",
      runId: "brun_123",
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })

    expect(result.err?.name).toBe("RunBudgetError")
    expect(result.err?.message).toBe("capture unavailable")
    expect(result.err?.cause).toBe(cause)
  })

  it("uses a generic message when an invoicing flush rejects without an Error", async () => {
    const getByName = vi.fn().mockReturnValue({
      flushCapturesForInvoicing: vi.fn().mockRejectedValue("capture unavailable"),
    })
    const env = {
      APP_ENV: "production",
      runbudget: { getByName },
    } as unknown as ConstructorParameters<typeof CloudflareRunBudgetClient>[0]
    const client = new CloudflareRunBudgetClient(env)

    const result = await client.flushCapturesForInvoicing({
      projectId: "proj_123",
      customerId: "cus_123",
      runId: "brun_123",
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })

    expect(result.err?.message).toBe("flushCapturesForInvoicing failed")
    expect(result.err?.cause).toBeUndefined()
  })
})
