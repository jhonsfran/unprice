import { Ok } from "@unprice/error"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BudgetRunService } from "../../budget-runs"
import { endRun } from "./end-run"
import type { RunBudgetClient } from "./run-budget-client"

describe("endRun", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("persists and returns the authoritative DO terminal timestamp", async () => {
    const run = createRun()
    const requestedAt = new Date("2026-06-21T10:10:00.000Z").getTime()
    const authoritativeEndedAt = new Date("2026-06-21T10:05:00.000Z").getTime()
    vi.spyOn(Date, "now").mockReturnValue(requestedAt)

    const getRun = vi.fn().mockResolvedValue(Ok(run))
    const updateRunSummary = vi.fn().mockResolvedValue(Ok(run))
    const endRunInDo = vi.fn<RunBudgetClient["endRun"]>().mockResolvedValue(
      Ok({
        runId: run.id,
        status: "completed",
        endedAt: authoritativeEndedAt,
        budgetAmount: 1_000,
        consumedAmount: 300,
        remainingAmount: 700,
      })
    )

    const result = await endRun(
      {
        services: {
          budgetRuns: { getRun, updateRunSummary } as unknown as BudgetRunService,
        },
        runBudget: { endRun: endRunInDo } as unknown as RunBudgetClient,
      },
      {
        projectId: run.projectId,
        runId: run.id,
        keyCustomerId: null,
        status: "completed",
      }
    )

    expect(endRunInDo).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: requestedAt, runId: run.id })
    )
    expect(updateRunSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        endedAt: new Date(authoritativeEndedAt),
        runId: run.id,
        status: "completed",
      })
    )
    expect(result.val).toMatchObject({
      runId: run.id,
      status: "completed",
      endedAt: authoritativeEndedAt,
    })
  })

  it("does not persist a terminal summary when an older DO omits endedAt", async () => {
    const run = createRun()
    const getRun = vi.fn().mockResolvedValue(Ok(run))
    const updateRunSummary = vi.fn()
    const endRunInDo = vi.fn<RunBudgetClient["endRun"]>().mockResolvedValue(
      Ok({
        runId: run.id,
        status: "completed",
        budgetAmount: 1_000,
        consumedAmount: 300,
        remainingAmount: 700,
      })
    )

    const result = await endRun(
      {
        services: {
          budgetRuns: { getRun, updateRunSummary } as unknown as BudgetRunService,
        },
        runBudget: { endRun: endRunInDo } as unknown as RunBudgetClient,
      },
      {
        projectId: run.projectId,
        runId: run.id,
        keyCustomerId: null,
        status: "completed",
      }
    )

    expect(updateRunSummary).not.toHaveBeenCalled()
    expect(result.val).toBeUndefined()
    expect(result.err?.message).toBe("BUDGET_ERROR")
  })
})

function createRun() {
  return {
    id: "brun_123",
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
  }
}
