import { Err } from "@unprice/error"
import { describe, expect, it } from "vitest"
import type { FundingWork } from "../../budgets"
import { UnPriceWalletError, type WalletErrorCode, type WalletService } from "../../wallet"
import { walletFunding } from "./budget-wallet"

const address = { projectId: "proj_1", key: "unprice:customer:cus_1" }
const reserve: FundingWork = {
  statementKey: "inv_nov",
  customerId: "cus_1",
  currency: "USD",
  reservationId: null,
  intent: {
    kind: "reserve",
    seq: 1,
    amount: BigInt(1_000),
    at: 1_796_083_200_000,
    periodStart: 1_796_083_200_000,
    periodEnd: 1_798_761_600_000,
  },
}

function refusingWallet(code: WalletErrorCode) {
  const refuse = async () => Err(new UnPriceWalletError({ message: code }))
  return {
    createReservation: refuse,
    extendReservation: refuse,
    captureReservationUsage: refuse,
    releaseReservation: refuse,
  } as unknown as WalletService
}

describe("walletFunding", () => {
  it("answers a wallet refusal as the intent's error", async () => {
    const funding = walletFunding(refusingWallet("WALLET_RESERVATION_ALREADY_RECONCILED"))

    const ran = await funding.run(address, reserve)

    expect(ran.err?.message).toBe("WALLET_RESERVATION_ALREADY_RECONCILED")
  })

  it("throws a ledger failure, which a replay may clear", async () => {
    const funding = walletFunding(refusingWallet("WALLET_LEDGER_FAILED"))

    await expect(funding.run(address, reserve)).rejects.toThrow("WALLET_LEDGER_FAILED")
  })

  it("refuses a close without a reservation and an amount past the wallet's range", async () => {
    const funding = walletFunding(refusingWallet("WALLET_LEDGER_FAILED"))
    const close: FundingWork = {
      ...reserve,
      intent: { kind: "close", seq: 2, captures: [{ periodId: "p", amount: BigInt(1) }] },
    }
    const huge: FundingWork = {
      ...reserve,
      intent: { ...reserve.intent, amount: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) },
    } as FundingWork

    const closed = await funding.run(address, close)
    const reserved = await funding.run(address, huge)

    expect(closed.err?.message).toBe("WALLET_RESERVATION_NOT_FOUND")
    expect(reserved.err?.message).toBe("WALLET_INVALID_AMOUNT")
  })
})
