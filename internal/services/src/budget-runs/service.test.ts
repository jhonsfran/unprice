import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import { BudgetRunService } from "./service"

/**
 * Covers `BudgetRunService.listRunsRefreshed` — the unified refresh + persist
 * path that replaced the router-level `refreshRunningRuns` helper. The mismatch
 * policy cases migrated verbatim from `refreshRunningRuns.test.ts`; the terminal
 * persistence cases are new (the old helper never wrote to Postgres).
 */
describe("BudgetRunService.listRunsRefreshed", () => {
  const logger = {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
  const cache = {
    budgetRun: {
      remove: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Cache

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function createService(db: Database = {} as unknown as Database) {
    return new BudgetRunService({ db, logger, cache, waitUntil })
  }

  it("refreshes visible running runs through the SDK and converts amounts to ledger scale", async () => {
    const service = createService()
    const updateSpy = vi.spyOn(service, "updateRunSummary")

    const running = createRun({ id: "brun_running", status: "running" })
    const completed = createRun({ id: "brun_completed", status: "completed", consumedAmount: 400 })
    const runsGet = vi.fn().mockResolvedValue({
      result: liveSummary({ runId: "brun_running", status: "running" }),
    })

    const runs = await service.listRunsRefreshed({
      customerId: "cus_123",
      projectId: "proj_123",
      runs: [running, completed],
      runsGet,
    })

    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "running",
      budgetAmount: 1_000_000_000,
      consumedAmount: 300_000_000,
      remainingAmount: 700_000_000,
    })
    // Non-running rows pass through untouched (no SDK read, no persist).
    expect(runs[1]).toMatchObject({
      id: "brun_completed",
      status: "completed",
      consumedAmount: 400,
    })
    expect(runsGet).toHaveBeenCalledWith({
      runId: "brun_running",
      project_id: "proj_123",
    })
    expect(runsGet).toHaveBeenCalledTimes(1)
    // Still running → no read-model write.
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("persists a newly-terminal run through updateRunSummary and invalidates the cache", async () => {
    const setSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "brun_running", status: "completed" }]),
      }),
    })
    const db = {
      update: vi.fn().mockReturnValue({ set: setSpy }),
    } as unknown as Database
    const service = createService(db)

    const running = createRun({ id: "brun_running", status: "running", consumedAmount: 0 })
    const runsGet = vi.fn().mockResolvedValue({
      result: liveSummary({
        runId: "brun_running",
        status: "completed",
        consumedAmountMinor: 300,
        remainingAmountMinor: 700,
      }),
    })

    const runs = await service.listRunsRefreshed({
      customerId: "cus_123",
      projectId: "proj_123",
      runs: [running],
      runsGet,
    })

    // The row is written with ledger-scaled amounts and an observation timestamp.
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        consumedAmount: 300_000_000,
        remainingAmount: 700_000_000,
        endedAt: expect.any(Date),
      })
    )
    // updateRunSummary owns cache invalidation for the memory-first cache.
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(cache.budgetRun.remove).toHaveBeenCalledWith("proj_123:brun_running")
    // The returned row reflects the terminal live state.
    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "completed",
      consumedAmount: 300_000_000,
      remainingAmount: 700_000_000,
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("preserves extra row fields (e.g. customer) when refreshing project-wide runs", async () => {
    const service = createService()
    const updateSpy = vi
      .spyOn(service, "updateRunSummary")
      .mockResolvedValue(Ok({ id: "brun_running" } as never))

    const running = {
      ...createRun({ id: "brun_running", status: "running" }),
      customer: {
        id: "cus_123",
        projectId: "proj_123",
        email: "customer@example.com",
        name: "Example Customer",
      },
    }
    const runsGet = vi.fn().mockResolvedValue({
      result: liveSummary({ runId: "brun_running", status: "completed" }),
    })

    const runs = await service.listRunsRefreshed({
      projectId: "proj_123",
      runs: [running],
      runsGet,
    })

    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "completed",
      customer: {
        id: "cus_123",
        email: "customer@example.com",
      },
    })
    // Terminal transition observed → persisted once (per-row customerId used).
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("keeps the Postgres row and persists nothing when the live refresh fails", async () => {
    const service = createService()
    const updateSpy = vi.spyOn(service, "updateRunSummary")

    const running = createRun({ id: "brun_running", status: "running", consumedAmount: 100 })
    const runsGet = vi.fn().mockResolvedValue({
      error: { code: "NOT_FOUND", message: "RUN_NOT_FOUND" },
    })

    const runs = await service.listRunsRefreshed({
      customerId: "cus_123",
      projectId: "proj_123",
      runs: [running],
      runsGet,
    })

    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "running",
      consumedAmount: 100,
    })
    expect(updateSpy).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.any(Error), {
      project_id: "proj_123",
      customer_id: "cus_123",
      run_id: "brun_running",
    })
  })

  it("keeps the Postgres row and persists nothing when the live run identity does not match", async () => {
    const service = createService()
    const updateSpy = vi.spyOn(service, "updateRunSummary")

    const running = createRun({ id: "brun_running", status: "running", consumedAmount: 100 })
    const runsGet = vi.fn().mockResolvedValue({
      result: liveSummary({ runId: "brun_other", status: "running" }),
    })

    const runs = await service.listRunsRefreshed({
      customerId: "cus_123",
      projectId: "proj_123",
      runs: [running],
      runsGet,
    })

    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "running",
      consumedAmount: 100,
    })
    expect(updateSpy).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.any(Error), {
      project_id: "proj_123",
      customer_id: "cus_123",
      run_id: "brun_running",
    })
  })

  it("keeps the Postgres row and persists nothing when the live run currency does not match", async () => {
    const service = createService()
    const updateSpy = vi.spyOn(service, "updateRunSummary")

    const running = createRun({ id: "brun_running", status: "running", consumedAmount: 100 })
    const runsGet = vi.fn().mockResolvedValue({
      result: liveSummary({ runId: "brun_running", status: "running", currency: "EUR" }),
    })

    const runs = await service.listRunsRefreshed({
      customerId: "cus_123",
      projectId: "proj_123",
      runs: [running],
      runsGet,
    })

    expect(runs[0]).toMatchObject({
      id: "brun_running",
      status: "running",
      consumedAmount: 100,
      currency: "USD",
    })
    expect(updateSpy).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.any(Error), {
      project_id: "proj_123",
      customer_id: "cus_123",
      run_id: "brun_running",
    })
  })
})

function liveSummary(
  overrides: Partial<{
    runId: string
    status: "running" | "completed" | "expired" | "canceled" | "budget_exceeded" | "failed"
    customerId: string
    currency: string
    budgetAmountMinor: number
    consumedAmountMinor: number
    remainingAmountMinor: number
  }> = {}
) {
  return {
    runId: "brun_running",
    status: "running" as const,
    customerId: "cus_123",
    budgetAmountMinor: 1000,
    consumedAmountMinor: 300,
    remainingAmountMinor: 700,
    currency: "USD",
    workloadType: "workflow" as const,
    workloadId: "daily-research",
    traceId: "trace_123",
    parentRunId: null,
    ...overrides,
  }
}

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
