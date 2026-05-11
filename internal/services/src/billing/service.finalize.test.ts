import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Customer, SubscriptionInvoice } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { dinero } from "dinero.js"
import * as dineroCurrencies from "dinero.js/currencies"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { CustomerService } from "../customers/service"
import type { GrantsManager } from "../entitlements"
import type { InvoiceLine, LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import type { PaymentProviderService } from "../payment-provider/service"
import type { RatingService } from "../rating/service"
import type { SubscriptionMachine } from "../subscriptions/machine"
import { withLockedMachine } from "../subscriptions/withLockedMachine"
import type { WalletService } from "../wallet"
import { BillingService } from "./service"

// `BillingService.finalizeInvoice` runs inside `withLockedMachine` for lock
// management. Tests stub the lock + machine surface so we can assert the
// provider call sequence and metadata side effects directly.
vi.mock("../subscriptions/withLockedMachine", () => ({
  withLockedMachine: vi.fn(
    async (args: {
      run: (m: SubscriptionMachine, assertLockHeld: () => void) => Promise<unknown>
    }) => {
      const machineStub = {
        reportInvoiceSuccess: vi.fn().mockResolvedValue(undefined),
        reportInvoiceFailure: vi.fn().mockResolvedValue(undefined),
      } as unknown as SubscriptionMachine
      // assertLockHeld is a no-op in the default mock — tests that need lock
      // loss behaviour override this mock individually.
      return args.run(machineStub, () => {})
    }
  ),
  LockLostError: class LockLostError extends Error {
    constructor(message = "lock lost") {
      super(message)
      this.name = "LockLostError"
    }
  },
}))

// Repository is invoked via `new DrizzleBillingRepository(db)` inside the
// service. Stub the constructor so the service writes to a controllable
// in-memory record instead of running drizzle queries against `{} as Database`.
type RepoCalls = {
  updateInvoice: Array<{
    invoiceId: string
    projectId: string
    data: Record<string, unknown>
  }>
}
const repoCalls: RepoCalls = { updateInvoice: [] }
const updateInvoiceFailures = new Map<number, Error>()
let updateInvoiceCallCount = 0
const updateInvoiceMock = vi.fn(
  async (input: { invoiceId: string; projectId: string; data: Record<string, unknown> }) => {
    updateInvoiceCallCount += 1
    repoCalls.updateInvoice.push(input)
    const failure = updateInvoiceFailures.get(updateInvoiceCallCount)
    if (failure) {
      updateInvoiceFailures.delete(updateInvoiceCallCount)
      throw failure
    }

    // Echo back a row that satisfies SubscriptionInvoice for the call site —
    // only `id` and `status` are read by the finalize path on the result.
    return {
      id: input.invoiceId,
      projectId: input.projectId,
      status: (input.data.status as string | undefined) ?? "draft",
      ...input.data,
    } as unknown as SubscriptionInvoice
  }
)
vi.mock("./repository.drizzle", () => ({
  DrizzleBillingRepository: vi.fn().mockImplementation(() => ({
    updateInvoice: updateInvoiceMock,
  })),
}))

const usd = dineroCurrencies.USD

function makeCustomer(): Customer {
  return {
    id: "cust_1",
    projectId: "proj_1",
    name: "Test Customer",
    email: "test@example.com",
  } as unknown as Customer
}

function makeInvoice(overrides: Partial<SubscriptionInvoice> = {}): SubscriptionInvoice & {
  customer: Customer
} {
  return {
    id: "inv_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    customerId: "cust_1",
    statementKey: "stmt_1",
    statementDateString: "April 1, 2026",
    status: "draft",
    paymentProvider: "sandbox",
    currency: "USD",
    collectionMethod: "charge_automatically",
    invoicePaymentProviderId: "",
    invoicePaymentProviderUrl: "",
    totalAmount: 1000,
    dueAt: 1_000,
    issueDate: null,
    metadata: null,
    customer: makeCustomer(),
    ...overrides,
  } as unknown as SubscriptionInvoice & { customer: Customer }
}

function makeLine(
  overrides: Partial<InvoiceLine & { metaExtras?: Record<string, unknown> }> = {}
): InvoiceLine {
  const meta = {
    billing_period_id: "bp_1",
    subscription_id: "sub_1",
    subscription_item_id: "item_1",
    cycle_start_at: 100,
    cycle_end_at: 200,
    proration_factor: 1,
    description: "API requests",
    ...(overrides.metaExtras ?? {}),
  }
  return {
    entryId: "ple_1",
    statementKey: "stmt_1",
    kind: "subscription",
    description: "API requests",
    quantity: 10,
    amount: dinero({ amount: 1000, currency: usd }),
    currency: "USD",
    createdAt: new Date(),
    metadata: meta,
    ...overrides,
  } as InvoiceLine
}

function makeProviderItem(
  overrides: Partial<{
    id: string
    amount: number
    currency: "USD"
    quantity: number
    metadata: Record<string, string>
  }> = {}
) {
  return {
    id: overrides.id ?? "ii_1",
    amount: overrides.amount ?? 1000,
    description: "API requests",
    currency: overrides.currency ?? "USD",
    quantity: overrides.quantity ?? 10,
    productId: "prod_1",
    metadata: overrides.metadata ?? {
      billing_period_id: "bp_1",
      subscription_id: "sub_1",
      subscription_item_id: "item_1",
      kind: "subscription",
    },
  }
}

function makeProviderService(): PaymentProviderService {
  return {
    createInvoice: vi.fn().mockResolvedValue(
      Ok({
        invoiceId: "stripe_inv_1",
        invoiceUrl: "https://stripe.example/invoices/stripe_inv_1",
        status: "draft",
        total: 1000,
        items: [],
      })
    ),
    addInvoiceItem: vi.fn().mockResolvedValue(Ok(undefined)),
    updateInvoiceItem: vi.fn().mockResolvedValue(Ok(undefined)),
    finalizeInvoice: vi.fn().mockResolvedValue(Ok({ invoiceId: "stripe_inv_1" })),
    getInvoice: vi.fn().mockImplementation(({ invoiceId }: { invoiceId: string }) =>
      Promise.resolve(
        Ok({
          invoiceId,
          invoiceUrl: `https://stripe.example/invoices/${invoiceId}`,
          status: "open",
          total: 1000,
          items: [makeProviderItem()],
        })
      )
    ),
  } as unknown as PaymentProviderService
}

function makeBillingService(opts: {
  invoice: SubscriptionInvoice & { customer: Customer }
  invoiceReads?: Array<SubscriptionInvoice & { customer: Customer }>
  lines: InvoiceLine[]
  paymentProvider?: PaymentProviderService
  resolveProviderErr?: FetchError
  getInvoiceLinesErr?: FetchError
}) {
  const provider = opts.paymentProvider ?? makeProviderService()

  const customerService = {
    getPaymentProvider: vi
      .fn()
      .mockResolvedValue(
        opts.resolveProviderErr ? { err: opts.resolveProviderErr } : { val: provider }
      ),
  } as unknown as CustomerService

  const ledgerService = {
    getInvoiceLines: vi
      .fn()
      .mockResolvedValue(opts.getInvoiceLinesErr ? Err(opts.getInvoiceLinesErr) : Ok(opts.lines)),
  } as unknown as LedgerGateway

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({ rollback: vi.fn() })
  })

  const invoicesFindFirst = vi.fn()
  const invoiceReads = opts.invoiceReads ?? [opts.invoice]
  for (const invoice of invoiceReads) {
    invoicesFindFirst.mockResolvedValueOnce(invoice)
  }
  invoicesFindFirst.mockResolvedValue(opts.invoice)
  const db = {
    transaction,
    query: { invoices: { findFirst: invoicesFindFirst } },
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
    ledgerService,
    walletService: {} as WalletService,
  })

  return { billing, provider, ledgerService, customerService, db, invoicesFindFirst }
}

describe("BillingService.finalizeInvoice", () => {
  beforeEach(() => {
    repoCalls.updateInvoice = []
    updateInvoiceCallCount = 0
    updateInvoiceFailures.clear()
    vi.clearAllMocks()
  })

  it("happy path: sandbox draft → createInvoice → addInvoiceItem × N → finalizeInvoice → unpaid (LEDGER_SCALE → cents)", async () => {
    // Lines stored at `LEDGER_SCALE = 8` (the wire format ledger entries
    // come back at). Six dollars at scale 8 is 600_000_000; the provider
    // must receive 600 (cents).
    const lines = [
      makeLine({
        entryId: "ple_1",
        amount: dinero({ amount: 600_000_000, currency: usd, scale: 8 }),
      }),
      makeLine({
        entryId: "ple_2",
        amount: dinero({ amount: 400_000_000, currency: usd, scale: 8 }),
      }),
    ]
    const invoice = makeInvoice()
    const { billing, provider } = makeBillingService({ invoice, lines })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      providerInvoiceId: "stripe_inv_1",
      providerInvoiceUrl: "https://stripe.example/invoices/stripe_inv_1",
      invoiceId: "inv_1",
      status: "unpaid",
    })

    // Provider call sequence — and `totalAmount` is quantized to currency
    // minor units (cents), not raw scale-8 minor units.
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.addInvoiceItem).toHaveBeenCalledTimes(2)
    expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1)
    expect(withLockedMachine).toHaveBeenCalledWith(expect.objectContaining({ lock: true }))
    expect(provider.addInvoiceItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        invoiceId: "stripe_inv_1",
        totalAmount: 600,
        period: { start: 100, end: 200 },
      })
    )
    expect(provider.addInvoiceItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        invoiceId: "stripe_inv_1",
        totalAmount: 400,
      })
    )

    // Repo writes: provider id stamped first, then status flip
    expect(repoCalls.updateInvoice).toHaveLength(2)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      invoicePaymentProviderId: "stripe_inv_1",
    })
    expect(repoCalls.updateInvoice[1]?.data).toMatchObject({
      status: "unpaid",
      issueDate: 5_000,
    })
  })

  it("zero-amount invoice skips provider and transitions to void", async () => {
    const invoice = makeInvoice({ totalAmount: 0 })
    const { billing, provider } = makeBillingService({ invoice, lines: [] })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("void")
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.addInvoiceItem).not.toHaveBeenCalled()
    expect(provider.finalizeInvoice).not.toHaveBeenCalled()
    expect(repoCalls.updateInvoice).toHaveLength(1)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      status: "void",
    })
  })

  it("draft invoice before dueAt returns a user-facing error before loading the machine", async () => {
    const invoice = makeInvoice({ dueAt: 10_000 })
    const { billing, provider } = makeBillingService({ invoice, lines: [] })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err?.message).toContain("Invoice is not ready to finalize yet")
    expect(withLockedMachine).not.toHaveBeenCalled()
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(repoCalls.updateInvoice).toHaveLength(0)
  })

  it("reloads the invoice under the subscription lock before provider work", async () => {
    const draftInvoice = makeInvoice()
    const finalizedInvoice = makeInvoice({
      status: "unpaid",
      invoicePaymentProviderId: "stripe_existing",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/existing",
    })
    const { billing, provider, invoicesFindFirst } = makeBillingService({
      invoice: draftInvoice,
      invoiceReads: [draftInvoice, finalizedInvoice],
      lines: [makeLine()],
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      providerInvoiceId: "stripe_existing",
      invoiceId: "inv_1",
      status: "unpaid",
    })
    expect(invoicesFindFirst).toHaveBeenCalledTimes(2)
    expect(withLockedMachine).toHaveBeenCalledWith(expect.objectContaining({ lock: true }))
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.addInvoiceItem).not.toHaveBeenCalled()
    expect(provider.finalizeInvoice).not.toHaveBeenCalled()
    expect(repoCalls.updateInvoice).toHaveLength(0)
  })

  it("provider createInvoice failure bumps metadata.finalizeAttempts and leaves status draft", async () => {
    const invoice = makeInvoice()
    const failingProvider = {
      ...makeProviderService(),
      createInvoice: vi
        .fn()
        .mockResolvedValue(Err(new FetchError({ message: "Stripe rate limit", retry: true }))),
    } as unknown as PaymentProviderService
    const lines = [makeLine()]
    const { billing } = makeBillingService({
      invoice,
      lines,
      paymentProvider: failingProvider,
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()

    // Single repo write: the metadata bump. No status flip, no provider id stamp.
    expect(repoCalls.updateInvoice).toHaveLength(1)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      metadata: expect.objectContaining({
        finalizeAttempts: 1,
        lastFinalizeError: "Stripe rate limit",
      }),
    })
  })

  it("provider addInvoiceItem failure keeps local invoice draft but preserves provider id for retry", async () => {
    const invoice = makeInvoice()
    const failingProvider = {
      ...makeProviderService(),
      addInvoiceItem: vi
        .fn()
        .mockResolvedValue(Err(new FetchError({ message: "Stripe item timeout", retry: true }))),
    } as unknown as PaymentProviderService
    const { billing, provider } = makeBillingService({
      invoice,
      lines: [makeLine()],
      paymentProvider: failingProvider,
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err?.message).toContain("Unable to finalize invoice")
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.finalizeInvoice).not.toHaveBeenCalled()
    expect(repoCalls.updateInvoice).toHaveLength(2)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      invoicePaymentProviderId: "stripe_inv_1",
    })
    expect(repoCalls.updateInvoice[1]?.data).toMatchObject({
      metadata: expect.objectContaining({
        finalizeAttempts: 1,
        lastFinalizeError: "Stripe item timeout",
      }),
    })
  })

  it("provider finalizeInvoice failure keeps local invoice draft for provider retry", async () => {
    const invoice = makeInvoice()
    const failingProvider = {
      ...makeProviderService(),
      finalizeInvoice: vi
        .fn()
        .mockResolvedValue(
          Err(new FetchError({ message: "Stripe finalize timeout", retry: true }))
        ),
    } as unknown as PaymentProviderService
    const { billing, provider } = makeBillingService({
      invoice,
      lines: [makeLine()],
      paymentProvider: failingProvider,
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err?.message).toContain("Unable to finalize invoice")
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.addInvoiceItem).toHaveBeenCalledTimes(1)
    expect(repoCalls.updateInvoice).toHaveLength(2)
    expect(repoCalls.updateInvoice[1]?.data).toMatchObject({
      metadata: expect.objectContaining({
        finalizeAttempts: 1,
        lastFinalizeError: "Stripe finalize timeout",
      }),
    })
  })

  it("local status update failure after provider finalization retries without duplicate provider work", async () => {
    updateInvoiceFailures.set(2, new Error("database connection lost"))
    const provider = makeProviderService()
    const firstInvoice = makeInvoice()
    const first = makeBillingService({
      invoice: firstInvoice,
      lines: [makeLine()],
      paymentProvider: provider,
    })

    const firstResult = await first.billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(firstResult.err?.message).toContain("Unable to finalize invoice")
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.addInvoiceItem).toHaveBeenCalledTimes(1)
    expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1)
    expect(repoCalls.updateInvoice).toHaveLength(2)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      invoicePaymentProviderId: "stripe_inv_1",
    })
    expect(repoCalls.updateInvoice[1]?.data).toMatchObject({
      status: "unpaid",
    })

    const retryInvoice = makeInvoice({
      invoicePaymentProviderId: "stripe_inv_1",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/stripe_inv_1",
    })
    const retry = makeBillingService({
      invoice: retryInvoice,
      lines: [makeLine()],
      paymentProvider: provider,
    })

    const retryResult = await retry.billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 6_000,
    })

    expect(retryResult.err).toBeUndefined()
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.addInvoiceItem).toHaveBeenCalledTimes(1)
    expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1)
    expect(provider.getInvoice).toHaveBeenCalledWith({ invoiceId: "stripe_inv_1" })
    expect(repoCalls.updateInvoice).toHaveLength(3)
    expect(repoCalls.updateInvoice[2]?.data).toMatchObject({
      status: "unpaid",
      invoicePaymentProviderId: "stripe_inv_1",
      issueDate: 6_000,
    })
  })

  it("draft provider invoice retry reconciles missing items and finalizes before local status flip", async () => {
    const invoice = makeInvoice({
      invoicePaymentProviderId: "stripe_existing",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/existing",
    })
    const retryProvider = {
      ...makeProviderService(),
      getInvoice: vi.fn().mockResolvedValue(
        Ok({
          invoiceId: "stripe_existing",
          invoiceUrl: "https://stripe.example/invoices/existing",
          status: "draft",
          total: 0,
          items: [],
        })
      ),
    } as unknown as PaymentProviderService
    const { billing, provider } = makeBillingService({
      invoice,
      lines: [makeLine()],
      paymentProvider: retryProvider,
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.getInvoice).toHaveBeenCalledWith({ invoiceId: "stripe_existing" })
    expect(provider.addInvoiceItem).toHaveBeenCalledTimes(1)
    expect(provider.finalizeInvoice).toHaveBeenCalledWith({ invoiceId: "stripe_existing" })
    expect(repoCalls.updateInvoice).toHaveLength(1)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      status: "unpaid",
      invoicePaymentProviderId: "stripe_existing",
    })
  })

  it("draft provider invoice retry reuses matching provider items without duplicating them", async () => {
    const invoice = makeInvoice({
      invoicePaymentProviderId: "stripe_existing",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/existing",
    })
    const retryProvider = {
      ...makeProviderService(),
      getInvoice: vi.fn().mockResolvedValue(
        Ok({
          invoiceId: "stripe_existing",
          invoiceUrl: "https://stripe.example/invoices/existing",
          status: "draft",
          total: 1000,
          items: [makeProviderItem()],
        })
      ),
    } as unknown as PaymentProviderService
    const { billing, provider } = makeBillingService({
      invoice,
      lines: [makeLine()],
      paymentProvider: retryProvider,
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.addInvoiceItem).not.toHaveBeenCalled()
    expect(provider.updateInvoiceItem).not.toHaveBeenCalled()
    expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1)
    expect(repoCalls.updateInvoice).toHaveLength(1)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({ status: "unpaid" })
  })

  it("already-open stamped provider id skips provider mutation and proceeds to local status flip", async () => {
    const invoice = makeInvoice({
      invoicePaymentProviderId: "stripe_existing",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/existing",
    })
    const { billing, provider } = makeBillingService({ invoice, lines: [makeLine()] })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.getInvoice).toHaveBeenCalledWith({ invoiceId: "stripe_existing" })
    expect(provider.addInvoiceItem).not.toHaveBeenCalled()
    expect(provider.finalizeInvoice).not.toHaveBeenCalled()
    expect(repoCalls.updateInvoice).toHaveLength(1)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({ status: "unpaid" })
  })

  it("already-past-draft invoice returns early with no provider work", async () => {
    const invoice = makeInvoice({
      status: "unpaid",
      invoicePaymentProviderId: "stripe_existing",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/existing",
    })
    const { billing, provider } = makeBillingService({ invoice, lines: [] })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("unpaid")
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(repoCalls.updateInvoice).toHaveLength(0)
  })

  it("non-zero invoice with no ledger lines surfaces a data integrity error", async () => {
    const invoice = makeInvoice({ totalAmount: 1000 })
    const { billing, provider } = makeBillingService({ invoice, lines: [] })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    expect(result.err).toBeDefined()
    expect(result.err?.message).toMatch(/No ledger lines/)
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  it("orphaned provider items with no matching ledger line trigger a warning", async () => {
    // Simulate a retry where the provider invoice already has items from a
    // previous partial attempt. One item matches a current ledger line (and
    // gets reconciled), but the other has no counterpart in the ledger.
    const orphanItem = makeProviderItem({
      id: "ii_orphan",
      metadata: {
        billing_period_id: "bp_old",
        subscription_id: "sub_1",
        subscription_item_id: "item_old",
        kind: "subscription",
      },
    })
    const matchedItem = makeProviderItem({
      id: "ii_matched",
      metadata: {
        billing_period_id: "bp_1",
        subscription_id: "sub_1",
        subscription_item_id: "item_1",
        kind: "subscription",
      },
    })

    const invoice = makeInvoice({
      invoicePaymentProviderId: "stripe_existing",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/existing",
    })
    const retryProvider = {
      ...makeProviderService(),
      getInvoice: vi.fn().mockResolvedValue(
        Ok({
          invoiceId: "stripe_existing",
          invoiceUrl: "https://stripe.example/invoices/existing",
          status: "draft",
          total: 2000,
          items: [matchedItem, orphanItem],
        })
      ),
    } as unknown as PaymentProviderService
    const { billing, provider } = makeBillingService({
      invoice,
      lines: [makeLine()],
      paymentProvider: retryProvider,
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    // Finalization still succeeds — orphans are warned about, not fatal.
    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      providerInvoiceId: "stripe_existing",
      status: "unpaid",
    })

    // The matched item should not be re-added or updated (already reconciled).
    expect(provider.addInvoiceItem).not.toHaveBeenCalled()
    expect(provider.updateInvoiceItem).not.toHaveBeenCalled()
    expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1)

    // Logger should have warned about the orphan item.
    // Access the logger from the original billing service via the service bag.
    const loggerWarn = (billing as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger
      .warn
    expect(loggerWarn).toHaveBeenCalledWith(
      "provider invoice has orphaned items with no matching ledger line",
      expect.objectContaining({
        invoiceId: "inv_1",
        providerInvoiceId: "stripe_existing",
        orphanedItemCount: 1,
        orphanedItemIds: ["ii_orphan"],
      })
    )
  })

  it("provider 404 on stamped invoice clears id and recreates a fresh provider invoice", async () => {
    // The invoice has a stamped provider id from a previous attempt, but the
    // provider returns a 404 (invoice was deleted externally).
    const invoice = makeInvoice({
      invoicePaymentProviderId: "stripe_deleted",
      invoicePaymentProviderUrl: "https://stripe.example/invoices/deleted",
    })
    const provider404 = {
      ...makeProviderService(),
      getInvoice: vi
        .fn()
        .mockResolvedValue(
          Err(new FetchError({ message: "No such invoice: stripe_deleted", retry: false }))
        ),
    } as unknown as PaymentProviderService
    const { billing, provider } = makeBillingService({
      invoice,
      lines: [makeLine()],
      paymentProvider: provider404,
    })

    const result = await billing.finalizeInvoice({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      now: 5_000,
    })

    // Should succeed by creating a brand-new provider invoice.
    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      providerInvoiceId: "stripe_inv_1",
      providerInvoiceUrl: "https://stripe.example/invoices/stripe_inv_1",
      invoiceId: "inv_1",
      status: "unpaid",
    })

    // getInvoice was called first (and failed), then createInvoice.
    expect(provider.getInvoice).toHaveBeenCalledWith({ invoiceId: "stripe_deleted" })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.addInvoiceItem).toHaveBeenCalledTimes(1)
    expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1)

    // Repo writes: first the new provider id stamp, then the status flip.
    expect(repoCalls.updateInvoice).toHaveLength(2)
    expect(repoCalls.updateInvoice[0]?.data).toMatchObject({
      invoicePaymentProviderId: "stripe_inv_1",
    })
    expect(repoCalls.updateInvoice[1]?.data).toMatchObject({
      status: "unpaid",
    })

    // Logger should have warned about the stale stamped id.
    const loggerWarn = (billing as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger
      .warn
    expect(loggerWarn).toHaveBeenCalledWith(
      "stamped provider invoice could not be retrieved; recreating",
      expect.objectContaining({
        invoiceId: "inv_1",
        providerInvoiceId: "stripe_deleted",
      })
    )
  })
})
