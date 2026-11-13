import { Ok } from "@unprice/error"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BillingService } from "../billing/service"
import { createInvoicingStub } from "../test-fixtures/billing-gateway"
import { SubscriptionService } from "./service"

const machine = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./withLockedMachine", () => ({
  withLockedMachine: machine.run,
  LockLostError: class extends Error {},
}))

function harness() {
  const order: string[] = []
  const invoicing = createInvoicingStub()
  const sync = vi.spyOn(invoicing.payerBudgets, "sync").mockImplementation(async () => {
    order.push("sync")
    return Ok({
      status: "synced",
      key: "unprice:customer:cus_1",
      version: 1,
      changes: [],
      statements: 0,
    })
  })
  const deps = {
    db: { query: { subscriptions: { findFirst: async () => ({ customerId: "cus_1" }) } } } as never,
    logger: { set: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    waitUntil: () => {},
    cache: {} as never,
    metrics: {} as never,
    customerService: {} as never,
    grantsManager: {} as never,
    entitlementService: {} as never,
    ledgerService: {} as never,
    walletService: {} as never,
    repo: {} as never,
    invoicing,
  }
  const billing = new BillingService(deps)
  const subscriptions = new SubscriptionService({ ...deps, billingService: billing })
  return { billing, subscriptions, order, sync }
}

beforeEach(() => vi.resetAllMocks())

describe("payer sync after the machine releases its lock", () => {
  it.each([0, 2])("syncs once after generating %i cycles", async (cyclesCreated) => {
    const h = harness()
    machine.run.mockImplementation(async () => {
      h.order.push("released")
      return { cyclesCreated, phasesProcessed: 1 }
    })
    const result = await h.billing.generateBillingPeriods({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      now: 1,
    })
    expect(result.val).toEqual({ cyclesCreated, phasesProcessed: 1 })
    expect(h.order).toEqual(["released", "sync"])
    expect(h.sync).toHaveBeenCalledExactlyOnceWith({ projectId: "proj_1", customerId: "cus_1" })
  })

  it.each([{ dryRun: true }, { lock: false }, { db: {} as never }])(
    "leaves caller-owned writes and dry runs to the caller: %j",
    async (options) => {
      const h = harness()
      machine.run.mockResolvedValue({ cyclesCreated: 2, phasesProcessed: 1 })
      await h.billing.generateBillingPeriods({
        projectId: "proj_1",
        subscriptionId: "sub_1",
        now: 1,
        ...options,
      })
      expect(h.sync).not.toHaveBeenCalled()
    }
  )

  it("syncs a payment-triggered renewal once after its machine releases the lock", async () => {
    const h = harness()
    machine.run.mockImplementation(async () => {
      h.order.push("released")
      return "active"
    })
    const result = await h.subscriptions.reconcilePaymentOutcome({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      outcome: "success",
      now: 1,
    })
    expect(result.val).toEqual({ status: "active" })
    expect(h.order).toEqual(["released", "sync"])
    expect(h.sync).toHaveBeenCalledOnce()
  })
})
