import { beforeEach, describe, expect, it, vi } from "vitest"

const serviceCalls = vi.hoisted(() => ({
  billingInvoice: vi.fn(),
  generateBillingPeriods: vi.fn(),
  syncSubscriptionPayerBudget: vi.fn(),
  invoiceSubscription: vi.fn(),
  renewSubscription: vi.fn(),
}))

const ok = <T>(val: T) => ({ val })

type BillingTaskPayload = {
  invoiceId: string
  subscriptionId: string
  projectId: string
  now: number
}

type InvoiceTaskPayload = {
  subscriptionId: string
  projectId: string
  now: number
}

type RenewTaskPayload = InvoiceTaskPayload & {
  customerId: string
}

type RunnableTask<TPayload> = {
  run: (payload: TPayload, options: unknown) => Promise<unknown>
}

const runnableTask = <TPayload>(definition: unknown) => definition as RunnableTask<TPayload>

vi.mock("@trigger.dev/sdk/v3", () => ({
  task: vi.fn(<T>(definition: T) => definition),
}))

vi.mock("./context", () => ({
  createContext: vi.fn(async () => ({
    services: {
      billing: {
        billingInvoice: serviceCalls.billingInvoice,
        generateBillingPeriods: serviceCalls.generateBillingPeriods,
        syncSubscriptionPayerBudget: serviceCalls.syncSubscriptionPayerBudget,
      },
      subscriptions: {
        invoiceSubscription: serviceCalls.invoiceSubscription,
        renewSubscription: serviceCalls.renewSubscription,
      },
    },
    flushLogs: vi.fn(),
  })),
}))

describe("Trigger tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serviceCalls.billingInvoice.mockResolvedValue(ok({ total: 100, status: "paid" }))
    serviceCalls.invoiceSubscription.mockResolvedValue(ok({ status: "active" }))
    serviceCalls.renewSubscription.mockResolvedValue(ok({ status: "active" }))
    serviceCalls.generateBillingPeriods.mockResolvedValue(
      ok({ cyclesCreated: 0, phasesProcessed: 1 })
    )
    serviceCalls.syncSubscriptionPayerBudget.mockResolvedValue(undefined)
  })

  it("billingTask delegates exactly once to BillingService.billingInvoice", async () => {
    const { billingTask: definition } = await import("./billing")
    const billingTask = runnableTask<BillingTaskPayload>(definition)

    const result = await billingTask.run(
      {
        invoiceId: "inv_123",
        subscriptionId: "sub_123",
        projectId: "proj_123",
        now: 1_800_000_000_000,
      },
      { ctx: { task: { id: "task_billing_1" } } }
    )

    expect(result).toEqual({
      status: "paid",
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: 1_800_000_000_000,
    })
    expect(serviceCalls.billingInvoice).toHaveBeenCalledTimes(1)
    expect(serviceCalls.billingInvoice).toHaveBeenCalledWith({
      invoiceId: "inv_123",
      subscriptionId: "sub_123",
      projectId: "proj_123",
      caller: "job",
      now: 1_800_000_000_000,
    })
  })

  it("invoiceTask delegates exactly once to SubscriptionService.invoiceSubscription", async () => {
    const { invoiceTask: definition } = await import("./invoice")
    const invoiceTask = runnableTask<InvoiceTaskPayload>(definition)

    const result = await invoiceTask.run(
      {
        subscriptionId: "sub_123",
        projectId: "proj_123",
        now: 1_800_000_000_000,
      },
      { ctx: { task: { id: "task_invoice_1" } } }
    )

    expect(result).toEqual({
      status: "active",
      subscriptionId: "sub_123",
    })
    expect(serviceCalls.invoiceSubscription).toHaveBeenCalledTimes(1)
    expect(serviceCalls.invoiceSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      caller: "job",
      now: 1_800_000_000_000,
    })
  })

  it("renewTask delegates exactly once to SubscriptionService.renewSubscription", async () => {
    const { renewTask: definition } = await import("./renew")
    const renewTask = runnableTask<RenewTaskPayload>(definition)

    const result = await renewTask.run(
      {
        subscriptionId: "sub_123",
        projectId: "proj_123",
        customerId: "cus_123",
        now: 1_800_000_000_000,
      },
      { ctx: { task: { id: "task_renew_1" } } }
    )

    expect(result).toEqual({
      status: "active",
      subscriptionId: "sub_123",
      projectId: "proj_123",
      customerId: "cus_123",
      now: 1_800_000_000_000,
    })
    expect(serviceCalls.renewSubscription).toHaveBeenCalledTimes(1)
    // A job waits out open holds before the payer budget's pricing changes.
    expect(serviceCalls.renewSubscription).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      projectId: "proj_123",
      now: 1_800_000_000_000,
      caller: "job",
    })
  })

  it("periodTask delegates the payer sync to period generation even without new periods", async () => {
    const { periodTask: definition } = await import("./period")
    const periodTask = runnableTask<InvoiceTaskPayload>(definition)
    const payload = { subscriptionId: "sub_123", projectId: "proj_123", now: 1_800_000_000_000 }

    await periodTask.run(payload, { ctx: { task: { id: "task_period_1" } } })
    serviceCalls.generateBillingPeriods.mockResolvedValueOnce(
      ok({ cyclesCreated: 2, phasesProcessed: 1 })
    )
    await periodTask.run(payload, { ctx: { task: { id: "task_period_2" } } })

    expect(serviceCalls.syncSubscriptionPayerBudget).not.toHaveBeenCalled()
  })
})
