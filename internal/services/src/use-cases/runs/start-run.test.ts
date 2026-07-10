import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { BudgetRunService } from "../../budget-runs"
import type { RunBudgetClient } from "./run-budget-client"
import { startRun } from "./start-run"

const AUTHORITATIVE_ENDED_AT = new Date("2026-06-19T12:00:00.000Z").getTime()

describe("startRun wallet failure", () => {
  it("persists the authoritative DO failure timestamp", async () => {
    const { deps, run, updateRunSummary } = createDeps({ endedAt: AUTHORITATIVE_ENDED_AT })

    const result = await startRun(deps, createInput())

    expect(result.err?.message).toBe("WALLET_EMPTY")
    expect(updateRunSummary).toHaveBeenCalledWith({
      projectId: run.projectId,
      runId: run.id,
      status: "failed",
      statusReason: "wallet: wallet empty",
      consumedAmount: 0,
      remainingAmount: 0,
      endedAt: new Date(AUTHORITATIVE_ENDED_AT),
    })
  })

  it("does not make Postgres terminal when an older DO omits the failure timestamp", async () => {
    const { deps, updateRunSummary } = createDeps({ endedAt: undefined })

    const result = await startRun(deps, createInput())

    expect(result.err?.message).toBe("BUDGET_ERROR")
    expect(updateRunSummary).not.toHaveBeenCalled()
  })
})

function createDeps(input: { endedAt: number | undefined }) {
  const run = createRun()
  const createRunRow = vi.fn().mockResolvedValue(Ok(run))
  const updateRunSummary = vi.fn().mockResolvedValue(Ok(run))
  const startRunInDo = vi.fn<RunBudgetClient["startRun"]>().mockResolvedValue(
    Ok({
      summary: {
        runId: run.id,
        status: "failed",
        endedAt: input.endedAt,
        budgetAmount: run.budgetAmount,
        consumedAmount: 0,
        remainingAmount: 0,
      },
      walletReservationId: "",
      walletError: "wallet empty",
    })
  )

  return {
    deps: {
      services: {
        budgetRuns: { createRun: createRunRow, updateRunSummary } as unknown as BudgetRunService,
      },
      runBudget: { startRun: startRunInDo } as unknown as RunBudgetClient,
    },
    run,
    updateRunSummary,
  }
}

function createInput() {
  return {
    projectId: "proj_123",
    customerId: "cus_123",
    budgetAmount: 1_000,
    currency: "USD",
    idempotencyKey: "idem_123",
    workloadType: "workflow" as const,
    workloadId: "daily-research",
  }
}

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
    walletReservationId: null,
    idempotencyKey: "idem_123",
    workloadType: "workflow" as const,
    workloadId: "daily-research",
    traceId: null,
    parentRunId: null,
    metadata: {},
    expiresAt: null,
    startedAt: new Date("2026-06-19T11:00:00.000Z"),
    endedAt: null,
    createdAt: new Date("2026-06-19T11:00:00.000Z"),
    updatedAt: new Date("2026-06-19T11:00:00.000Z"),
  }
}
