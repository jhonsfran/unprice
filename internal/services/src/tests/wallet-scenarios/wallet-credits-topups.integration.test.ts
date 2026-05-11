import { sql } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { LedgerGateway } from "../../ledger"
import type {
  CreateSessionOpts,
  NormalizedProviderWebhook,
  VerifiedProviderWebhook,
} from "../../payment-provider/interface"
import type { PaymentProviderService } from "../../payment-provider/service"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { processWebhookEvent } from "../../use-cases/payment-provider/process-webhook-event"
import { initiateTopup } from "../../use-cases/wallet/initiate-topup"
import { UnPriceWalletError, WalletService } from "../../wallet"

const db = createTestDatabaseConnection()

const fixtures = ["base-project.sql", "customer-active.sql"]

const projectId = "proj_test"
const customerId = "cus_test"
const currency = "EUR"
const euro = 100_000_000
const jan1 = new Date("2026-01-01T00:00:00.000Z")
const feb1 = new Date("2026-02-01T00:00:00.000Z")

function createLogger(): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

class WalletTopupProvider {
  readonly provider = "sandbox" as const
  readonly sessionId = "cs_wallet_topup_test"
  readonly checkoutUrl = "https://provider.example/topups/cs_wallet_topup_test"
  amountPaid = 25 * euro
  metadataOverride: Record<string, string> = {}
  createSessionOpts: CreateSessionOpts | null = null

  createSession = vi.fn(async (opts: CreateSessionOpts) => {
    this.createSessionOpts = opts
    return Ok({
      customerId: opts.customerId,
      sessionId: this.sessionId,
      success: true,
      url: this.checkoutUrl,
    })
  })

  verifyWebhook = vi.fn(async ({ rawBody }: { rawBody: string }) => {
    const parsed = JSON.parse(rawBody) as { id?: string; type?: string }
    return Ok({
      eventId: parsed.id ?? "evt_wallet_topup",
      eventType: parsed.type ?? "checkout.session.completed",
      occurredAt: Date.parse("2026-01-01T12:00:00.000Z"),
      payload: parsed,
    } satisfies VerifiedProviderWebhook)
  })

  normalizeWebhook = vi.fn((event: VerifiedProviderWebhook) => {
    return Ok({
      amountPaid: this.amountPaid,
      eventId: event.eventId,
      eventType: "payment.succeeded",
      metadata: {
        ...(this.createSessionOpts?.metadata ?? {}),
        ...this.metadataOverride,
      },
      occurredAt: event.occurredAt,
      payload: event.payload,
      provider: this.provider,
      providerEventType: event.eventType,
      providerSessionId: this.sessionId,
    } satisfies NormalizedProviderWebhook)
  })
}

function createServices(provider?: WalletTopupProvider) {
  const logger = createLogger()
  const ledger = new LedgerGateway({ db, logger })
  const wallet = new WalletService({ db, logger, ledgerGateway: ledger })
  const topupProvider = provider ?? new WalletTopupProvider()
  const customers = {
    getPaymentProvider: vi
      .fn()
      .mockResolvedValue(Ok(topupProvider as unknown as PaymentProviderService)),
  }

  return {
    customers,
    ledger,
    logger,
    provider: topupProvider,
    wallet,
  }
}

function processTopupWebhook(input: {
  customers: { getPaymentProvider: ReturnType<typeof vi.fn> }
  eventId: string
  logger: Logger
  wallet: WalletService
}) {
  return processWebhookEvent(
    {
      analytics: { ingestEvents: vi.fn() } as never,
      db,
      logger: input.logger,
      services: {
        customers: input.customers,
        subscriptions: { reconcilePaymentOutcome: vi.fn() },
        wallet: input.wallet,
      } as unknown as Pick<ServiceContext, "customers" | "subscriptions" | "wallet">,
      waitUntil: vi.fn(),
    },
    {
      headers: {},
      projectId,
      provider: "sandbox",
      rawBody: JSON.stringify({ id: input.eventId, type: "checkout.session.completed" }),
    }
  )
}

function walletWithFirstTopupSettlementFailure(realWallet: WalletService) {
  type SettleTopUpArgs = Parameters<WalletService["settleTopUp"]>
  type SettleTopUpReturn = ReturnType<WalletService["settleTopUp"]>

  let failuresRemaining = 1
  const settleTopUp = vi.fn((...args: SettleTopUpArgs): SettleTopUpReturn => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      return Promise.resolve(
        Err(new UnPriceWalletError({ message: "WALLET_LEDGER_FAILED" }))
      ) as SettleTopUpReturn
    }

    return realWallet.settleTopUp(...args)
  })

  return new Proxy(realWallet, {
    get(target, prop, receiver) {
      if (prop === "settleTopUp") {
        return settleTopUp
      }

      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as WalletService & { settleTopUp: typeof settleTopUp }
}

describe("wallet credits and top-ups DB-backed lifecycle", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("issues wallet credits, drains them FIFO into reservations, and releases unused granted funds without invoice credits", async () => {
    const { wallet } = createServices()

    const promo = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      expiresAt: new Date("2026-03-01T00:00:00.000Z"),
      idempotencyKey: "wallet-credit-test:promo",
      projectId,
      reason: "welcome credit",
      signedAmount: 3 * euro,
      source: "promo",
    })
    const creditLine = await wallet.adjust({
      actorId: "system:subscription-activation",
      currency,
      customerId,
      expiresAt: feb1,
      idempotencyKey: "wallet-credit-test:credit-line",
      projectId,
      reason: "period credit line",
      signedAmount: 5 * euro,
      source: "credit_line",
    })
    const promoReplay = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      expiresAt: new Date("2026-03-01T00:00:00.000Z"),
      idempotencyKey: "wallet-credit-test:promo",
      projectId,
      reason: "welcome credit",
      signedAmount: 3 * euro,
      source: "promo",
    })

    expect(promo.err).toBeUndefined()
    expect(creditLine.err).toBeUndefined()
    expect(promoReplay.err).toBeUndefined()
    expect(promoReplay.val?.grantId).toBe(promo.val?.grantId)

    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [creditLine.val?.grantId, promo.val?.grantId],
      granted: 8 * euro,
      purchased: 0,
      reserved: 0,
    })
    await expectWalletCreditRows([
      {
        id: creditLine.val?.grantId,
        issued_amount: 5 * euro,
        remaining_amount: 5 * euro,
        source: "credit_line",
      },
      {
        id: promo.val?.grantId,
        issued_amount: 3 * euro,
        remaining_amount: 3 * euro,
        source: "promo",
      },
    ])
    await expectLedgerSourceCounts([{ count: 2, source_type: "wallet_adjust" }])

    const reservation = await wallet.createReservation({
      currency,
      customerId,
      effectiveAt: jan1,
      entitlementId: "ent_wallet_credit_test",
      idempotencyKey: "wallet-credit-test:reserve",
      metadata: { owner: "wallet-credit-integration" },
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 6 * euro,
    })

    expect(reservation.err).toBeUndefined()
    expect(reservation.val).toMatchObject({
      allocationAmount: 6 * euro,
      drainLegs: [
        {
          amount: 5 * euro,
          grantId: creditLine.val?.grantId,
          grantSource: "credit_line",
          source: "granted",
        },
        {
          amount: 1 * euro,
          grantId: promo.val?.grantId,
          grantSource: "promo",
          source: "granted",
        },
      ],
    })

    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [promo.val?.grantId],
      granted: 2 * euro,
      purchased: 0,
      reserved: 6 * euro,
    })
    await expectWalletCreditRows([
      {
        id: creditLine.val?.grantId,
        issued_amount: 5 * euro,
        remaining_amount: 0,
        source: "credit_line",
      },
      {
        id: promo.val?.grantId,
        issued_amount: 3 * euro,
        remaining_amount: 2 * euro,
        source: "promo",
      },
    ])

    const promoBalance = await wallet.getWalletCreditBalance({
      customerId,
      projectId,
      walletId: promo.val?.grantId ?? "",
    })
    expect(promoBalance.err).toBeUndefined()
    expect(promoBalance.val?.remainingAmount).toBe(2 * euro)

    const reservationId = reservation.val?.reservationId
    expect(reservationId).toBeDefined()
    if (!reservationId) return

    const flush = await wallet.flushReservation({
      currency,
      customerId,
      final: true,
      flushAmount: 250_000_000,
      flushSeq: 1,
      metadata: { owner: "wallet-credit-integration" },
      projectId,
      refillChunkAmount: 0,
      reservationId,
      statementKey: "stmt_wallet_credit_test",
    })

    expect(flush.err).toBeUndefined()
    expect(flush.val).toMatchObject({
      flushedAmount: 250_000_000,
      grantedAmount: 0,
      refundedAmount: 0,
    })

    await expectWalletState(wallet, {
      consumed: 250_000_000,
      creditIds: [promo.val?.grantId],
      granted: 2 * euro,
      purchased: 0,
      reserved: 0,
    })
    await expectReservationClosed({
      allocationAmount: 6 * euro,
      consumedAmount: 250_000_000,
      reservationId,
    })
    await expectLedgerSourceCounts([
      { count: 2, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_flush_consume" },
      { count: 2, source_type: "wallet_release_granted" },
      { count: 1, source_type: "wallet_reserve_granted" },
    ])
  })

  it("initiates a top-up, settles it from a real webhook row, and keeps replay idempotent", async () => {
    const { customers, logger, provider, wallet } = createServices()
    const amount = 25 * euro

    const initiated = await initiateTopup(
      {
        db,
        logger,
        services: { customers } as unknown as Pick<ServiceContext, "customers">,
      },
      {
        amount,
        cancelUrl: "https://app.example.com/cancel",
        currency,
        customerId,
        description: "Add wallet balance",
        projectId,
        provider: "sandbox",
        successUrl: "https://app.example.com/success",
      }
    )

    expect(initiated.err).toBeUndefined()
    expect(initiated.val).toEqual({
      checkoutUrl: provider.checkoutUrl,
      providerSessionId: provider.sessionId,
      topupId: expect.stringMatching(/^wtup_/),
    })
    expect(provider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amount,
        kind: "wallet_topup",
        metadata: expect.objectContaining({
          currency,
          customer_id: customerId,
          kind: "wallet_topup",
          project_id: projectId,
          requested_amount: String(amount),
          topup_id: initiated.val?.topupId,
        }),
      })
    )
    await expectTopupRow({
      id: initiated.val?.topupId,
      ledgerTransferId: null,
      providerSessionId: provider.sessionId,
      requestedAmount: amount,
      settledAmount: null,
      status: "pending",
    })

    const firstWebhook = await processTopupWebhook({
      customers,
      eventId: "evt_topup_settled_1",
      logger,
      wallet,
    })

    expect(firstWebhook.err).toBeUndefined()
    expect(firstWebhook.val).toMatchObject({
      outcome: "wallet_topup_settled",
      providerEventId: "evt_topup_settled_1",
      status: "processed",
      topupId: initiated.val?.topupId,
    })
    await expectTopupRow({
      id: initiated.val?.topupId,
      providerSessionId: provider.sessionId,
      requestedAmount: amount,
      settledAmount: amount,
      status: "completed",
    })
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: amount,
      reserved: 0,
    })
    await expectLedgerSourceCounts([{ count: 1, source_type: "wallet_topup" }])
    await expectWebhookRows([
      { attempts: 1, provider_event_id: "evt_topup_settled_1", status: "processed" },
    ])

    const secondProviderEvent = await processTopupWebhook({
      customers,
      eventId: "evt_topup_settled_2",
      logger,
      wallet,
    })

    expect(secondProviderEvent.err).toBeUndefined()
    expect(secondProviderEvent.val).toMatchObject({
      outcome: "wallet_topup_settled",
      providerEventId: "evt_topup_settled_2",
      status: "processed",
      topupId: initiated.val?.topupId,
    })
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: amount,
      reserved: 0,
    })
    await expectLedgerSourceCounts([{ count: 1, source_type: "wallet_topup" }])

    const duplicate = await processTopupWebhook({
      customers,
      eventId: "evt_topup_settled_2",
      logger,
      wallet,
    })

    expect(duplicate.err).toBeUndefined()
    expect(duplicate.val).toMatchObject({
      providerEventId: "evt_topup_settled_2",
      status: "duplicate",
    })
    await expectWebhookRows([
      { attempts: 1, provider_event_id: "evt_topup_settled_1", status: "processed" },
      { attempts: 1, provider_event_id: "evt_topup_settled_2", status: "processed" },
    ])
    await expectLedgerSourceCounts([{ count: 1, source_type: "wallet_topup" }])
  })

  it("keeps a top-up pending after settlement failure and recovers on provider retry", async () => {
    const { customers, logger, provider, wallet } = createServices()
    const failingWallet = walletWithFirstTopupSettlementFailure(wallet)
    const amount = 15 * euro
    provider.amountPaid = amount

    const initiated = await initiateTopup(
      {
        db,
        logger,
        services: { customers } as unknown as Pick<ServiceContext, "customers">,
      },
      {
        amount,
        cancelUrl: "https://app.example.com/cancel",
        currency,
        customerId,
        projectId,
        provider: "sandbox",
        successUrl: "https://app.example.com/success",
      }
    )
    expect(initiated.err).toBeUndefined()

    const failed = await processTopupWebhook({
      customers,
      eventId: "evt_topup_retry",
      logger,
      wallet: failingWallet,
    })

    expect(failed.err?.message).toBe("Wallet top-up settlement failed: WALLET_LEDGER_FAILED")
    await expectTopupRow({
      id: initiated.val?.topupId,
      ledgerTransferId: null,
      providerSessionId: provider.sessionId,
      requestedAmount: amount,
      settledAmount: null,
      status: "pending",
    })
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: 0,
      reserved: 0,
    })
    await expectWebhookRows([
      { attempts: 1, provider_event_id: "evt_topup_retry", status: "failed" },
    ])
    await expectLedgerSourceCounts([])

    const retry = await processTopupWebhook({
      customers,
      eventId: "evt_topup_retry",
      logger,
      wallet: failingWallet,
    })

    expect(retry.err).toBeUndefined()
    expect(retry.val).toMatchObject({
      outcome: "wallet_topup_settled",
      providerEventId: "evt_topup_retry",
      status: "processed",
      topupId: initiated.val?.topupId,
    })
    await expectTopupRow({
      id: initiated.val?.topupId,
      providerSessionId: provider.sessionId,
      requestedAmount: amount,
      settledAmount: amount,
      status: "completed",
    })
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: amount,
      reserved: 0,
    })
    await expectWebhookRows([
      { attempts: 2, provider_event_id: "evt_topup_retry", status: "processed" },
    ])
    await expectLedgerSourceCounts([{ count: 1, source_type: "wallet_topup" }])
  })

  it("reserves mixed granted and top-up purchased funds, then refunds only purchased leftovers", async () => {
    const { wallet } = createServices()

    const credit = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      expiresAt: feb1,
      idempotencyKey: "wallet-mixed:promo",
      projectId,
      reason: "mixed funding credit",
      signedAmount: 4 * euro,
      source: "promo",
    })
    expect(credit.err).toBeUndefined()

    await insertPendingTopup({
      id: "wtup_mixed",
      providerSessionId: "cs_mixed",
      requestedAmount: 6 * euro,
    })
    const topup = await wallet.settleTopUp({
      currency,
      customerId,
      idempotencyKey: "topup:evt_mixed",
      paidAmount: 6 * euro,
      projectId,
      providerSessionId: "cs_mixed",
    })
    expect(topup.err).toBeUndefined()

    const reservation = await wallet.createReservation({
      currency,
      customerId,
      effectiveAt: jan1,
      entitlementId: "ent_wallet_mixed",
      idempotencyKey: "wallet-mixed:reserve",
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 8 * euro,
    })

    expect(reservation.err).toBeUndefined()
    expect(reservation.val).toMatchObject({
      allocationAmount: 8 * euro,
      drainLegs: [
        {
          amount: 4 * euro,
          grantId: credit.val?.grantId,
          grantSource: "promo",
          source: "granted",
        },
        { amount: 4 * euro, source: "purchased" },
      ],
    })
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: 2 * euro,
      reserved: 8 * euro,
    })

    const reservationId = reservation.val?.reservationId
    expect(reservationId).toBeDefined()
    if (!reservationId) return

    const flush = await wallet.flushReservation({
      currency,
      customerId,
      final: true,
      flushAmount: 3 * euro,
      flushSeq: 1,
      projectId,
      refillChunkAmount: 0,
      reservationId,
      statementKey: "stmt_wallet_mixed",
    })

    expect(flush.err).toBeUndefined()
    expect(flush.val).toMatchObject({
      flushedAmount: 3 * euro,
      grantedAmount: 0,
      refundedAmount: 4 * euro,
    })
    await expectWalletState(wallet, {
      consumed: 3 * euro,
      creditIds: [],
      granted: 0,
      purchased: 6 * euro,
      reserved: 0,
    })
    await expectLedgerSourceCounts([
      { count: 1, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_capture_refund" },
      { count: 1, source_type: "wallet_flush_consume" },
      { count: 1, source_type: "wallet_release_granted" },
      { count: 1, source_type: "wallet_reserve_granted" },
      { count: 1, source_type: "wallet_reserve_purchased" },
      { count: 1, source_type: "wallet_topup" },
    ])
  })

  it("keeps final flush recovery idempotent against real reservation and ledger rows", async () => {
    const { wallet } = createServices()

    const credit = await wallet.adjust({
      actorId: "system:reservation-recovery",
      currency,
      customerId,
      expiresAt: feb1,
      idempotencyKey: "wallet-final-recovery:credit",
      projectId,
      reason: "final flush recovery credit",
      signedAmount: 10 * euro,
      source: "credit_line",
    })
    expect(credit.err).toBeUndefined()

    const reservation = await wallet.createReservation({
      currency,
      customerId,
      effectiveAt: jan1,
      entitlementId: "ent_wallet_final_recovery",
      idempotencyKey: "wallet-final-recovery:reserve",
      metadata: { owner: "final-flush-recovery" },
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 6 * euro,
    })
    expect(reservation.err).toBeUndefined()

    const reservationId = reservation.val?.reservationId
    expect(reservationId).toBeDefined()
    if (!reservationId) return

    const finalFlush = await wallet.flushReservation({
      currency,
      customerId,
      final: true,
      flushAmount: 2 * euro,
      flushSeq: 7,
      metadata: { owner: "final-flush-recovery" },
      projectId,
      refillChunkAmount: 0,
      reservationId,
      statementKey: "stmt_wallet_final_recovery",
    })
    expect(finalFlush.err).toBeUndefined()
    expect(finalFlush.val).toMatchObject({
      flushedAmount: 2 * euro,
      grantedAmount: 0,
      refundedAmount: 0,
    })

    const replay = await wallet.flushReservation({
      currency,
      customerId,
      final: true,
      flushAmount: 2 * euro,
      flushSeq: 7,
      metadata: { owner: "final-flush-recovery" },
      projectId,
      refillChunkAmount: 0,
      reservationId,
      statementKey: "stmt_wallet_final_recovery",
    })
    expect(replay.err?.message).toBe("WALLET_RESERVATION_ALREADY_RECONCILED")

    await expectWalletState(wallet, {
      consumed: 2 * euro,
      creditIds: [credit.val?.grantId],
      granted: 4 * euro,
      purchased: 0,
      reserved: 0,
    })
    await expectWalletCreditRows([
      {
        id: credit.val?.grantId,
        issued_amount: 10 * euro,
        remaining_amount: 4 * euro,
        source: "credit_line",
      },
    ])
    await expectReservationClosed({
      allocationAmount: 6 * euro,
      consumedAmount: 2 * euro,
      drainLegCount: 1,
      reservationId,
    })
    await expectLedgerSourceCounts([
      { count: 1, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_flush_consume" },
      { count: 1, source_type: "wallet_release_granted" },
      { count: 1, source_type: "wallet_reserve_granted" },
    ])
  })

  it("expires remaining wallet credits by clawing back granted balance and marking the row expired", async () => {
    const { wallet } = createServices()
    const issued = await wallet.adjust({
      actorId: "system:expiration-test",
      currency,
      customerId,
      expiresAt: new Date("2026-01-15T00:00:00.000Z"),
      idempotencyKey: "wallet-expire:grant",
      projectId,
      reason: "expiring credit",
      signedAmount: 4 * euro,
      source: "promo",
    })
    expect(issued.err).toBeUndefined()

    const grantId = issued.val?.grantId
    expect(grantId).toBeDefined()
    if (!grantId) return

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${customerId}`}))`)
      const expired = await wallet.expireGrant(tx, {
        amount: 4 * euro,
        currency,
        customerId,
        grantId,
        idempotencyKey: `expire:${grantId}`,
        projectId,
        source: "promo",
      })
      expect(expired.err).toBeUndefined()
      await tx.execute(sql`
        UPDATE unprice_wallet_credits
        SET remaining_amount = 0,
            expired_at = ${feb1}
        WHERE project_id = ${projectId}
          AND id = ${grantId}
      `)
    })

    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: 0,
      reserved: 0,
    })
    await expectExpiredCreditRow({ id: grantId, remainingAmount: 0 })
    await expectLedgerSourceCounts([
      { count: 1, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_expire_grant" },
    ])
  })

  it("clamps negative adjustments and drains granted credits FIFO without negative balances", async () => {
    const { wallet } = createServices()

    await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      idempotencyKey: "wallet-negative:purchased-positive",
      projectId,
      reason: "manual purchased credit",
      signedAmount: 2 * euro,
      source: "purchased",
    })
    const purchasedDebit = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      idempotencyKey: "wallet-negative:purchased-negative",
      projectId,
      reason: "manual purchased clawback",
      signedAmount: -5 * euro,
      source: "purchased",
    })
    expect(purchasedDebit.err).toBeUndefined()
    expect(purchasedDebit.val).toMatchObject({
      clampedAmount: 2 * euro,
      unclampedRemainder: 3 * euro,
    })

    const firstCredit = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      expiresAt: new Date("2027-02-01T00:00:00.000Z"),
      idempotencyKey: "wallet-negative:promo-first",
      projectId,
      reason: "first promo",
      signedAmount: 2 * euro,
      source: "promo",
    })
    const secondCredit = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      expiresAt: new Date("2027-03-01T00:00:00.000Z"),
      idempotencyKey: "wallet-negative:promo-second",
      projectId,
      reason: "second promo",
      signedAmount: 3 * euro,
      source: "promo",
    })
    const grantedDebit = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      idempotencyKey: "wallet-negative:promo-negative",
      projectId,
      reason: "promo clawback",
      signedAmount: -4 * euro,
      source: "promo",
    })

    expect(firstCredit.err).toBeUndefined()
    expect(secondCredit.err).toBeUndefined()
    expect(grantedDebit.err).toBeUndefined()
    expect(grantedDebit.val).toMatchObject({
      clampedAmount: 4 * euro,
      unclampedRemainder: 0,
    })

    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [secondCredit.val?.grantId],
      granted: 1 * euro,
      purchased: 0,
      reserved: 0,
    })
    await expectWalletCreditRows([
      {
        id: firstCredit.val?.grantId,
        issued_amount: 2 * euro,
        remaining_amount: 0,
        source: "promo",
      },
      {
        id: secondCredit.val?.grantId,
        issued_amount: 3 * euro,
        remaining_amount: 1 * euro,
        source: "promo",
      },
    ])
    await expectLedgerSourceCounts([{ count: 5, source_type: "wallet_adjust" }])
  })

  it("keeps parallel wallet operations idempotent under customer locks", async () => {
    const { wallet } = createServices()
    const seeded = await wallet.ensureCustomerAccounts({ projectId, customerId, currency })
    expect(seeded.err).toBeUndefined()

    const [firstAdjust, secondAdjust] = await Promise.all([
      wallet.adjust({
        actorId: "admin_1",
        currency,
        customerId,
        expiresAt: feb1,
        idempotencyKey: "wallet-idem:adjust",
        projectId,
        reason: "parallel credit",
        signedAmount: 5 * euro,
        source: "promo",
      }),
      wallet.adjust({
        actorId: "admin_1",
        currency,
        customerId,
        expiresAt: feb1,
        idempotencyKey: "wallet-idem:adjust",
        projectId,
        reason: "parallel credit",
        signedAmount: 5 * euro,
        source: "promo",
      }),
    ])

    expect(firstAdjust.err).toBeUndefined()
    expect(secondAdjust.err).toBeUndefined()
    expect(firstAdjust.val?.grantId).toBe(secondAdjust.val?.grantId)

    await insertPendingTopup({
      id: "wtup_idem",
      providerSessionId: "cs_idem",
      requestedAmount: 5 * euro,
    })
    const [firstTopup, secondTopup] = await Promise.all([
      wallet.settleTopUp({
        currency,
        customerId,
        idempotencyKey: "topup:evt_idem",
        paidAmount: 5 * euro,
        projectId,
        providerSessionId: "cs_idem",
      }),
      wallet.settleTopUp({
        currency,
        customerId,
        idempotencyKey: "topup:evt_idem",
        paidAmount: 5 * euro,
        projectId,
        providerSessionId: "cs_idem",
      }),
    ])

    expect(firstTopup.err).toBeUndefined()
    expect(secondTopup.err).toBeUndefined()
    expect(firstTopup.val?.ledgerTransferId).toBe(secondTopup.val?.ledgerTransferId)

    const reservationInput: Parameters<WalletService["createReservation"]>[0] = {
      currency,
      customerId,
      effectiveAt: jan1,
      entitlementId: "ent_wallet_idem",
      idempotencyKey: "wallet-idem:reserve",
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 3 * euro,
    }
    const [firstReservation, secondReservation] = await Promise.all([
      wallet.createReservation(reservationInput),
      wallet.createReservation(reservationInput),
    ])

    expect(firstReservation.err).toBeUndefined()
    expect(secondReservation.err).toBeUndefined()
    expect(firstReservation.val?.reservationId).toBe(secondReservation.val?.reservationId)
    expect([firstReservation.val?.reused, secondReservation.val?.reused].sort()).toEqual([
      "active",
      undefined,
    ])

    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [firstAdjust.val?.grantId],
      granted: 2 * euro,
      purchased: 5 * euro,
      reserved: 3 * euro,
    })
    await expectRowCount("unprice_wallet_credits", 1)
    await expectRowCount("unprice_wallet_topups", 1)
    await expectRowCount("unprice_entitlement_reservations", 1)
    await expectLedgerSourceCounts([
      { count: 1, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_reserve_granted" },
      { count: 1, source_type: "wallet_topup" },
    ])
  })

  it("ignores a top-up webhook whose metadata project does not match the route project", async () => {
    const { customers, logger, provider, wallet } = createServices()
    provider.metadataOverride = { project_id: "proj_other" }

    const initiated = await initiateTopup(
      {
        db,
        logger,
        services: { customers } as unknown as Pick<ServiceContext, "customers">,
      },
      {
        amount: 10 * euro,
        cancelUrl: "https://app.example.com/cancel",
        currency,
        customerId,
        projectId,
        provider: "sandbox",
        successUrl: "https://app.example.com/success",
      }
    )
    expect(initiated.err).toBeUndefined()

    const webhook = await processTopupWebhook({
      customers,
      eventId: "evt_topup_wrong_project",
      logger,
      wallet,
    })

    expect(webhook.err).toBeUndefined()
    expect(webhook.val).toMatchObject({
      outcome: "ignored",
      providerEventId: "evt_topup_wrong_project",
      status: "processed",
    })
    await expectTopupRow({
      id: initiated.val?.topupId,
      ledgerTransferId: null,
      providerSessionId: provider.sessionId,
      requestedAmount: 10 * euro,
      settledAmount: null,
      status: "pending",
    })
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: 0,
      reserved: 0,
    })
    await expectLedgerSourceCounts([])
  })
})

async function expectWalletState(
  wallet: WalletService,
  expected: {
    consumed: number
    creditIds: Array<string | undefined>
    granted: number
    purchased: number
    reserved: number
  }
) {
  const state = await wallet.getWalletState({ projectId, customerId })
  expect(state.err).toBeUndefined()
  expect(state.val?.balances).toEqual({
    consumed: expected.consumed,
    granted: expected.granted,
    purchased: expected.purchased,
    reserved: expected.reserved,
  })
  expect(state.val?.credits.map((credit) => credit.id)).toEqual(expected.creditIds)
}

async function expectWalletCreditRows(
  expected: Array<{
    id: string | undefined
    issued_amount: number
    remaining_amount: number
    source: string
  }>
) {
  const credits = await db.execute<{
    id: string
    issued_amount: number | string
    remaining_amount: number | string
    source: string
  }>(sql`
    SELECT id, source, issued_amount, remaining_amount
    FROM unprice_wallet_credits
    WHERE project_id = ${projectId}
      AND customer_id = ${customerId}
    ORDER BY COALESCE(expires_at, 'infinity'::timestamptz), created_at, id
  `)

  expect(
    credits.rows.map((row) => ({
      ...row,
      issued_amount: Number(row.issued_amount),
      remaining_amount: Number(row.remaining_amount),
    }))
  ).toEqual(expected)
}

async function expectReservationClosed(input: {
  allocationAmount: number
  consumedAmount: number
  drainLegCount?: number
  reservationId: string
}) {
  const reservations = await db.execute<{
    allocation_amount: number | string
    consumed_amount: number | string
    drain_legs: unknown
    reconciled_at: Date | null
  }>(sql`
    SELECT allocation_amount, consumed_amount, drain_legs, reconciled_at
    FROM unprice_entitlement_reservations
    WHERE project_id = ${projectId}
      AND id = ${input.reservationId}
  `)

  expect(
    reservations.rows.map((row) => ({
      allocationAmount: Number(row.allocation_amount),
      consumedAmount: Number(row.consumed_amount),
      drainLegCount: Array.isArray(row.drain_legs) ? row.drain_legs.length : 0,
      reconciled: row.reconciled_at !== null,
    }))
  ).toEqual([
    {
      allocationAmount: input.allocationAmount,
      consumedAmount: input.consumedAmount,
      drainLegCount: input.drainLegCount ?? 2,
      reconciled: true,
    },
  ])
}

async function expectTopupRow(expected: {
  id: string | undefined
  ledgerTransferId?: string | null
  providerSessionId: string
  requestedAmount: number
  settledAmount: number | null
  status: "completed" | "pending"
}) {
  const topups = await db.execute<{
    id: string
    ledger_transfer_id: string | null
    provider_session_id: string | null
    requested_amount: number | string
    settled_amount: number | string | null
    status: string
  }>(sql`
    SELECT id, provider_session_id, requested_amount, settled_amount, ledger_transfer_id, status
    FROM unprice_wallet_topups
    WHERE project_id = ${projectId}
      AND id = ${expected.id}
  `)

  expect(
    topups.rows.map((row) => ({
      id: row.id,
      ledgerTransferId: row.ledger_transfer_id,
      providerSessionId: row.provider_session_id,
      requestedAmount: Number(row.requested_amount),
      settledAmount: row.settled_amount === null ? null : Number(row.settled_amount),
      status: row.status,
    }))
  ).toEqual([
    expect.objectContaining({
      id: expected.id,
      ledgerTransferId:
        typeof expected.ledgerTransferId === "undefined"
          ? expect.stringMatching(/^pgl/)
          : expected.ledgerTransferId,
      providerSessionId: expected.providerSessionId,
      requestedAmount: expected.requestedAmount,
      settledAmount: expected.settledAmount,
      status: expected.status,
    }),
  ])
}

async function insertPendingTopup(input: {
  id: string
  providerSessionId: string
  requestedAmount: number
}) {
  await db.execute(sql`
    INSERT INTO unprice_wallet_topups (
      id,
      project_id,
      customer_id,
      provider,
      provider_session_id,
      requested_amount,
      currency,
      status
    )
    VALUES (
      ${input.id},
      ${projectId},
      ${customerId},
      'sandbox',
      ${input.providerSessionId},
      ${input.requestedAmount},
      ${currency},
      'pending'
    )
  `)
}

async function expectExpiredCreditRow(input: { id: string; remainingAmount: number }) {
  const credits = await db.execute<{
    expired: boolean
    id: string
    remaining_amount: number | string
  }>(sql`
    SELECT id, remaining_amount, expired_at IS NOT NULL AS expired
    FROM unprice_wallet_credits
    WHERE project_id = ${projectId}
      AND id = ${input.id}
  `)

  expect(
    credits.rows.map((row) => ({
      expired: row.expired,
      id: row.id,
      remainingAmount: Number(row.remaining_amount),
    }))
  ).toEqual([{ expired: true, id: input.id, remainingAmount: input.remainingAmount }])
}

async function expectRowCount(
  tableName:
    | "unprice_entitlement_reservations"
    | "unprice_wallet_credits"
    | "unprice_wallet_topups",
  expected: number
) {
  const rows = await db.execute<{ count: number }>(
    sql.raw(`SELECT COUNT(*)::int AS count FROM ${tableName} WHERE project_id = '${projectId}'`)
  )
  expect(rows.rows).toEqual([{ count: expected }])
}

async function expectWebhookRows(
  expected: Array<{ attempts: number; provider_event_id: string; status: string }>
) {
  const events = await db.execute<{
    attempts: number
    provider_event_id: string
    status: string
  }>(sql`
    SELECT provider_event_id, status, attempts
    FROM unprice_webhook_events
    WHERE project_id = ${projectId}
    ORDER BY provider_event_id
  `)

  expect(events.rows).toEqual(expected)
}

async function expectLedgerSourceCounts(expected: Array<{ count: number; source_type: string }>) {
  const sources = await db.execute<{ count: number; source_type: string }>(sql`
    SELECT source_type, COUNT(*)::int AS count
    FROM unprice_ledger_idempotency
    WHERE project_id = ${projectId}
      AND source_type LIKE 'wallet_%'
    GROUP BY source_type
    ORDER BY source_type
  `)

  expect(sources.rows).toEqual(expected)
}
