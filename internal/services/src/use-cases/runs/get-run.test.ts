import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { BudgetRunService } from "../../budget-runs"
import { getRun } from "./get-run"
import type { RunBudgetClient } from "./run-budget-client"

describe("getRun", () => {
  it("refreshes running run amounts from RunBudgetDO", async () => {
    const run = createRun({ status: "running", consumedAmount: 0, remainingAmount: 1_000 })
    const getRunById = vi.fn().mockResolvedValue(Ok(run))
    const getRunStatus = vi.fn<RunBudgetClient["getRunStatus"]>().mockResolvedValue(
      Ok({
        runId: run.id,
        status: "running",
        budgetAmount: 1_000,
        consumedAmount: 250,
        remainingAmount: 750,
      })
    )

    const result = await getRun(
      {
        services: {
          budgetRuns: { getRun: getRunById } as unknown as BudgetRunService,
        },
        runBudget: { getRunStatus } as unknown as Pick<RunBudgetClient, "getRunStatus">,
      },
      {
        projectId: run.projectId,
        runId: run.id,
        keyCustomerId: null,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      runId: run.id,
      status: "running",
      consumedAmount: 250,
      remainingAmount: 750,
      workloadType: "workflow",
      workloadId: "daily-research",
    })
    expect(getRunStatus).toHaveBeenCalledWith({
      projectId: run.projectId,
      customerId: run.customerId,
      runId: run.id,
    })
  })

  it("does not call RunBudgetDO for terminal runs", async () => {
    const run = createRun({ status: "completed", consumedAmount: 400, remainingAmount: 600 })
    const getRunById = vi.fn().mockResolvedValue(Ok(run))
    const getRunStatus = vi.fn<RunBudgetClient["getRunStatus"]>()

    const result = await getRun(
      {
        services: {
          budgetRuns: { getRun: getRunById } as unknown as BudgetRunService,
        },
        runBudget: { getRunStatus } as unknown as Pick<RunBudgetClient, "getRunStatus">,
      },
      {
        projectId: run.projectId,
        runId: run.id,
        keyCustomerId: null,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      runId: run.id,
      status: "completed",
      consumedAmount: 400,
      remainingAmount: 600,
    })
    expect(getRunStatus).not.toHaveBeenCalled()
  })

  it("hides runs outside the API key customer scope", async () => {
    const run = createRun({ customerId: "cus_actual" })
    const getRunById = vi.fn().mockResolvedValue(Ok(run))

    const result = await getRun(
      {
        services: {
          budgetRuns: { getRun: getRunById } as unknown as BudgetRunService,
        },
      },
      {
        projectId: run.projectId,
        runId: run.id,
        keyCustomerId: "cus_other",
      }
    )

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toBe("RUN_NOT_FOUND")
  })
})

function createRun(
  overrides: Partial<{
    id: string
    projectId: string
    customerId: string
    status: "running" | "completed" | "expired" | "canceled" | "budget_exceeded" | "failed"
    consumedAmount: number
    remainingAmount: number
  }> = {}
) {
  return {
    id: "brun_live_123",
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
