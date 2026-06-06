import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { SubscriptionInvoice } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
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
import type { UnPriceBillingError } from "./errors"
import { BillingService } from "./service"

vi.mock("../subscriptions/withLockedMachine", () => ({
  withLockedMachine: vi.fn(async (args: { run: (m: SubscriptionMachine) => Promise<unknown> }) => {
    return args.run({} as unknown as SubscriptionMachine)
  }),
}))

type RepoCalls = {
  updateInvoice: Array<{ invoiceId: string; projectId: string; data: Record<string, unknown> }>
  findInvoiceById: Array<{ invoiceId: string; projectId: string }>
}
const repoCalls: RepoCalls = { updateInvoice: [], findInvoiceById: [] }

type CollectInvoicePaymentPayload = {
  invoiceId: string
  projectId: string
  now: number
}

type BillingServiceCollectAccess = {
  _collectInvoicePayment: (
    payload: CollectInvoicePaymentPayload
  ) => Promise<Result<SubscriptionInvoice, UnPriceBillingError>>
}

function collectInvoicePayment(billing: BillingService, payload: CollectInvoicePaymentPayload) {
  return (billing as unknown as BillingServiceCollectAccess)._collectInvoicePayment(payload)
}

let findInvoiceByIdResult: SubscriptionInvoice | null = null

const updateInvoiceMock = vi.fn(
  async (input: { invoiceId: string; projectId: string; data: Record<string, unknown> }) => {
    repoCalls.updateInvoice.push(input)
    return {
      ...findInvoiceByIdResult,
      id: input.invoiceId,
      projectId: input.projectId,
      status: (input.data.status as string | undefined) ?? "unpaid",
      ...input.data,
    } as unknown as SubscriptionInvoice
  }
)

const findInvoiceByIdMock = vi.fn(async (input: { invoiceId: string; projectId: string }) => {
  repoCalls.findInvoiceById.push(input)
  return findInvoiceByIdResult
})

vi.mock("./repository.drizzle", () => ({
  DrizzleBillingRepository: vi.fn().mockImplementation(() => ({
    updateInvoice: updateInvoiceMock,
    findInvoiceById: findInvoiceByIdMock,
  })),
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
    grossAmount: 1_000_000_000,
    amountDue: 1_000_000_000,
    amountPaid: 0,
    amountIncluded: 0,
    paidAt: null,
    metadata: null,
    pastDueAt: null,
    dueAt: 1_000,
    sentAt: null,
    issueDate: null,
    ...overrides,
  } as unknown as SubscriptionInvoice
}

function makeProviderService(
  overrides: Partial<PaymentProviderService> = {}
): PaymentProviderService {
  return {
    getStatusInvoice: vi
      .fn()
      .mockResolvedValue(Ok({ status: "open", invoiceUrl: "", paidAt: null })),
    collectPayment: vi
      .fn()
      .mockResolvedValue(Ok({ status: "paid", invoiceUrl: "https://stripe.example/paid" })),
    sendInvoice: vi.fn().mockResolvedValue(Ok({ invoiceId: "provider_inv_1" })),
    ...overrides,
  } as unknown as PaymentProviderService
}

function makeBillingService(opts: {
  invoice: SubscriptionInvoice
  paymentProvider?: PaymentProviderService
  resolveProviderErr?: FetchError
}) {
  const provider = opts.paymentProvider ?? makeProviderService()
  findInvoiceByIdResult = opts.invoice

  const customerService = {
    getPaymentProvider: vi
      .fn()
      .mockResolvedValue(
        opts.resolveProviderErr ? { err: opts.resolveProviderErr } : { val: provider }
      ),
  } as unknown as CustomerService

  const walletService = {} as WalletService

  // db.query.subscriptions.findFirst and db.query.paymentProviderConfig.findFirst
  const subscriptionData = {
    id: opts.invoice.subscriptionId,
    projectId: opts.invoice.projectId,
    phases: [
      {
        projectId: opts.invoice.projectId,
        planVersion: {},
        items: [],
      },
    ],
    customer: { id: opts.invoice.customerId, projectId: opts.invoice.projectId },
  }

  const paymentProviderConfigData = {
    projectId: opts.invoice.projectId,
    paymentProvider: opts.invoice.paymentProvider,
    active: true,
  }

  const db = {
    query: {
      subscriptions: { findFirst: vi.fn().mockResolvedValue(subscriptionData) },
      paymentProviderConfig: { findFirst: vi.fn().mockResolvedValue(paymentProviderConfigData) },
    },
  } as unknown as Database

  const logger = {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger

  const billing = new BillingService({
    db,
    logger,
    analytics: {} as Analytics,
    waitUntil: (p) => p,
    cache: {} as Cache,
    metrics: {} as Metrics,
    customerService,
    grantsManager: {} as GrantsManager,
    ratingService: {} as RatingService,
    ledgerService: {} as LedgerGateway,
    walletService,
  })

  return { billing, provider, customerService, walletService, db }
}

describe("BillingService._collectInvoicePayment", () => {
  beforeEach(() => {
    repoCalls.updateInvoice = []
    repoCalls.findInvoiceById = []
    findInvoiceByIdResult = null
    vi.clearAllMocks()
    settleMock.mockResolvedValue(Ok(undefined))
  })

  it("charge_automatically happy path — provider confirms paid, settles wallet", async () => {
    const invoice = makeInvoice({ status: "unpaid", collectionMethod: "charge_automatically" })
    const provider = makeProviderService({
      getStatusInvoice: vi.fn().mockResolvedValue(Ok({ status: "open", invoiceUrl: "" })),
      collectPayment: vi
        .fn()
        .mockResolvedValue(Ok({ status: "paid", invoiceUrl: "https://stripe.example/paid" })),
    } as unknown as Partial<PaymentProviderService>)
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ status: "paid" })
    expect(provider.collectPayment).toHaveBeenCalledWith({
      invoiceId: "provider_inv_1",
      paymentMethodId: "pm_1",
    })
    expect(settleMock).toHaveBeenCalled()
  })

  it("charge_automatically provider payment pending — updates to unpaid", async () => {
    const invoice = makeInvoice({ status: "unpaid", collectionMethod: "charge_automatically" })
    const provider = makeProviderService({
      getStatusInvoice: vi.fn().mockResolvedValue(Ok({ status: "open", invoiceUrl: "" })),
      collectPayment: vi
        .fn()
        .mockResolvedValue(Ok({ status: "open", invoiceUrl: "https://stripe.example/open" })),
    } as unknown as Partial<PaymentProviderService>)
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ status: "unpaid" })
    expect(settleMock).not.toHaveBeenCalled()
  })

  it("charge_automatically provider already paid — skips collect, settles wallet", async () => {
    const invoice = makeInvoice({ status: "unpaid", collectionMethod: "charge_automatically" })
    const provider = makeProviderService({
      getStatusInvoice: vi
        .fn()
        .mockResolvedValue(
          Ok({ status: "paid", invoiceUrl: "https://stripe.example/paid", paidAt: 1000 })
        ),
      collectPayment: vi.fn(),
    } as unknown as Partial<PaymentProviderService>)
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ status: "paid" })
    expect(provider.collectPayment).not.toHaveBeenCalled()
    expect(settleMock).toHaveBeenCalled()
  })

  it("send_invoice happy path — sends invoice, sets status to waiting", async () => {
    const invoice = makeInvoice({ status: "unpaid", collectionMethod: "send_invoice" })
    const provider = makeProviderService()
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ status: "waiting" })
    expect(provider.sendInvoice).toHaveBeenCalledWith({ invoiceId: "provider_inv_1" })
  })

  it("send_invoice failure — returns Err", async () => {
    const invoice = makeInvoice({ status: "unpaid", collectionMethod: "send_invoice" })
    const provider = makeProviderService({
      sendInvoice: vi
        .fn()
        .mockResolvedValue(Err(new FetchError({ message: "send failed", retry: false }))),
    } as unknown as Partial<PaymentProviderService>)
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("send failed")
  })

  it("draft invoice rejected — cannot collect draft", async () => {
    const invoice = makeInvoice({ status: "draft" })
    const { billing } = makeBillingService({ invoice })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("not finalized")
  })

  it("already paid/void — returns Ok with existing invoice", async () => {
    const invoice = makeInvoice({ status: "paid" })
    const { billing } = makeBillingService({ invoice })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ status: "paid" })
    expect(repoCalls.updateInvoice).toHaveLength(0)
  })

  it("failed invoice rejected — cannot collect failed", async () => {
    const invoice = makeInvoice({ status: "failed" })
    const { billing } = makeBillingService({ invoice })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("failed")
  })

  it("missing provider invoice id — returns Err", async () => {
    const invoice = makeInvoice({ status: "unpaid", invoicePaymentProviderId: "" })
    const { billing } = makeBillingService({ invoice })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("no invoice id from the payment provider")
  })

  it("missing payment method id — returns Err", async () => {
    const invoice = makeInvoice({ status: "unpaid", paymentMethodId: "" })
    const { billing } = makeBillingService({ invoice })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("payment method")
  })

  it("waiting invoice past due — updates to failed", async () => {
    const invoice = makeInvoice({ status: "waiting", pastDueAt: 3_000 })
    const provider = makeProviderService({
      getStatusInvoice: vi.fn().mockResolvedValue(Ok({ status: "open", invoiceUrl: "" })),
    } as unknown as Partial<PaymentProviderService>)
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ status: "failed" })
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({ status: "failed" })
  })

  it("waiting invoice provider paid — updates to paid and settles wallet", async () => {
    const invoice = makeInvoice({ status: "waiting", pastDueAt: 10_000 })
    const provider = makeProviderService({
      getStatusInvoice: vi
        .fn()
        .mockResolvedValue(
          Ok({ status: "paid", invoiceUrl: "https://stripe.example/paid", paidAt: 4_000 })
        ),
    } as unknown as Partial<PaymentProviderService>)
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({ status: "paid" })
    expect(settleMock).toHaveBeenCalledWith({
      walletService: expect.anything(),
      invoice: expect.objectContaining({
        id: "inv_1",
        status: "paid",
        amountDue: 1_000_000_000,
      }),
    })
  })

  it("collect failure — collectPayment returns error, records metadata, returns Err", async () => {
    const invoice = makeInvoice({ status: "unpaid", collectionMethod: "charge_automatically" })
    const provider = makeProviderService({
      getStatusInvoice: vi.fn().mockResolvedValue(Ok({ status: "open", invoiceUrl: "" })),
      collectPayment: vi
        .fn()
        .mockResolvedValue(Err(new FetchError({ message: "card declined", retry: false }))),
    } as unknown as Partial<PaymentProviderService>)
    const { billing } = makeBillingService({ invoice, paymentProvider: provider })

    const result = await collectInvoicePayment(billing, {
      invoiceId: "inv_1",
      projectId: "proj_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("card declined")
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      metadata: expect.objectContaining({
        reason: "payment_failed",
        note: expect.stringContaining("card declined"),
      }),
    })
  })
})
