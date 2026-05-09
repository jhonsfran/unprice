import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { SubscriptionInvoice } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { CustomerService } from "../customers/service"
import type { GrantsManager } from "../entitlements"
import type { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import type { PaymentProviderService } from "../payment-provider/service"
import type { RatingService } from "../rating/service"
import type { SubscriptionMachine } from "../subscriptions/machine"
import type { WalletService } from "../wallet"
import { BillingService } from "./service"

const machineMocks = vi.hoisted(() => ({
  reportInvoiceSuccess: vi.fn(),
  reportPaymentFailure: vi.fn(),
}))

vi.mock("../subscriptions/withLockedMachine", () => ({
  withLockedMachine: vi.fn(async (args: { run: (m: SubscriptionMachine) => Promise<unknown> }) => {
    return args.run(machineMocks as unknown as SubscriptionMachine)
  }),
}))

const repoMocks = vi.hoisted(() => ({
  findInvoiceById: vi.fn(),
  updateInvoiceIfStatus: vi.fn(),
  updateInvoice: vi.fn(),
}))

vi.mock("./repository.drizzle", () => ({
  DrizzleBillingRepository: vi.fn().mockImplementation(() => repoMocks),
}))

const settleMock = vi.hoisted(() => vi.fn())

vi.mock("../use-cases/billing/settle-invoice", () => ({
  settlePrepaidInvoiceToWallet: settleMock,
}))

function makeInvoice(overrides: Partial<SubscriptionInvoice> = {}): SubscriptionInvoice {
  return {
    id: "inv_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    customerId: "cust_1",
    status: "unpaid",
    paymentProvider: "sandbox",
    invoicePaymentProviderId: "provider_inv_1",
    invoicePaymentProviderUrl: "",
    paymentMethodId: "pm_1",
    collectionMethod: "charge_automatically",
    currency: "USD",
    totalAmount: 1_000_000_000,
    paidAt: null,
    metadata: null,
    ...overrides,
  } as unknown as SubscriptionInvoice
}

function makeBillingService(provider: Partial<PaymentProviderService>) {
  const customerService = {
    getPaymentProvider: vi.fn().mockResolvedValue({ val: provider }),
  } as unknown as CustomerService

  const logger = {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger

  const billing = new BillingService({
    db: {} as Database,
    logger,
    analytics: {} as Analytics,
    waitUntil: (p) => p,
    cache: {} as Cache,
    metrics: {} as Metrics,
    customerService,
    grantsManager: {} as GrantsManager,
    ratingService: {} as RatingService,
    ledgerService: {} as LedgerGateway,
    walletService: {} as WalletService,
  })

  return { billing, customerService, logger }
}

describe("BillingService.reconcileInvoiceFromProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    machineMocks.reportInvoiceSuccess.mockResolvedValue(Ok({ status: "active" }))
    machineMocks.reportPaymentFailure.mockResolvedValue(Ok({ status: "past_due" }))
    settleMock.mockResolvedValue(Ok(undefined))
  })

  it("settles and marks invoice paid when the provider already received payment", async () => {
    const invoice = makeInvoice()
    const updatedInvoice = {
      ...invoice,
      status: "paid" as const,
      metadata: {
        reason: "payment_received",
        note: "Invoice reconciled from provider status paid",
      },
    }
    repoMocks.findInvoiceById.mockResolvedValue(invoice)
    repoMocks.updateInvoiceIfStatus.mockResolvedValue(updatedInvoice)
    repoMocks.updateInvoice.mockResolvedValue(updatedInvoice)

    const provider = {
      getStatusInvoice: vi.fn().mockResolvedValue(
        Ok({
          status: "paid",
          invoiceId: "provider_inv_1",
          paidAt: 1_775_000_000,
          invoiceUrl: "https://provider.example/invoice/provider_inv_1",
          paymentAttempts: [],
        })
      ),
    }
    const { billing } = makeBillingService(provider as unknown as PaymentProviderService)

    const result = await billing.reconcileInvoiceFromProvider({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 1_800_000_000_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ changed: true, providerStatus: "paid", status: "paid" })
    expect(settleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice,
      })
    )
    expect(repoMocks.updateInvoiceIfStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedFromStatuses: ["draft", "waiting", "unpaid", "failed"],
        data: expect.objectContaining({
          status: "paid",
          paidAt: 1_775_000_000_000,
          invoicePaymentProviderUrl: "https://provider.example/invoice/provider_inv_1",
        }),
      })
    )
    expect(settleMock.mock.invocationCallOrder[0]).toBeLessThan(
      repoMocks.updateInvoiceIfStatus.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
    expect(machineMocks.reportInvoiceSuccess).toHaveBeenCalledWith({ invoiceId: "inv_1" })
    expect(repoMocks.updateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            subscriptionReconciledOutcome: "success",
            subscriptionReconciledAt: 1_800_000_000_000,
          }),
        }),
      })
    )
  })

  it("does not mutate the invoice while the provider invoice is still open", async () => {
    const invoice = makeInvoice()
    repoMocks.findInvoiceById.mockResolvedValue(invoice)

    const provider = {
      getStatusInvoice: vi.fn().mockResolvedValue(
        Ok({
          status: "open",
          invoiceId: "provider_inv_1",
          invoiceUrl: "https://provider.example/invoice/provider_inv_1",
          paymentAttempts: [],
        })
      ),
    }
    const { billing } = makeBillingService(provider as unknown as PaymentProviderService)

    const result = await billing.reconcileInvoiceFromProvider({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 1_800_000_000_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ changed: false, providerStatus: "open", status: "unpaid" })
    expect(settleMock).not.toHaveBeenCalled()
    expect(repoMocks.updateInvoiceIfStatus).not.toHaveBeenCalled()
    expect(machineMocks.reportInvoiceSuccess).not.toHaveBeenCalled()
    expect(machineMocks.reportPaymentFailure).not.toHaveBeenCalled()
  })

  it("reports payment failure when the provider marks the invoice uncollectible", async () => {
    const invoice = makeInvoice()
    const updatedInvoice = {
      ...invoice,
      status: "failed" as const,
      metadata: {
        reason: "payment_failed",
        note: "Invoice reconciled from provider status uncollectible",
      },
    }
    repoMocks.findInvoiceById.mockResolvedValue(invoice)
    repoMocks.updateInvoiceIfStatus.mockResolvedValue(updatedInvoice)
    repoMocks.updateInvoice.mockResolvedValue(updatedInvoice)

    const provider = {
      getStatusInvoice: vi.fn().mockResolvedValue(
        Ok({
          status: "uncollectible",
          invoiceId: "provider_inv_1",
          invoiceUrl: "https://provider.example/invoice/provider_inv_1",
          paymentAttempts: [],
        })
      ),
    }
    const { billing } = makeBillingService(provider as unknown as PaymentProviderService)

    const result = await billing.reconcileInvoiceFromProvider({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 1_800_000_000_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      changed: true,
      providerStatus: "uncollectible",
      status: "failed",
    })
    expect(settleMock).not.toHaveBeenCalled()
    expect(machineMocks.reportPaymentFailure).toHaveBeenCalledWith({
      invoiceId: "inv_1",
      error: "Provider invoice status: uncollectible",
    })
    expect(repoMocks.updateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            subscriptionReconciledOutcome: "failure",
          }),
        }),
      })
    )
  })
})
