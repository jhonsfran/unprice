import { describe, expect, it, vi } from "vitest"
import { refreshRunningRuns } from "./refreshRunningRuns"

describe("refreshRunningRuns", () => {
  it("refreshes visible running runs through public SDK output and converts amounts to ledger scale", async () => {
    const running = createRun({ id: "brun_running", status: "running" })
    const completed = createRun({ id: "brun_completed", status: "completed", consumedAmount: 400 })
    const logger = { error: vi.fn() }
    const runsGet = vi.fn().mockResolvedValue({
      result: {
        runId: "brun_running",
        status: "running",
        customerId: "cus_123",
        budgetAmount: 1000,
        consumedAmount: 300,
        remainingAmount: 700,
        currency: "USD",
        workloadType: "workflow",
        workloadId: "daily-research",
        traceId: "trace_123",
        parentRunId: null,
      },
    })

    const runs = await refreshRunningRuns({
      customerId: "cus_123",
      projectId: "proj_123",
      runs: [running, completed],
      runsGet,
      logger,
    })

    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "running",
      budgetAmount: 1_000_000_000,
      consumedAmount: 300_000_000,
      remainingAmount: 700_000_000,
    })
    expect(runs[1]).toMatchObject({
      id: "brun_completed",
      status: "completed",
      consumedAmount: 400,
    })
    expect(runsGet).toHaveBeenCalledWith({
      runId: "brun_running",
      project_id: "proj_123",
    })
  })

  it("keeps the Postgres row when live refresh fails", async () => {
    const running = createRun({ id: "brun_running", status: "running", consumedAmount: 100 })
    const logger = { error: vi.fn() }
    const runsGet = vi.fn().mockResolvedValue({
      error: { code: "NOT_FOUND", message: "RUN_NOT_FOUND" },
    })

    const runs = await refreshRunningRuns({
      customerId: "cus_123",
      projectId: "proj_123",
      runs: [running],
      runsGet,
      logger,
    })

    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "running",
      consumedAmount: 100,
    })
    expect(logger.error).toHaveBeenCalledWith(expect.any(Error), {
      project_id: "proj_123",
      customer_id: "cus_123",
      run_id: "brun_running",
    })
  })
})

function createRun(
  overrides: Partial<{
    id: string
    status: "running" | "completed" | "expired" | "canceled" | "budget_exceeded" | "failed"
    consumedAmount: number
  }> = {}
) {
  return {
    id: "brun_running",
    projectId: "proj_123",
    customerId: "cus_123",
    status: "running" as const,
    statusReason: null,
    budgetAmount: 1_000,
    consumedAmount: 0,
    remainingAmount: 1_000,
    currency: "USD",
    walletReservationId: "res_123",
    idempotencyKey: "idem_123",
    workloadType: "workflow" as const,
    workloadId: "daily-research",
    traceId: "trace_123",
    parentRunId: null,
    metadata: {},
    expiresAt: null,
    startedAt: new Date("2026-06-21T10:00:00.000Z"),
    endedAt: null,
    createdAt: new Date("2026-06-21T10:00:00.000Z"),
    updatedAt: new Date("2026-06-21T10:00:00.000Z"),
    ...overrides,
  }
}
