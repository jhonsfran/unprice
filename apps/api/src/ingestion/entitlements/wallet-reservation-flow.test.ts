import { describe, expect, it } from "vitest"
import {
  hasPendingWalletFlush,
  isReservationInvoiceContextMissing,
  requireReservationInvoiceContext,
} from "./wallet-reservation-flow"

describe("wallet reservation flow helpers", () => {
  it("detects pending flush state from persisted sequence fields", () => {
    expect(
      hasPendingWalletFlush({
        flushSeq: 1,
        pendingFlushSeq: 2,
        refillInFlight: false,
        reservationId: "res_123",
      })
    ).toBe(true)

    expect(
      hasPendingWalletFlush({
        flushSeq: 2,
        pendingFlushSeq: 2,
        refillInFlight: false,
        reservationId: "res_123",
      })
    ).toBe(false)
  })

  it("requires billing invoice context before wallet capture or refill", () => {
    expect(
      isReservationInvoiceContextMissing({
        billingPeriodId: "bp_123",
        cycleEndAt: 20,
        cycleStartAt: 10,
        featurePlanVersionItemId: "item_123",
        featureSlug: "api_calls",
        statementKey: "stmt_123",
      })
    ).toBe(false)

    expect(() =>
      requireReservationInvoiceContext({
        billingPeriodId: null,
        cycleEndAt: 20,
        cycleStartAt: 10,
        featurePlanVersionItemId: "item_123",
        featureSlug: "api_calls",
        reservationId: "res_123",
        statementKey: "stmt_123",
      })
    ).toThrow("Wallet reservation res_123 is missing billing invoice context")
  })
})
