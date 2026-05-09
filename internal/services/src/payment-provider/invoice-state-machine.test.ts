import { describe, expect, it } from "vitest"
import { providerStatusToInvoiceEvent, transitionInvoiceStatus } from "./invoice-state-machine"

describe("invoice payment state machine", () => {
  it("maps provider terminal states to local payment events", () => {
    expect(providerStatusToInvoiceEvent("paid")).toBe("payment_succeeded")
    expect(providerStatusToInvoiceEvent("void")).toBe("invoice_voided")
    expect(providerStatusToInvoiceEvent("uncollectible")).toBe("invoice_uncollectible")
    expect(providerStatusToInvoiceEvent("open")).toBe("noop")
    expect(providerStatusToInvoiceEvent("past_due")).toBe("noop")
  })

  it("allows provider-paid invoices to move open local states to paid", () => {
    for (const currentStatus of ["draft", "waiting", "unpaid", "failed"] as const) {
      expect(
        transitionInvoiceStatus({
          currentStatus,
          event: "payment_succeeded",
        })
      ).toMatchObject({
        nextStatus: "paid",
        settleWallet: true,
        subscriptionOutcome: "success",
      })
    }
  })

  it("treats already-applied and disallowed transitions as no-ops", () => {
    expect(
      transitionInvoiceStatus({
        currentStatus: "paid",
        event: "payment_succeeded",
      })
    ).toEqual({ event: "noop", reason: "already_applied" })

    expect(
      transitionInvoiceStatus({
        currentStatus: "void",
        event: "payment_succeeded",
      })
    ).toEqual({ event: "noop", reason: "disallowed" })
  })

  it("keeps payment failures effectful even when the local status is already unpaid", () => {
    expect(
      transitionInvoiceStatus({
        currentStatus: "unpaid",
        event: "payment_failed",
      })
    ).toMatchObject({
      nextStatus: "unpaid",
      settleWallet: false,
      subscriptionOutcome: "failure",
    })
  })

  it("moves provider-uncollectible invoices to a terminal local failure", () => {
    expect(
      transitionInvoiceStatus({
        currentStatus: "unpaid",
        event: "invoice_uncollectible",
      })
    ).toMatchObject({
      nextStatus: "failed",
      settleWallet: false,
      subscriptionOutcome: "failure",
    })
  })
})
