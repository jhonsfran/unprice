import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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
  phaseFindMany: vi.fn(),
  periodBatchTrigger: vi.fn(),
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
      subscriptionPhases: {
        findMany: mocks.phaseFindMany,
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

vi.mock("../tasks/period", () => ({
  periodTask: {
    batchTrigger: mocks.periodBatchTrigger,
  },
}))

vi.mock("../tasks/renew", () => ({
  renewTask: {
    batchTrigger: mocks.renewBatchTrigger,
  },
}))

// Loading a schedule pulls in the service graph, which under Turbo contention can outlast one
// test's timeout. Load them once here, so each test's import is a cache hit.
beforeAll(async () => {
  await Promise.all([
    import("./billing"),
    import("./invoicing"),
    import("./periods"),
    import("./renew"),
  ])
}, 120_000)

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
    mocks.selectQuery.limit.mockReset()
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

describe("periodsSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.subscriptionFindMany.mockReset()
    mocks.phaseFindMany.mockReset()
  })

  it("re-syncs only subscriptions whose phases changed within the last day, besides the due ones", async () => {
    mocks.subscriptionFindMany.mockResolvedValueOnce([{ id: "sub_1", projectId: "proj_1" }])
    mocks.phaseFindMany.mockResolvedValueOnce([
      { subscriptionId: "sub_1", projectId: "proj_1" },
      { subscriptionId: "sub_2", projectId: "proj_1" },
      { subscriptionId: "sub_2", projectId: "proj_1" },
    ])
    const { periodsSchedule: definition } = await import("./periods")
    const periodsSchedule = runnableSchedule<SchedulePayload>(definition)
    const now = Date.parse("2026-07-06T12:00:00.000Z")

    const result = await periodsSchedule.run({ timestamp: new Date(now) })

    const [{ where: phaseWhere }] = mocks.phaseFindMany.mock.calls[0] as [
      {
        where: (
          table: unknown,
          ops: { gte: (column: unknown, value: number) => unknown }
        ) => unknown
      },
    ]
    const gte = vi.fn()
    phaseWhere({ updatedAtM: "updated_at_m" }, { gte })
    expect(gte).toHaveBeenCalledWith("updated_at_m", now - 24 * 60 * 60 * 1000)
    // The due selection never reads a subscription's own updatedAtM.
    const [{ where: dueWhere }] = mocks.subscriptionFindMany.mock.calls[0] as [
      { where: (table: unknown, ops: Record<string, unknown>) => unknown },
    ]
    const ops = {
      and: vi.fn(),
      eq: vi.fn(),
      notInArray: vi.fn(),
      lte: vi.fn(),
      gte: vi.fn(),
      or: vi.fn(),
    }
    dueWhere(
      {
        active: "active",
        status: "status",
        currentCycleEndAt: "current_cycle_end_at_m",
        updatedAtM: "updated_at_m",
      },
      ops
    )
    expect(ops.gte).not.toHaveBeenCalled()
    expect(ops.or).not.toHaveBeenCalled()
    expect(ops.lte).toHaveBeenCalledWith("current_cycle_end_at_m", now + 3 * 24 * 60 * 60 * 1000)
    expect(mocks.periodBatchTrigger.mock.calls).toEqual([
      [
        [
          { payload: { subscriptionId: "sub_1", projectId: "proj_1", now } },
          { payload: { subscriptionId: "sub_2", projectId: "proj_1", now } },
        ],
      ],
    ])
    expect(result).toEqual({ subscriptionIds: ["sub_1", "sub_2"] })
  })

  it("triggers at most 500 subscriptions per batch", async () => {
    const due = Array.from({ length: 1_201 }, (_, i) => ({ id: `sub_${i}`, projectId: "proj_1" }))
    mocks.subscriptionFindMany.mockResolvedValueOnce(due)
    mocks.phaseFindMany.mockResolvedValueOnce([])
    const { periodsSchedule: definition } = await import("./periods")
    const periodsSchedule = runnableSchedule<SchedulePayload>(definition)

    await periodsSchedule.run({ timestamp: new Date(Date.parse("2026-07-06T12:00:00.000Z")) })

    const sizes = mocks.periodBatchTrigger.mock.calls.map(([items]) => (items as unknown[]).length)
    expect(sizes).toEqual([500, 500, 201])
    const last = mocks.periodBatchTrigger.mock.calls[2]?.[0] as Array<{
      payload: { subscriptionId: string }
    }>
    expect(last[200]?.payload.subscriptionId).toBe("sub_1200")
  })

  it("does nothing when no subscription is due or changed", async () => {
    mocks.subscriptionFindMany.mockResolvedValueOnce([])
    mocks.phaseFindMany.mockResolvedValueOnce([])
    const { periodsSchedule: definition } = await import("./periods")
    const periodsSchedule = runnableSchedule<SchedulePayload>(definition)

    const result = await periodsSchedule.run({
      timestamp: new Date(Date.parse("2026-07-06T12:00:00.000Z")),
    })

    expect(mocks.periodBatchTrigger).not.toHaveBeenCalled()
    expect(result).toEqual({ subscriptionIds: [] })
  })
})
