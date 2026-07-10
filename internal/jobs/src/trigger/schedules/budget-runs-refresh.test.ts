import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  budgetRunsFindMany: vi.fn(),
  listRunsRefreshed: vi.fn(),
  flushLogs: vi.fn(),
  createContext: vi.fn(),
  runsGet: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}))

type SchedulePayload = {
  timestamp: Date
}

type RunnableSchedule<TPayload> = {
  run: (payload: TPayload) => Promise<unknown>
}

const runnableSchedule = <TPayload>(definition: unknown) => definition as RunnableSchedule<TPayload>

vi.mock("@trigger.dev/sdk/v3", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
  schedules: {
    task: vi.fn(<T>(definition: T) => definition),
  },
}))

vi.mock("../db", () => ({
  db: {
    query: {
      budgetRuns: {
        findMany: mocks.budgetRunsFindMany,
      },
    },
  },
}))

vi.mock("../tasks/context", () => ({
  createContext: mocks.createContext,
}))

vi.mock("../../unprice", () => ({
  unprice: {
    runs: {
      get: mocks.runsGet,
    },
  },
}))

describe("budgetRunsRefreshSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createContext.mockResolvedValue({
      services: {
        budgetRuns: {
          listRunsRefreshed: mocks.listRunsRefreshed,
        },
      },
      flushLogs: mocks.flushLogs,
    })
    mocks.listRunsRefreshed.mockResolvedValue([])
  })

  it("groups stuck running runs by project and refreshes each through listRunsRefreshed", async () => {
    const expiresAt = new Date("2026-07-06T10:00:00.000Z")
    mocks.budgetRunsFindMany.mockResolvedValue([
      { id: "brun_1", projectId: "proj_1", status: "running", expiresAt },
      { id: "brun_2", projectId: "proj_1", status: "running", expiresAt },
      { id: "brun_3", projectId: "proj_2", status: "running", expiresAt },
    ])

    const { budgetRunsRefreshSchedule: definition } = await import("./budget-runs-refresh")
    const schedule = runnableSchedule<SchedulePayload>(definition)

    const result = await schedule.run({ timestamp: new Date("2026-07-06T12:00:00.000Z") })

    expect(mocks.budgetRunsFindMany).toHaveBeenCalledTimes(1)
    // One service context + one refresh call per project.
    expect(mocks.createContext).toHaveBeenCalledTimes(2)
    expect(mocks.listRunsRefreshed).toHaveBeenCalledTimes(2)
    expect(mocks.listRunsRefreshed).toHaveBeenCalledWith({
      projectId: "proj_1",
      runs: [
        { id: "brun_1", projectId: "proj_1", status: "running", expiresAt },
        { id: "brun_2", projectId: "proj_1", status: "running", expiresAt },
      ],
      runsGet: mocks.runsGet,
    })
    expect(mocks.listRunsRefreshed).toHaveBeenCalledWith({
      projectId: "proj_2",
      runs: [{ id: "brun_3", projectId: "proj_2", status: "running", expiresAt }],
      runsGet: mocks.runsGet,
    })
    expect(mocks.flushLogs).toHaveBeenCalledTimes(2)
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ projectIds: ["proj_1", "proj_2"], stuck: 3, processed: 3 })
  })

  it("does no work when no runs are stuck past the grace window", async () => {
    mocks.budgetRunsFindMany.mockResolvedValue([])

    const { budgetRunsRefreshSchedule: definition } = await import("./budget-runs-refresh")
    const schedule = runnableSchedule<SchedulePayload>(definition)

    const result = await schedule.run({ timestamp: new Date("2026-07-06T12:00:00.000Z") })

    expect(mocks.createContext).not.toHaveBeenCalled()
    expect(mocks.listRunsRefreshed).not.toHaveBeenCalled()
    expect(mocks.loggerWarn).not.toHaveBeenCalled()
    expect(result).toEqual({ projectIds: [], stuck: 0, processed: 0 })
  })

  it("continues past a project whose refresh fails and flushes that context with a 500", async () => {
    const expiresAt = new Date("2026-07-06T10:00:00.000Z")
    mocks.budgetRunsFindMany.mockResolvedValue([
      { id: "brun_1", projectId: "proj_1", status: "running", expiresAt },
      { id: "brun_3", projectId: "proj_2", status: "running", expiresAt },
    ])
    mocks.listRunsRefreshed
      .mockRejectedValueOnce(new Error("refresh boom"))
      .mockResolvedValueOnce([])

    const { budgetRunsRefreshSchedule: definition } = await import("./budget-runs-refresh")
    const schedule = runnableSchedule<SchedulePayload>(definition)

    const result = await schedule.run({ timestamp: new Date("2026-07-06T12:00:00.000Z") })

    expect(mocks.listRunsRefreshed).toHaveBeenCalledTimes(2)
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "budget-runs.refresh.project_failed",
      expect.objectContaining({ projectId: "proj_1" })
    )
    expect(mocks.flushLogs).toHaveBeenCalledTimes(2)
    // The failing project's context is still flushed, with a 500.
    expect(mocks.flushLogs).toHaveBeenNthCalledWith(1, 500)
    // Only the succeeding project counts toward processed.
    expect(result).toEqual({ projectIds: ["proj_1", "proj_2"], stuck: 2, processed: 1 })
  })

  it("advances beyond a full failed page so later stuck runs are still attempted", async () => {
    const expiresAt = new Date("2026-07-06T10:00:00.000Z")
    const failedPage = Array.from({ length: 500 }, (_, index) => ({
      id: `brun_${index.toString().padStart(3, "0")}`,
      projectId: "proj_failing",
      status: "running",
      expiresAt,
    }))
    const laterRun = {
      id: "brun_500",
      projectId: "proj_later",
      status: "running",
      expiresAt,
    }
    mocks.budgetRunsFindMany.mockResolvedValueOnce(failedPage).mockResolvedValueOnce([laterRun])
    mocks.listRunsRefreshed
      .mockRejectedValueOnce(new Error("first page failed"))
      .mockResolvedValueOnce([])

    const { budgetRunsRefreshSchedule: definition } = await import("./budget-runs-refresh")
    const schedule = runnableSchedule<SchedulePayload>(definition)

    const result = await schedule.run({ timestamp: new Date("2026-07-06T12:00:00.000Z") })

    expect(mocks.budgetRunsFindMany).toHaveBeenCalledTimes(2)
    expect(mocks.listRunsRefreshed).toHaveBeenLastCalledWith({
      projectId: "proj_later",
      runs: [laterRun],
      runsGet: mocks.runsGet,
    })
    expect(result).toEqual({
      projectIds: ["proj_failing", "proj_later"],
      stuck: 501,
      processed: 1,
    })
  })
})
