import type { SubscriptionInvoice } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WalletService } from "../../wallet"
import { UnPriceWalletError } from "../../wallet/errors"
import { settlePrepaidInvoiceToWallet } from "./settle-invoice"

function makeInvoice(overrides: Partial<SubscriptionInvoice> = {}): SubscriptionInvoice {
  return {
    id: "inv_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    customerId: "cust_1",
    status: "paid",
    paymentProvider: "sandbox",
    invoicePaymentProviderId: "",
    invoicePaymentProviderUrl: "",
    paymentMethodId: "pm_1",
    collectionMethod: "charge_automatically",
    currency: "USD",
    grossAmount: 50_000_000,
    amountDue: 50_000_000,
    amountPaid: 0,
    amountIncluded: 0,
    paidAt: Date.now(),
    whenToBill: "pay_in_advance",
    metadata: null,
    ...overrides,
  } as unknown as SubscriptionInvoice
}

function makeWalletService(
  settleResult?: unknown
): WalletService & { settleReceivable: ReturnType<typeof vi.fn> } {
  return {
    settleReceivable: vi.fn().mockResolvedValue(settleResult ?? Ok(undefined)),
  } as unknown as WalletService & { settleReceivable: ReturnType<typeof vi.fn> }
}

describe("settlePrepaidInvoiceToWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("happy path: settles the receivable with correct params and idempotency key", async () => {
    const walletService = makeWalletService()
    const invoice = makeInvoice({
      amountDue: 50_000_000,
      amountIncluded: 10_000_000,
      amountPaid: 5_000_000,
      grossAmount: 65_000_000,
    })

    const result = await settlePrepaidInvoiceToWallet({ walletService, invoice })

    expect(result.err).toBeUndefined()
    expect(walletService.settleReceivable).toHaveBeenCalledTimes(1)
    expect(walletService.settleReceivable).toHaveBeenCalledWith({
      projectId: "proj_1",
      customerId: "cust_1",
      currency: "USD",
      paidAmount: 50_000_000,
      idempotencyKey: "invoice_receivable:inv_1",
      metadata: {
        invoice_id: "inv_1",
        subscription_id: "sub_1",
        when_to_bill: "pay_in_advance",
      },
    })
  })

  it("returns Ok immediately when amountDue is 0 (trial / free invoice)", async () => {
    const walletService = makeWalletService()
    const invoice = makeInvoice({
      amountDue: 0,
      grossAmount: 10_000_000,
      amountIncluded: 10_000_000,
    })

    const result = await settlePrepaidInvoiceToWallet({ walletService, invoice })

    expect(result.err).toBeUndefined()
    expect(walletService.settleReceivable).not.toHaveBeenCalled()
  })

  it("returns Ok immediately when amountDue is negative", async () => {
    const walletService = makeWalletService()
    const invoice = makeInvoice({ amountDue: -100 })

    const result = await settlePrepaidInvoiceToWallet({ walletService, invoice })

    expect(result.err).toBeUndefined()
    expect(walletService.settleReceivable).not.toHaveBeenCalled()
  })

  it("propagates wallet error as Err", async () => {
    const walletError = new UnPriceWalletError({ message: "WALLET_LEDGER_FAILED" })
    const walletService = makeWalletService(Err(walletError))
    const invoice = makeInvoice()

    const result = await settlePrepaidInvoiceToWallet({ walletService, invoice })

    expect(result.err).toBeInstanceOf(UnPriceWalletError)
    expect(result.err?.message).toBe("WALLET_LEDGER_FAILED")
  })

  it("passes whenToBill from the invoice into metadata", async () => {
    const walletService = makeWalletService()
    const invoice = makeInvoice({ whenToBill: "pay_in_arrear" })

    await settlePrepaidInvoiceToWallet({ walletService, invoice })

    expect(walletService.settleReceivable).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ when_to_bill: "pay_in_arrear" }),
      })
    )
  })

  it("idempotency key is stable — same invoice id always produces same key", async () => {
    const walletService = makeWalletService()
    const invoice = makeInvoice({ id: "inv_stable" })

    await settlePrepaidInvoiceToWallet({ walletService, invoice })

    expect(walletService.settleReceivable).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "invoice_receivable:inv_stable",
      })
    )
  })
})
