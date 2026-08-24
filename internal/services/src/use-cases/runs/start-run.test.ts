import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { BudgetRunService } from "../../budget-runs"
import type { RunBudgetClient } from "./run-budget-client"
import { startRun } from "./start-run"

const AUTHORITATIVE_ENDED_AT = new Date("2026-06-19T12:00:00.000Z").getTime()
const NOW = new Date("2026-06-19T11:00:00.000Z").getTime()
const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS

describe("startRun expiration", () => {
  it("persists and forwards the same one-hour default expiration", async () => {
    const { createRunRow, deps, startRunInDo } = createDeps({
      endedAt: AUTHORITATIVE_ENDED_AT,
    })

    await startRun(deps, createInput())

    expect(createRunRow).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: new Date(NOW + ONE_HOUR_MS) })
    )
    expect(startRunInDo).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: NOW + ONE_HOUR_MS })
    )
  })

  it("uses the expiration stored by the idempotent Postgres create", async () => {
    const storedExpiresAt = new Date(NOW + 30 * 60 * 1000)
    const { deps, startRunInDo } = createDeps({
      endedAt: AUTHORITATIVE_ENDED_AT,
      storedExpiresAt,
    })

    await startRun(deps, createInput())

    expect(startRunInDo).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: storedExpiresAt.getTime() })
    )
  })

  it("rejects an expiration later than 24 hours before persistence", async () => {
    const { createRunRow, deps, startRunInDo } = createDeps({
      endedAt: AUTHORITATIVE_ENDED_AT,
    })

    const result = await startRun(deps, createInput({ expiresAt: NOW + ONE_DAY_MS + 1 }))

    expect(result.err?.message).toBe("INVALID_EXPIRATION")
    expect(createRunRow).not.toHaveBeenCalled()
    expect(startRunInDo).not.toHaveBeenCalled()
  })
})

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

function createDeps(input: { endedAt: number | undefined; storedExpiresAt?: Date }) {
  const run = createRun(input.storedExpiresAt)
  const createRunRow = vi.fn().mockImplementation(async (createInput) =>
    Ok({
      ...run,
      expiresAt: input.storedExpiresAt ?? createInput.expiresAt,
    })
  )
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
      now: () => NOW,
    },
    createRunRow,
    run,
    startRunInDo,
    updateRunSummary,
  }
}

function createInput(overrides: { expiresAt?: number | null } = {}) {
  return {
    projectId: "proj_123",
    customerId: "cus_123",
    budgetAmount: 1_000,
    currency: "USD",
    idempotencyKey: "idem_123",
    workloadType: "workflow" as const,
    workloadId: "daily-research",
    ...overrides,
  }
}

function createRun(expiresAt: Date | null = null) {
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
    expiresAt,
    startedAt: new Date("2026-06-19T11:00:00.000Z"),
    endedAt: null,
    createdAt: new Date("2026-06-19T11:00:00.000Z"),
    updatedAt: new Date("2026-06-19T11:00:00.000Z"),
  }
}
