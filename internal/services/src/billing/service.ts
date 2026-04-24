import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import {
  type AggregationMethod,
  type CollectionMethod,
  type Currency,
  type Customer,
  type Entitlement,
  type FeatureType,
  type InvoiceStatus,
  type PaymentProvider,
  type SubscriptionInvoice,
  calculateNextNCycles,
  calculateProration,
} from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { addDays } from "date-fns"
import type { Cache } from "../cache"
import type { CustomerService } from "../customers/service"
import type { GrantsManager } from "../entitlements"
import type { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import type { RatingService } from "../rating/service"
import type { RatedCharge, RatingInput } from "../rating/types"
import type { SubscriptionMachine } from "../subscriptions/machine"
import { DrizzleSubscriptionRepository } from "../subscriptions/repository.drizzle"
import { withLockedMachine } from "../subscriptions/withLockedMachine"
import type { WalletService } from "../wallet"
import { UnPriceBillingError } from "./errors"
import { DrizzleBillingRepository } from "./repository.drizzle"

type ComputeCurrentUsageResult = RatedCharge

export class BillingService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly customerService: CustomerService
  private readonly grantsManager: GrantsManager
  private readonly ratingService: RatingService
  private readonly ledgerService: LedgerGateway
  private readonly walletService: WalletService

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
    customerService,
    grantsManager,
    ratingService,
    ledgerService,
    walletService,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    customerService: CustomerService
    grantsManager: GrantsManager
    ratingService: RatingService
    ledgerService: LedgerGateway
    walletService: WalletService
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.cache = cache
    this.metrics = metrics
    this.waitUntil = waitUntil
    this.customerService = customerService
    this.grantsManager = grantsManager
    this.ratingService = ratingService
    this.ledgerService = ledgerService
    this.walletService = walletService
  }

  private setLockContext(context: {
    type?: "metric" | "normal" | "wide_event"
    resource?: string
    action?: string
    acquired?: boolean
    ttl_ms?: number
    max_hold_ms?: number
  }) {
    this.logger.set({ lock: context })
  }

  private async withSubscriptionMachine<T>(args: {
    subscriptionId: string
    projectId: string
    now: number
    lock?: boolean
    ttlMs?: number
    db?: Database
    dryRun?: boolean
    run: (m: SubscriptionMachine) => Promise<T>
  }): Promise<T> {
    const trx = args.db ?? this.db

    try {
      return await withLockedMachine({
        ...args,
        db: trx,
        repo: new DrizzleSubscriptionRepository(trx),
        logger: this.logger,
        analytics: this.analytics,
        customer: this.customerService,
        ratingService: this.ratingService,
        ledgerService: this.ledgerService,
        walletService: this.walletService,
        setLockContext: (ctx: Parameters<typeof this.setLockContext>[0]) =>
          this.setLockContext(ctx),
      })
    } catch (e) {
      if (e instanceof Error && e.message === "SUBSCRIPTION_BUSY") {
        throw new UnPriceBillingError({ message: "SUBSCRIPTION_BUSY" })
      }
      throw e
    }
  }

  public async generateBillingPeriods({
    subscriptionId,
    projectId,
    now = Date.now(),
    db,
    dryRun = false,
  }: {
    subscriptionId: string
    projectId: string
    now?: number
    db?: Database
    dryRun?: boolean
  }): Promise<Result<{ cyclesCreated: number; phasesProcessed: number }, UnPriceBillingError>> {
    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: !dryRun, // Skip lock for dry run
        db,
        dryRun,
        run: async () => {
          const s1 = await this._generateBillingPeriods({
            subscriptionId,
            projectId,
            now,
            db,
            dryRun,
          })

          if (s1.err) throw s1.err
          return s1.val
        },
      })
      return Ok({ cyclesCreated: status.cyclesCreated, phasesProcessed: status.phasesProcessed })
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  public async billingInvoice({
    projectId,
    subscriptionId,
    invoiceId,
    now = Date.now(),
  }: {
    projectId: string
    subscriptionId: string
    invoiceId: string
    now?: number
  }): Promise<
    Result<
      {
        total: number
        status: InvoiceStatus
      },
      UnPriceBillingError
    >
  > {
    try {
      const res = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: true,
        run: async (machine) => {
          const col = await this._collectInvoicePayment({
            invoiceId,
            projectId,
            now,
          })
          if (col.err) {
            await machine.reportInvoiceFailure({ invoiceId, error: col.err.message })
            throw col.err
          }
          const { totalAmount, status } = col.val
          if (status === "paid" || status === "void") {
            await machine.reportInvoiceSuccess({ invoiceId })
          } else if (status === "failed") {
            await machine.reportPaymentFailure({ invoiceId, error: "Payment failed" })
          }
          return { total: totalAmount, status }
        },
      })
      return Ok(res)
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  private async _collectInvoicePayment(payload: {
    invoiceId: string
    projectId: string
    now: number
  }): Promise<Result<SubscriptionInvoice, UnPriceBillingError>> {
    const { invoiceId, projectId, now } = payload
    const billingRepo = new DrizzleBillingRepository(this.db)

    // Get invoice details
    const invoice = await billingRepo.findInvoiceById({ invoiceId, projectId })

    if (!invoice) {
      return Err(new UnPriceBillingError({ message: "Invoice not found" }))
    }

    const invoicePaymentProviderId = invoice.invoicePaymentProviderId
    const paymentMethodId = invoice.paymentMethodId

    // if the invoice is draft, we can't collect the payment
    if (invoice.status === "draft") {
      return Err(
        new UnPriceBillingError({ message: "Invoice is not finalized, cannot collect payment" })
      )
    }

    // check if the invoice is already paid or void
    if (["paid", "void"].includes(invoice.status)) {
      return Ok(invoice)
    }

    // validate if the invoice is failed
    if (invoice.status === "failed") {
      // meaning the invoice is past due and we cannot collect the payment with 3 attempts
      return Err(new UnPriceBillingError({ message: "Invoice is failed, cannot collect payment" }))
    }

    // check if the invoice has an invoice id from the payment provider
    if (!invoicePaymentProviderId) {
      return Err(
        new UnPriceBillingError({
          message:
            "Invoice has no invoice id from the payment provider, please finalize the invoice first",
        })
      )
    }

    // check if the invoice has a payment method id
    // this shouldn't happen but we add a check anyway just in case
    if (!paymentMethodId || paymentMethodId === "") {
      return Err(
        new UnPriceBillingError({
          message: "Invoice requires a payment method, please set a payment method first",
        })
      )
    }

    // Get subscription data with related entities
    const subscriptionData = await this.db.query.subscriptions.findFirst({
      where: (table, { eq, and }) =>
        and(eq(table.id, invoice.subscriptionId), eq(table.projectId, projectId)),
      with: {
        customer: true,
        phases: {
          where(fields, operators) {
            return operators.and(operators.eq(fields.projectId, projectId))
          },
          with: {
            planVersion: true,
            items: {
              with: {
                featurePlanVersion: {
                  with: {
                    feature: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!subscriptionData) {
      return Err(new UnPriceBillingError({ message: "Subscription not found" }))
    }

    const { phases, customer } = subscriptionData
    const phase = phases[0]

    if (!phase) {
      return Err(
        new UnPriceBillingError({
          message: "Subscription phase not found",
        })
      )
    }

    // Get payment provider config
    const config = await this.db.query.paymentProviderConfig.findFirst({
      where: (config, { and, eq }) =>
        and(
          eq(config.projectId, customer.projectId),
          eq(config.paymentProvider, invoice.paymentProvider),
          eq(config.active, true)
        ),
    })

    if (!config) {
      return Err(
        new UnPriceBillingError({
          message: "Payment provider config not found or not active",
        })
      )
    }
    const { err: paymentProviderServiceErr, val: paymentProviderService } =
      await this.customerService.getPaymentProvider({
        projectId: customer.projectId,
        provider: invoice.paymentProvider,
      })

    if (paymentProviderServiceErr) {
      return Err(new UnPriceBillingError({ message: paymentProviderServiceErr.message }))
    }

    // if the invoice is waiting, we need to check if the payment is successful
    // waiting mean we sent the invoice to the customer and we are waiting for the payment (manual payment)
    if (invoice.status === "waiting") {
      // check the status of the payment in the payment provider
      const statusPaymentProviderInvoice = await paymentProviderService.getStatusInvoice({
        invoiceId: invoicePaymentProviderId,
      })

      if (statusPaymentProviderInvoice.err) {
        return Err(new UnPriceBillingError({ message: "Error getting invoice status" }))
      }

      // if the invoice is paid or void, we update the invoice status
      if (["paid", "void"].includes(statusPaymentProviderInvoice.val.status)) {
        // update the invoice status
        const updatedInvoice = await billingRepo.updateInvoice({
          invoiceId: invoice.id,
          projectId,
          data: {
            status: statusPaymentProviderInvoice.val.status as InvoiceStatus,
            paidAt: statusPaymentProviderInvoice.val.paidAt,
            invoicePaymentProviderUrl: statusPaymentProviderInvoice.val.invoiceUrl,
            metadata: {
              ...(invoice.metadata ?? {}),
              reason: "payment_received",
              note:
                statusPaymentProviderInvoice.val.status === "paid"
                  ? "Invoice paid successfully"
                  : "Invoice voided",
            },
          },
        })

        if (!updatedInvoice) {
          return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
        }

        return Ok(updatedInvoice)
      }

      // Past due date reached — fail the invoice. Retry-attempt caps are
      // no longer tracked on the invoice row (Phase 7: header + collection
      // state only).
      if (invoice.pastDueAt && invoice.pastDueAt < now) {
        // update the invoice status
        const updatedInvoice = await billingRepo.updateInvoice({
          invoiceId: invoice.id,
          projectId,
          data: {
            status: "failed",
            metadata: {
              reason: "pending_expiration",
              note: "Invoice has reached the maximum number of payment attempts and the past due date is suppased",
            },
          },
        })

        if (!updatedInvoice) {
          return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
        }

        return Ok(updatedInvoice)
      }
    }

    // collect the payment depending on the collection method
    // collect automatically means we will try to collect the payment with the default payment method
    if (invoice.collectionMethod === "charge_automatically") {
      // before collecting we need to check if the invoice is already paid
      const statusInvoice = await paymentProviderService.getStatusInvoice({
        invoiceId: invoicePaymentProviderId,
      })

      if (statusInvoice.err) {
        return Err(new UnPriceBillingError({ message: "Error getting invoice status" }))
      }

      // this happen when there are many invoices and stripe merge them into one invoice
      if (["paid", "void"].includes(statusInvoice.val.status)) {
        // update the invoice status if the payment is successful
        // if not add the failed attempt
        const updatedInvoice = await billingRepo.updateInvoice({
          invoiceId: invoice.id,
          projectId,
          data: {
            status: statusInvoice.val.status as InvoiceStatus,
            ...(statusInvoice.val.status === "paid" ? { paidAt: Date.now() } : {}),
            ...(statusInvoice.val.status === "paid"
              ? { invoicePaymentProviderUrl: statusInvoice.val.invoiceUrl }
              : {}),
          },
        })

        if (!updatedInvoice) {
          return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
        }

        return Ok(updatedInvoice)
      }

      const providerPaymentInvoice = await paymentProviderService.collectPayment({
        invoiceId: invoicePaymentProviderId,
        paymentMethodId: paymentMethodId,
      })

      if (providerPaymentInvoice.err) {
        // mark the invoice as failed — retry-attempt history is not tracked
        // on the invoice row in Phase 7.
        await billingRepo.updateInvoice({
          invoiceId: invoice.id,
          projectId,
          data: {
            metadata: {
              reason: "payment_failed",
              note: `Payment failed: ${providerPaymentInvoice.err.message}`,
            },
          },
        })

        return Err(
          new UnPriceBillingError({
            message: `Error collecting payment: ${providerPaymentInvoice.err.message}`,
          })
        )
      }

      const paymentStatus = providerPaymentInvoice.val.status
      const isPaid = ["paid", "void"].includes(paymentStatus)

      // update the invoice status if the payment is successful
      // if not add the failed attempt
      const updatedInvoice = await billingRepo.updateInvoice({
        invoiceId: invoice.id,
        projectId,
        data: {
          status: isPaid ? "paid" : "unpaid",
          ...(isPaid ? { paidAt: Date.now() } : {}),
          ...(isPaid ? { invoicePaymentProviderUrl: providerPaymentInvoice.val.invoiceUrl } : {}),
          metadata: {
            ...(invoice.metadata ?? {}),
            reason: isPaid ? "payment_received" : "payment_pending",
            note: isPaid ? "Invoice paid successfully" : `Payment pending for ${paymentStatus}`,
          },
        },
      })

      if (!updatedInvoice) {
        return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
      }

      return Ok(updatedInvoice)
    }

    // send the invoice to the customer and wait for the payment
    if (invoice.collectionMethod === "send_invoice") {
      const providerSendInvoice = await paymentProviderService.sendInvoice({
        invoiceId: invoicePaymentProviderId,
      })

      if (providerSendInvoice.err) {
        return Err(
          new UnPriceBillingError({
            message: `Error sending invoice: ${providerSendInvoice.err.message}`,
          })
        )
      }

      // update the invoice status if send invoice is successful
      const updatedInvoice = await billingRepo.updateInvoice({
        invoiceId: invoice.id,
        projectId,
        data: {
          status: "waiting",
          sentAt: Date.now(),
          metadata: {
            ...(invoice.metadata ?? {}),
            reason: "payment_pending",
            note: "Invoice sent to the customer, waiting for payment",
          },
        },
      })

      if (!updatedInvoice) {
        return Err(new UnPriceBillingError({ message: "Error updating invoice" }))
      }

      return Ok(updatedInvoice)
    }

    return Err(new UnPriceBillingError({ message: "Unsupported status for invoice" }))
  }

  public async finalizeInvoice({
    projectId,
    subscriptionId,
    invoiceId,
    now = Date.now(),
  }: {
    projectId: string
    subscriptionId: string
    invoiceId: string
    now?: number
  }): Promise<
    Result<
      {
        providerInvoiceId?: string
        providerInvoiceUrl?: string
        invoiceId: string
        status: InvoiceStatus
      },
      UnPriceBillingError
    >
  > {
    try {
      const res = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: false, // no need to lock it here
        run: async (machine) => {
          const fin = await this._finalizeInvoice({
            subscriptionId,
            projectId,
            now,
            invoiceId,
          })

          if (fin.err) {
            throw fin.err
          }

          const providerInvoiceData = await this._upsertPaymentProviderInvoice({
            invoiceId: fin.val.id,
            projectId,
          })

          if (providerInvoiceData.err) {
            // report failed invoice
            await machine.reportInvoiceFailure({
              invoiceId: fin.val.id,
              error: providerInvoiceData.err.message,
            })
            throw providerInvoiceData.err
          }

          // report successful invoice
          await machine.reportInvoiceSuccess({ invoiceId: fin.val.id })

          return {
            providerInvoiceId: providerInvoiceData.val.providerInvoiceId,
            providerInvoiceUrl: providerInvoiceData.val.providerInvoiceUrl,
            invoiceId: fin.val.id,
            status: fin.val.status,
          }
        },
      })

      return Ok(res)
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  private async getOpenInvoiceData({
    subscriptionId,
    projectId,
    invoiceId,
    now,
  }: {
    subscriptionId: string
    projectId: string
    invoiceId: string
    now: number
  }): Promise<Result<SubscriptionInvoice & { customer: Customer }, UnPriceBillingError>> {
    try {
      const invoice = await this.db.query.invoices.findFirst({
        with: { customer: true },
        where: (inv, { and, eq, inArray, lte, or, isNull }) =>
          or(
            and(
              eq(inv.projectId, projectId),
              eq(inv.id, invoiceId),
              eq(inv.subscriptionId, subscriptionId),
              eq(inv.status, "draft"),
              lte(inv.dueAt, now)
            ),
            and(
              eq(inv.projectId, projectId),
              eq(inv.id, invoiceId),
              eq(inv.subscriptionId, subscriptionId),
              inArray(inv.status, ["unpaid", "waiting"]),
              isNull(inv.invoicePaymentProviderId),
              lte(inv.dueAt, now)
            )
          ),
        orderBy: (inv, { asc }) => asc(inv.dueAt),
      })

      if (!invoice) {
        return Err(
          new UnPriceBillingError({ message: "Invoice not found or not due to be processed" })
        )
      }

      return Ok(invoice)
    } catch (e) {
      return Err(e as UnPriceBillingError)
    }
  }

  /**
   * Phase 7: invoice lines are projected from the ledger (see
   * `LedgerGateway.getInvoiceLines`), not assembled from an `invoice_items`
   * table. Finalization here is a header-only transition: move the invoice
   * from `draft` to `unpaid` (or `void` when `totalAmount === 0`) and
   * stamp `issueDate`. Totals are materialized at `invoices.totalAmount`
   * when the ledger entries are written (slice 7.12 activation hook).
   */
  private async _finalizeInvoice({
    subscriptionId,
    projectId,
    now,
    invoiceId,
  }: {
    subscriptionId: string
    projectId: string
    now: number
    invoiceId: string
  }): Promise<Result<SubscriptionInvoice, UnPriceBillingError>> {
    const { err: openInvoiceDataErr, val: openInvoiceData } = await this.getOpenInvoiceData({
      subscriptionId,
      projectId,
      now,
      invoiceId,
    })

    if (openInvoiceDataErr) {
      return Err(openInvoiceDataErr)
    }

    // Already processed.
    if (openInvoiceData.invoicePaymentProviderId || openInvoiceData.status !== "draft") {
      return Ok(openInvoiceData)
    }

    const result = await this.db.transaction(async (tx) => {
      try {
        const txBillingRepo = new DrizzleBillingRepository(tx)
        const statusInvoice =
          openInvoiceData.totalAmount === 0 ? ("void" as const) : ("unpaid" as const)

        const updatedInvoice = await txBillingRepo.updateInvoice({
          invoiceId: openInvoiceData.id,
          projectId,
          data: {
            status: statusInvoice,
            issueDate: now,
            metadata: {
              ...(openInvoiceData.metadata ?? {}),
              note: "Finalized by scheduler",
            },
          },
        })

        if (!updatedInvoice) {
          throw new Error("Error updating invoice")
        }

        return updatedInvoice
      } catch (error) {
        this.logger.error(error, {
          context: "Error finalizing invoice",
          invoiceId: openInvoiceData.id,
          projectId: openInvoiceData.projectId,
        })
        tx.rollback()
        throw error
      }
    })

    return Ok(result)
  }

  private async _upsertPaymentProviderInvoice(_opts: {
    invoiceId: string
    projectId: string
  }): Promise<
    Result<
      { providerInvoiceId?: string; providerInvoiceUrl?: string },
      UnPriceBillingError | FetchError
    >
  > {
    return Ok({ providerInvoiceId: "", providerInvoiceUrl: "" })
  }

  /**
   * Phase 7: customer credits live in `wallet_grants` and drain through
   * the reservation/flush pipeline. The legacy `credit_grants` +
   * `invoice_credit_applications` path is deleted. Any credit application
   * at invoice time should instead route through `WalletService.adjust`
   * or drain naturally during reservation (slice 7.12).
   */
  private async _generateBillingPeriods({
    subscriptionId,
    projectId,
    now,
    db,
    dryRun = false,
  }: {
    subscriptionId: string
    projectId: string
    now: number
    db?: Database
    dryRun?: boolean
  }): Promise<
    Result<
      {
        phasesProcessed: number
        cyclesCreated: number
      },
      UnPriceBillingError
    >
  > {
    const lookbackDays = 7 // lookback days to materialize pending periods
    const batch = 100 // process a max of 100 phases per trigger run

    const trx = db ?? this.db

    // fetch phases that are active now OR ended recently
    const phases = await trx.query.subscriptionPhases.findMany({
      with: {
        planVersion: true,
        subscription: true,
        items: {
          with: {
            featurePlanVersion: true,
          },
        },
      },
      where: (phase, ops) =>
        ops.and(
          ops.eq(phase.projectId, projectId),
          ops.eq(phase.subscriptionId, subscriptionId),
          ops.lte(phase.startAt, now),
          ops.or(
            ops.isNull(phase.endAt),
            ops.gte(phase.endAt, addDays(now, -lookbackDays).getTime())
          )
        ),
      limit: batch, // limit to batch size to avoid overwhelming the system
    })

    this.logger.info(`Materializing billing periods for ${phases.length} phases`)

    let cyclesCreated = 0

    const result = await trx
      .transaction(async (tx) => {
        const txBillingRepo = new DrizzleBillingRepository(tx)
        for (const phase of phases) {
          // 0. Cap any existing pending periods for this phase that exceed the phase end date
          // this is useful for mid-cycle cancellations or plan changes
          if (phase.endAt) {
            // update billing periods
            if (!dryRun) {
              await txBillingRepo.capPendingPeriodsAtPhaseEnd({
                phaseId: phase.id,
                phaseEndAt: phase.endAt,
                whenToBill: phase.planVersion.whenToBill,
              })
            }

            // 0.1 Shorten already-invoiced periods that now exceed the
            // new phase end, and issue a prorated refund for the
            // unearned portion. Phase 7: refunds are wallet-credit only
            // (plan §Non-Goals) — we credit the customer's `available.
            // purchased` sub-account via `WalletService.adjust`, sourced
            // from `platform.funding.manual`. Paid amount is summed
            // from ledger entries tagged with `billing_period_id` in
            // metadata (the invoice projection contract from slice 7.8).
            const invoicedPeriods = await txBillingRepo.listInvoicedPeriodsExceedingPhaseEnd({
              phaseId: phase.id,
              phaseEndAt: phase.endAt!,
            })

            for (const period of invoicedPeriods) {
              const refundAmount = dryRun
                ? 0
                : await this.computeProratedRefundAmount(tx, {
                    period,
                    phaseEndAt: phase.endAt!,
                    phaseStartAt: phase.startAt,
                    billingAnchor: phase.billingAnchor,
                    billingConfig: phase.planVersion.billingConfig,
                  })

              if (!dryRun) {
                if (refundAmount > 0) {
                  const { err } = await this.walletService.adjust(
                    {
                      projectId: phase.projectId,
                      customerId: phase.subscription.customerId,
                      currency: phase.planVersion.currency,
                      signedAmount: refundAmount,
                      actorId: "system:mid-cycle-shortening",
                      reason: `Prorated refund for shortened cycle ${new Date(period.cycleStartAt).toISOString()} - ${new Date(phase.endAt!).toISOString()}`,
                      source: "purchased",
                      idempotencyKey: `mid_cycle_refund:${period.id}:${phase.endAt}`,
                      metadata: {
                        billing_period_id: period.id,
                        phase_id: phase.id,
                        kind: "mid_cycle_refund",
                      },
                    },
                    tx
                  )
                  if (err) {
                    this.logger.error(err, {
                      context: "billing.mid_cycle_refund_failed",
                      periodId: period.id,
                      phaseId: phase.id,
                    })
                    throw err
                  }
                }

                await txBillingRepo.shortenBillingPeriod({
                  periodId: period.id,
                  cycleEndAt: phase.endAt!,
                })
              }
            }
          }

          for (const item of phase.items) {
            // 1. Find the last period for this item to make per-item backfill
            const lastForItem = await txBillingRepo.getLastPeriodForItem({
              projectId: phase.projectId,
              subscriptionId: phase.subscriptionId,
              subscriptionPhaseId: phase.id,
              subscriptionItemId: item.id,
            })

            const cursorStart = lastForItem ? lastForItem.cycleEndAt : phase.startAt
            const itemBillingConfig = item.featurePlanVersion.billingConfig

            const windows = calculateNextNCycles({
              referenceDate: now,
              effectiveStartDate: cursorStart,
              trialEndsAt: phase.trialEndsAt,
              effectiveEndDate: phase.endAt,
              config: {
                name: itemBillingConfig.name,
                interval: itemBillingConfig.billingInterval,
                intervalCount: itemBillingConfig.billingIntervalCount,
                planType: itemBillingConfig.planType,
                anchor: phase.billingAnchor,
              },
              count: 0,
            })

            if (windows.length === 0) continue

            // 3. Prepare all billing period values for this item
            const billingPeriodValues = await Promise.all(
              windows.map(async (w) => {
                const whenToBill = phase.planVersion.whenToBill
                const invoiceAt = w.isTrial
                  ? w.end
                  : whenToBill === "pay_in_advance"
                    ? w.start
                    : w.end
                const statementKey = await this.computeStatementKey({
                  projectId: phase.projectId,
                  customerId: phase.subscription.customerId,
                  subscriptionId: phase.subscriptionId,
                  invoiceAt,
                  currency: phase.planVersion.currency,
                  paymentProvider: phase.paymentProvider,
                  collectionMethod: phase.planVersion.collectionMethod,
                })

                return {
                  id: newId("billing_period"),
                  projectId: phase.projectId,
                  subscriptionId: phase.subscriptionId,
                  customerId: phase.subscription.customerId,
                  subscriptionPhaseId: phase.id,
                  subscriptionItemId: item.id,
                  status: "pending" as const,
                  type: w.isTrial ? ("trial" as const) : ("normal" as const),
                  cycleStartAt: w.start,
                  cycleEndAt: w.end,
                  statementKey,
                  invoiceAt,
                  whenToBill,
                  invoiceId: null,
                  amountEstimate: null,
                  reason: w.isTrial ? ("trial" as const) : ("normal" as const),
                }
              })
            )

            // 4. Batch insert billing periods for this item
            if (billingPeriodValues.length > 0) {
              if (!dryRun) {
                await txBillingRepo.createPeriodsBatch({
                  periods: billingPeriodValues,
                })
              }
              cyclesCreated += billingPeriodValues.length
            }
          }
        }
        return Ok({ phasesProcessed: phases.length, cyclesCreated })
      })
      .catch((error) => {
        this.logger.error(error, {
          context: "Error in billing period backfill transaction",
          subscriptionId,
          projectId,
          now,
          phases: phases.length,
          cyclesCreated,
        })

        return Err(
          new UnPriceBillingError({
            message: error instanceof Error ? error.message : "Internal transaction error",
          })
        )
      })

    return result
  }

  public async calculateFeaturePrice(
    params: RatingInput
  ): Promise<Result<ComputeCurrentUsageResult[], UnPriceBillingError>> {
    const result = await this.ratingService.rateBillingPeriod(params)
    return result.err
      ? Err(new UnPriceBillingError({ message: result.err.message }))
      : Ok(result.val)
  }

  /**
   * Compute the unearned portion of a paid billing period that has
   * been shortened to `phaseEndAt`. The paid amount is summed from
   * ledger entries tagged `billing_period_id = period.id` — the
   * authoritative record of what the customer actually paid for this
   * period (invoice_items is deleted in Phase 7).
   *
   * Returns 0 when:
   * - the invoice is not paid (nothing to refund yet)
   * - no ledger entries exist for this period (e.g. trial period)
   * - the new proration factor is >= the old one (nothing unearned)
   */
  private async computeProratedRefundAmount(
    tx: Database,
    input: {
      period: {
        id: string
        projectId: string
        invoiceId: string | null
        cycleStartAt: number
        cycleEndAt: number
      }
      phaseEndAt: number
      phaseStartAt: number
      billingAnchor: number
      billingConfig: import("@unprice/db/validators").BillingConfig
    }
  ): Promise<number> {
    const { period, phaseEndAt, phaseStartAt, billingAnchor, billingConfig } = input

    if (!period.invoiceId) return 0

    // Only paid invoices can generate refunds — otherwise we'd be
    // refunding money the customer never spent.
    const invoice = await tx.query.invoices.findFirst({
      columns: { status: true, statementKey: true },
      where: (inv, { and, eq }) =>
        and(eq(inv.id, period.invoiceId!), eq(inv.projectId, period.projectId)),
    })

    if (!invoice || invoice.status !== "paid") return 0

    // Compute old (full period) and new (shortened) proration factors.
    const originalProration = calculateProration({
      serviceStart: period.cycleStartAt,
      serviceEnd: period.cycleEndAt,
      effectiveStartDate: phaseStartAt,
      billingConfig: { ...billingConfig, billingAnchor },
    })
    const newProration = calculateProration({
      serviceStart: period.cycleStartAt,
      serviceEnd: phaseEndAt,
      effectiveStartDate: phaseStartAt,
      billingConfig: { ...billingConfig, billingAnchor },
    })

    const oldFactor = originalProration.prorationFactor
    const newFactor = newProration.prorationFactor
    if (!oldFactor || newFactor >= oldFactor) return 0

    // Sum the ledger entries that credit `customer.*.consumed` for
    // this billing period. Uses the same projection contract as the
    // invoice-lines read path (slice 7.8).
    const linesResult = await this.ledgerService.getInvoiceLines({
      projectId: period.projectId,
      statementKey: invoice.statementKey,
    })
    if (linesResult.err) return 0

    const paidMinor = linesResult.val.reduce((sum, line) => {
      if (line.metadata?.billing_period_id !== period.id) return sum
      const snap = line.amount.toJSON()
      return sum + snap.amount
    }, 0)

    if (paidMinor <= 0) return 0

    const unearnedFraction = 1 - newFactor / oldFactor
    return Math.floor(paidMinor * unearnedFraction)
  }

  public async estimatePriceCurrentUsage({
    customerId,
    projectId,
    now = Date.now(),
    usageOverrides,
  }: {
    customerId: string
    projectId: string
    now?: number
    usageOverrides?: Map<string, number>
  }): Promise<Result<ComputeCurrentUsageResult[], UnPriceBillingError>> {
    const result: ComputeCurrentUsageResult[] = []

    // Get all active grants for the customer to determine which features to process
    const { val: grantsResult, err: grantsErr } = await this.grantsManager.getGrantsForCustomer({
      customerId,
      projectId,
      now,
    })

    if (grantsErr) {
      this.logger.error(grantsErr, {
        context: "Failed to get grants for customer",
        customerId,
        projectId,
      })
      return Err(new UnPriceBillingError({ message: grantsErr.message }))
    }

    if (grantsResult.grants.length === 0) {
      return Ok([])
    }

    // Group grants by feature slug to process each feature
    const grantsByFeature = new Map<string, typeof grantsResult.grants>()

    for (const grant of grantsResult.grants) {
      const featureSlug = grant.featurePlanVersion.feature.slug
      if (!grantsByFeature.has(featureSlug)) {
        grantsByFeature.set(featureSlug, [])
      }
      grantsByFeature.get(featureSlug)!.push(grant)
    }

    // Pre-compute entitlement states and billing windows for all features to batch fetch usage data
    const usageFeaturesToFetch: Array<{
      featureSlug: string
      aggregationMethod: AggregationMethod
      featureType: FeatureType
      billingStartAt: number
      billingEndAt: number
    }> = []

    const featureMetadata = new Map<
      string,
      {
        grants: typeof grantsResult.grants
        entitlement: Omit<Entitlement, "id">
        billingStartAt: number
        billingEndAt: number
      }
    >()

    for (const [featureSlug, featureGrants] of grantsByFeature.entries()) {
      // Compute entitlement state to determine feature type and billing window
      const computedStateResult = await this.grantsManager.computeEntitlementState({
        grants: featureGrants,
        customerId,
        projectId,
      })

      if (computedStateResult.err) {
        this.logger.error(computedStateResult.err, {
          context: "Failed to compute entitlement state",
          featureSlug,
        })
        continue
      }

      const entitlement = computedStateResult.val

      // Calculate billing window using RatingService
      const billingWindowResult = this.ratingService.resolveBillingWindow({
        entitlement,
        now,
      })

      if (billingWindowResult.err) {
        this.logger.error(billingWindowResult.err, {
          context: "Failed to calculate billing window",
          featureSlug,
        })
        continue
      }

      const { billingStartAt, billingEndAt } = billingWindowResult.val

      featureMetadata.set(featureSlug, {
        grants: featureGrants,
        entitlement,
        billingStartAt,
        billingEndAt,
      })

      // Collect usage features for batch fetching
      if (
        entitlement.featureType === "usage" &&
        entitlement.meterConfig?.aggregationMethod &&
        !usageOverrides?.has(featureSlug)
      ) {
        usageFeaturesToFetch.push({
          featureSlug,
          aggregationMethod: entitlement.meterConfig.aggregationMethod,
          featureType: entitlement.featureType,
          billingStartAt,
          billingEndAt,
        })
      }
    }

    // Batch fetch usage data for all usage features
    // Group by billing window to make optimal queries
    const usageDataByWindow = new Map<string, { featureSlug: string; usage: number }[]>()

    // Add usage overrides to the window map as if they were fetched
    if (usageOverrides) {
      for (const [featureSlug, usage] of usageOverrides.entries()) {
        const metadata = featureMetadata.get(featureSlug)
        if (!metadata) continue

        const windowKey = `${metadata.billingStartAt}-${metadata.billingEndAt}`
        if (!usageDataByWindow.has(windowKey)) {
          usageDataByWindow.set(windowKey, [])
        }
        usageDataByWindow.get(windowKey)!.push({ featureSlug, usage })
      }
    }

    if (usageFeaturesToFetch.length > 0) {
      // Group features by billing window to minimize queries
      const featuresByWindow = new Map<string, typeof usageFeaturesToFetch>()
      for (const feature of usageFeaturesToFetch) {
        const windowKey = `${feature.billingStartAt}-${feature.billingEndAt}`
        if (!featuresByWindow.has(windowKey)) {
          featuresByWindow.set(windowKey, [])
        }
        featuresByWindow.get(windowKey)!.push(feature)
      }

      // Fetch usage data for each unique billing window
      for (const [windowKey, features] of featuresByWindow.entries()) {
        const [billingStartAt, billingEndAt] = windowKey.split("-").map(Number) as [number, number]

        const { err: usageErr, val: fetchedUsageData } =
          await this.analytics.getUsageBillingFeatures({
            customerId,
            projectId,
            features: features.map((f) => ({
              featureSlug: f.featureSlug,
              aggregationMethod: f.aggregationMethod,
              featureType: f.featureType,
            })),
            startAt: billingStartAt,
            endAt: billingEndAt,
          })

        if (usageErr) {
          this.logger.error(usageErr, {
            context: "Failed to batch fetch usage data",
            windowKey,
          })
          // Continue with other windows, but log error
          continue
        }

        usageDataByWindow.set(windowKey, fetchedUsageData)
      }
    }

    // Process each feature - pass grants and usage data to avoid duplicate fetching
    for (const [featureSlug, metadata] of featureMetadata.entries()) {
      // Get usage data for this feature's billing window if it's a usage feature
      let usageDataForFeature: { featureSlug: string; usage: number }[] | undefined

      if (metadata.entitlement.featureType === "usage") {
        const windowKey = `${metadata.billingStartAt}-${metadata.billingEndAt}`
        usageDataForFeature = usageDataByWindow.get(windowKey)
      }

      const calculationResult = await this.calculateFeaturePrice({
        projectId,
        customerId,
        featureSlug,
        now,
        grants: metadata.grants, // Pass already-fetched grants for efficiency
        usageData: usageDataForFeature, // Pass pre-fetched usage data
      })

      if (calculationResult.err) {
        this.logger.error(calculationResult.err, {
          context: "Failed to calculate feature price",
          featureSlug,
        })
        continue
      }

      result.push(...calculationResult.val)
    }

    return Ok(result)
  }

  // all variables that affect the invoice should be included in the statement key
  // this way we can group invoices together and bill them together
  // this is useful for co-billing and for the invoice scheduler
  // also helps us invoice phases changes when they share the same variables,
  // or split them into multiple invoices we things like currency and payment provider changes
  private async computeStatementKey(input: {
    projectId: string
    customerId: string
    subscriptionId: string
    invoiceAt: number // epoch ms
    currency: Currency
    paymentProvider: PaymentProvider
    collectionMethod: CollectionMethod
  }): Promise<string> {
    const raw = [
      input.projectId,
      input.customerId,
      input.subscriptionId,
      String(input.invoiceAt),
      input.currency,
      input.paymentProvider,
      input.collectionMethod,
    ].join("|")
    return hashStringSHA256(raw)
  }
}
