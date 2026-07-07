import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  billingBatchTrigger: vi.fn(),
  invoiceBatchTrigger: vi.fn(),
  invoiceFindMany: vi.fn(),
  loggerInfo: vi.fn(),
  renewBatchTrigger: vi.fn(),
  select: vi.fn(),
  selectQuery: {
    from: vi.fn(),
    groupBy: vi.fn(),
    having: vi.fn(),
    limit: vi.fn(),
    where: vi.fn(),
  },
  subscriptionFindMany: vi.fn(),
}))

const invoiceRows = [
  { id: "inv_due_1", subscriptionId: "sub_1", projectId: "proj_1" },
  { id: "inv_due_2", subscriptionId: "sub_2", projectId: "proj_1" },
]

const periodRows = [
  {
    projectId: "proj_1",
    statementKey: "stmt_1",
    subscriptionId: "sub_1",
    subscriptionPhaseId: "phase_1",
  },
  {
    projectId: "proj_1",
    statementKey: "stmt_2",
    subscriptionId: "sub_2",
    subscriptionPhaseId: "phase_2",
  },
  {
    projectId: "proj_1",
    statementKey: "stmt_missing_subscription",
    subscriptionId: null,
    subscriptionPhaseId: "phase_3",
  },
]

const subscriptionRows = [
  { id: "sub_1", customerId: "cus_1", projectId: "proj_1" },
  { id: "sub_2", customerId: "cus_2", projectId: "proj_1" },
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
    select: mocks.select,
    query: {
      invoices: {
        findMany: mocks.invoiceFindMany,
      },
      subscriptions: {
        findMany: mocks.subscriptionFindMany,
      },
    },
  },
}))

vi.mock("../tasks/billing", () => ({
  billingTask: {
    batchTrigger: mocks.billingBatchTrigger,
  },
}))

vi.mock("../tasks/invoice", () => ({
  invoiceTask: {
    batchTrigger: mocks.invoiceBatchTrigger,
  },
}))

vi.mock("../tasks/renew", () => ({
  renewTask: {
    batchTrigger: mocks.renewBatchTrigger,
  },
}))

describe("billingSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoiceFindMany.mockResolvedValue(invoiceRows)
  })

  it("fans out one billing task payload per due invoice with dedupe and per-subscription serialization", async () => {
    const { billingSchedule: definition } = await import("./billing")
    const billingSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await billingSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.invoiceFindMany).toHaveBeenCalledTimes(1)
    expect(mocks.billingBatchTrigger).toHaveBeenCalledTimes(1)
    expect(mocks.billingBatchTrigger).toHaveBeenCalledWith([
      {
        options: {
          concurrencyKey: "proj_1:sub_1",
          idempotencyKey: "invoice.billing:proj_1:inv_due_1",
        },
        payload: {
          invoiceId: "inv_due_1",
          subscriptionId: "sub_1",
          projectId: "proj_1",
          now: 1_783_339_200_000,
        },
      },
      {
        options: {
          concurrencyKey: "proj_1:sub_2",
          idempotencyKey: "invoice.billing:proj_1:inv_due_2",
        },
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
    mocks.invoiceFindMany.mockResolvedValueOnce([])

    const { billingSchedule: definition } = await import("./billing")
    const billingSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await billingSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.billingBatchTrigger).not.toHaveBeenCalled()
    expect(mocks.loggerInfo).not.toHaveBeenCalled()
    expect(result).toEqual({ invoiceIds: [] })
  })
})

describe("invoicingSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.select.mockReturnValue(mocks.selectQuery)
    mocks.selectQuery.from.mockReturnValue(mocks.selectQuery)
    mocks.selectQuery.groupBy.mockReturnValue(mocks.selectQuery)
    mocks.selectQuery.where.mockReturnValue(mocks.selectQuery)
    mocks.selectQuery.having.mockReturnValue(mocks.selectQuery)
    mocks.selectQuery.limit.mockResolvedValue(periodRows)
  })

  it("fans out active subscription invoice tasks with dedupe and per-subscription serialization", async () => {
    const { invoicingSchedule: definition } = await import("./invoicing")
    const invoicingSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await invoicingSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.select).toHaveBeenCalledTimes(1)
    expect(mocks.selectQuery.limit).toHaveBeenCalledWith(500)
    expect(mocks.invoiceBatchTrigger).toHaveBeenCalledTimes(1)
    expect(mocks.invoiceBatchTrigger).toHaveBeenCalledWith([
      {
        options: {
          concurrencyKey: "proj_1:sub_1",
          idempotencyKey: "invoice.create:proj_1:sub_1:stmt_1",
        },
        payload: {
          subscriptionId: "sub_1",
          projectId: "proj_1",
          now: 1_783_339_200_000,
        },
      },
      {
        options: {
          concurrencyKey: "proj_1:sub_2",
          idempotencyKey: "invoice.create:proj_1:sub_2:stmt_2",
        },
        payload: {
          subscriptionId: "sub_2",
          projectId: "proj_1",
          now: 1_783_339_200_000,
        },
      },
    ])
    expect(result).toEqual({ subscriptionIds: ["sub_1", "sub_2", null] })
  })

  it("does no invoicing work when no active subscription periods are due", async () => {
    mocks.selectQuery.limit.mockResolvedValueOnce([])

    const { invoicingSchedule: definition } = await import("./invoicing")
    const invoicingSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await invoicingSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.invoiceBatchTrigger).not.toHaveBeenCalled()
    expect(result).toEqual({ subscriptionIds: [] })
  })
})

describe("renewSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.subscriptionFindMany.mockResolvedValue(subscriptionRows)
  })

  it("fans out renewal tasks with dedupe and per-subscription serialization", async () => {
    const { renewSchedule: definition } = await import("./renew")
    const renewSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await renewSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.subscriptionFindMany).toHaveBeenCalledTimes(1)
    expect(mocks.renewBatchTrigger).toHaveBeenCalledTimes(1)
    expect(mocks.renewBatchTrigger).toHaveBeenCalledWith([
      {
        options: {
          concurrencyKey: "proj_1:sub_1",
          idempotencyKey: "subscription.renew:proj_1:sub_1",
        },
        payload: {
          subscriptionId: "sub_1",
          customerId: "cus_1",
          projectId: "proj_1",
          now: 1_783_339_200_000,
        },
      },
      {
        options: {
          concurrencyKey: "proj_1:sub_2",
          idempotencyKey: "subscription.renew:proj_1:sub_2",
        },
        payload: {
          subscriptionId: "sub_2",
          customerId: "cus_2",
          projectId: "proj_1",
          now: 1_783_339_200_000,
        },
      },
    ])
    expect(result).toEqual({ subscriptionIds: ["sub_1", "sub_2"] })
  })

  it("does no renewal work when no subscriptions are due", async () => {
    mocks.subscriptionFindMany.mockResolvedValueOnce([])

    const { renewSchedule: definition } = await import("./renew")
    const renewSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await renewSchedule.run({
      timestamp: new Date("2026-07-06T12:00:00.000Z"),
    })

    expect(mocks.renewBatchTrigger).not.toHaveBeenCalled()
    expect(result).toEqual({ subscriptionIds: [] })
  })
})
