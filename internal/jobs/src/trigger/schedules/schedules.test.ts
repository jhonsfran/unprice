import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  batchTrigger: vi.fn(),
  findMany: vi.fn(),
  loggerInfo: vi.fn(),
}))

const invoiceRows = [
  { id: "inv_due_1", subscriptionId: "sub_1", projectId: "proj_1" },
  { id: "inv_due_2", subscriptionId: "sub_2", projectId: "proj_1" },
]

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
  },
  schedules: {
    task: vi.fn(<T>(definition: T) => definition),
  },
}))

vi.mock("../db", () => ({
  db: {
    query: {
      invoices: {
        findMany: mocks.findMany,
      },
    },
  },
}))

vi.mock("../tasks/billing", () => ({
  billingTask: {
    batchTrigger: mocks.batchTrigger,
  },
}))

describe("billingSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findMany.mockResolvedValue(invoiceRows)
  })

  it("fans out one billing task payload per due invoice", async () => {
    const { billingSchedule: definition } = await import("./billing")
    const billingSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await billingSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.batchTrigger).toHaveBeenCalledTimes(1)
    expect(mocks.batchTrigger).toHaveBeenCalledWith([
      {
        payload: {
          invoiceId: "inv_due_1",
          subscriptionId: "sub_1",
          projectId: "proj_1",
          now: 1_783_339_200_000,
        },
      },
      {
        payload: {
          invoiceId: "inv_due_2",
          subscriptionId: "sub_2",
          projectId: "proj_1",
          now: 1_783_339_200_000,
        },
      },
    ])
    expect(result).toEqual({ invoiceIds: ["inv_due_1", "inv_due_2"] })
  })

  it("does no work when no invoices are due", async () => {
    mocks.findMany.mockResolvedValueOnce([])

    const { billingSchedule: definition } = await import("./billing")
    const billingSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await billingSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.batchTrigger).not.toHaveBeenCalled()
    expect(mocks.loggerInfo).not.toHaveBeenCalled()
    expect(result).toEqual({ invoiceIds: [] })
  })
})
