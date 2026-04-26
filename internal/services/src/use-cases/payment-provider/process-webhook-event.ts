import { type Database, and, eq, sql } from "@unprice/db"
import { webhookEvents } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { Currency, InvoiceStatus, PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { DrizzleBillingRepository } from "../../billing/repository.drizzle"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import type {
  NormalizedProviderWebhook,
  PaymentProviderWebhookHeaders,
} from "../../payment-provider/interface"
import { settlePrepaidInvoiceToWallet } from "../billing/settle-invoice"

type ProcessWebhookEventDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions" | "wallet">
  db: Database
  logger: Logger
}

type ProcessWebhookEventInput = {
  projectId: string
  provider: PaymentProvider
  rawBody: string
  headers: PaymentProviderWebhookHeaders
}

type ProcessWebhookEventStatus = "processed" | "duplicate"
type ProcessWebhookEventOutcome =
  | "payment_succeeded"
  | "payment_failed"
  | "payment_reversed"
  | "payment_dispute_reversed"
  | "wallet_topup_settled"
  | "ignored"

type ProcessWebhookEventOutput = {
  webhookEventId: string
  providerEventId: string
  status: ProcessWebhookEventStatus
  outcome: ProcessWebhookEventOutcome
  invoiceId?: string
  subscriptionId?: string
  topupId?: string
}

type ApplyWebhookEventOutput = {
  outcome: ProcessWebhookEventOutcome
  invoiceId?: string
  subscriptionId?: string
  topupId?: string
}

// Invoice statuses from which each payment-event transition is permitted.
// Encodes the webhook → invoice state machine. Anything outside these sets
// means the transition has already happened (or never can), and the side
// effects after the update are no-ops.
const PAYMENT_SUCCEEDED_FROM: ReadonlyArray<InvoiceStatus> = [
  "draft",
  "waiting",
  "unpaid",
  "failed",
]
const PAYMENT_DISPUTE_REVERSED_FROM: ReadonlyArray<InvoiceStatus> = ["unpaid", "failed"]
const PAYMENT_FAILED_FROM: ReadonlyArray<InvoiceStatus> = ["draft", "waiting", "unpaid", "failed"]
const PAYMENT_REVERSED_FROM: ReadonlyArray<InvoiceStatus> = ["paid"]

function toFailureError(error: unknown): FetchError {
  if (error instanceof FetchError) {
    return error
  }

  if (error instanceof Error) {
    return new FetchError({
      message: error.message,
      retry: false,
    })
  }

  return new FetchError({
    message: "Unexpected webhook processing error",
    retry: false,
  })
}

function normalizeOutcome(
  event: NormalizedProviderWebhook["eventType"]
): ProcessWebhookEventOutcome {
  switch (event) {
    case "payment.succeeded":
      return "payment_succeeded"
    case "payment.failed":
      return "payment_failed"
    case "payment.reversed":
      return "payment_reversed"
    case "payment.dispute_reversed":
      return "payment_dispute_reversed"
    default:
      return "ignored"
  }
}

function pickProviderSignature({
  provider,
  headers,
}: {
  provider: PaymentProvider
  headers: PaymentProviderWebhookHeaders
}): string | null {
  const headerName = provider === "stripe" ? "stripe-signature" : "sandbox-signature"
  const value = headers[headerName]
  if (Array.isArray(value)) {
    return value.at(0) ?? null
  }
  return typeof value === "string" ? value : null
}

function sanitizeWebhookHeaders(
  headers: PaymentProviderWebhookHeaders
): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined") {
      continue
    }
    sanitized[key] = value
  }
  return sanitized
}

type DbTx = Parameters<Parameters<Database["transaction"]>[0]>[0]

// Acquires a transaction-scoped advisory lock keyed on the webhook event
// identity. Released automatically at tx commit/rollback. Returns false if
// another transaction currently holds the lock — that caller is processing
// the same webhook concurrently, and we exit as a duplicate.
async function tryAcquireWebhookLock({
  tx,
  projectId,
  provider,
  providerEventId,
}: {
  tx: DbTx
  projectId: string
  provider: PaymentProvider
  providerEventId: string
}): Promise<boolean> {
  const result = await tx.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${`webhook:${projectId}:${provider}:${providerEventId}`})) AS acquired`
  )
  return Boolean(result.rows[0]?.acquired ?? false)
}

async function applyWalletTopupSettlement({
  deps,
  projectId,
  normalizedEvent,
}: {
  deps: ProcessWebhookEventDeps
  projectId: string
  normalizedEvent: NormalizedProviderWebhook
}): Promise<Result<ApplyWebhookEventOutput, FetchError>> {
  const metadata = normalizedEvent.metadata ?? {}
  const providerSessionId = normalizedEvent.providerSessionId
  const paidAmount = normalizedEvent.amountPaid
  const customerId = metadata.customer_id
  const currency = metadata.currency as Currency | undefined
  const metadataProjectId = metadata.project_id

  // Defense-in-depth: projectId comes from the webhook URL. If the metadata
  // disagrees, someone is replaying a session against the wrong project.
  if (metadataProjectId && metadataProjectId !== projectId) {
    deps.logger.error("wallet topup webhook project_id mismatch", {
      expectedProjectId: projectId,
      metadataProjectId,
      eventId: normalizedEvent.eventId,
    })
    return Ok({ outcome: "ignored" })
  }

  if (!providerSessionId || !customerId || !currency || typeof paidAmount !== "number") {
    deps.logger.error("wallet topup webhook missing required fields", {
      hasProviderSessionId: Boolean(providerSessionId),
      hasCustomerId: Boolean(customerId),
      hasCurrency: Boolean(currency),
      hasPaidAmount: typeof paidAmount === "number",
      eventId: normalizedEvent.eventId,
    })
    return Ok({ outcome: "ignored" })
  }

  const { err, val } = await deps.services.wallet.settleTopUp({
    projectId,
    customerId,
    currency,
    providerSessionId,
    paidAmount,
    idempotencyKey: `topup:${normalizedEvent.eventId}`,
  })

  if (err) {
    return Err(
      new FetchError({
        message: `Wallet top-up settlement failed: ${err.message}`,
        retry: false,
      })
    )
  }

  return Ok({
    outcome: "wallet_topup_settled",
    topupId: val.topupId,
  })
}

async function applyWebhookEvent({
  deps,
  projectId,
  normalizedEvent,
  now,
}: {
  deps: ProcessWebhookEventDeps
  projectId: string
  normalizedEvent: NormalizedProviderWebhook
  now: number
}): Promise<Result<ApplyWebhookEventOutput, FetchError>> {
  const outcome = normalizeOutcome(normalizedEvent.eventType)
  if (normalizedEvent.eventType === "noop") {
    return Ok({
      outcome,
    })
  }

  // Wallet top-up settlement: checkout.session.completed (or equivalent)
  // with our wallet_topup metadata. Short-circuits before the invoice
  // branch — these events never carry an invoiceId.
  if (
    normalizedEvent.eventType === "payment.succeeded" &&
    normalizedEvent.metadata?.kind === "wallet_topup"
  ) {
    return applyWalletTopupSettlement({ deps, projectId, normalizedEvent })
  }

  if (!normalizedEvent.invoiceId) {
    return Ok({
      outcome: "ignored",
    })
  }
  const providerInvoiceId = normalizedEvent.invoiceId
  const billingRepo = new DrizzleBillingRepository(deps.db)

  const invoice = await billingRepo.findInvoiceByProviderId({
    projectId,
    invoicePaymentProviderId: providerInvoiceId,
  })

  if (!invoice) {
    return Ok({
      outcome: "ignored",
    })
  }

  if (normalizedEvent.eventType === "payment.succeeded") {
    // Order: settle → invoice status → subscription reconcile.
    //
    // Each operation is independently idempotent (settle is keyed on
    // `invoice_receivable:{invoiceId}` in the ledger, the invoice status
    // update is gated by `allowedFromStatuses`, and reconcile is gated by
    // `metadata.subscriptionReconciledOutcome`). Doing settle first means
    // that if the wallet ledger is unavailable, the invoice stays in
    // `finalized` / `unpaid` and the webhook returns failed — Stripe (or
    // any other provider) re-delivers and we replay cleanly. The previous
    // ordering (status='paid' first) left invoices reconciled-as-paid but
    // with the receivable still on the wallet's books on settle failure,
    // and the subsequent retry took the `!updated` early-exit branch
    // because the invoice was already in the target state — settlement
    // never recovered without manual operator action.
    const settled = await settlePrepaidInvoiceToWallet({
      walletService: deps.services.wallet,
      invoice,
    })
    if (settled.err) {
      return Err(
        new FetchError({
          message: `Failed to settle prepaid invoice ${invoice.id} to wallet: ${settled.err.message}`,
          retry: false,
        })
      )
    }

    const updated = await billingRepo.updateInvoiceIfStatus({
      invoiceId: invoice.id,
      projectId,
      allowedFromStatuses: PAYMENT_SUCCEEDED_FROM,
      data: {
        status: "paid",
        paidAt: invoice.paidAt ?? normalizedEvent.occurredAt,
        invoicePaymentProviderUrl: normalizedEvent.invoiceUrl ?? invoice.invoicePaymentProviderUrl,
        metadata: {
          ...(invoice.metadata ?? {}),
          reason: "payment_received",
          note: "Payment confirmed by provider webhook",
        },
        updatedAtM: now,
      },
    })

    if (!updated) {
      // Late delivery — the invoice already transitioned (e.g., a previous
      // attempt of this same event committed the status flip but failed at
      // reconcile). Don't bail — fall through so reconcile gets another shot.
      deps.logger.warn("webhook payment.succeeded: invoice already in target state", {
        invoiceId: invoice.id,
        currentStatus: invoice.status,
        eventId: normalizedEvent.eventId,
      })
    }

    const reconciled = await reconcilePaymentOutcomeOnce({
      deps,
      billingRepo,
      invoiceId: invoice.id,
      projectId: invoice.projectId,
      subscriptionId: invoice.subscriptionId,
      currentMetadata: updated?.metadata ?? invoice.metadata,
      outcome: "success",
      eventId: normalizedEvent.eventId,
      now,
    })
    if (reconciled.err) {
      return Err(reconciled.err)
    }

    return Ok({
      outcome,
      invoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
    })
  }

  if (normalizedEvent.eventType === "payment.dispute_reversed") {
    const settled = await settlePrepaidInvoiceToWallet({
      walletService: deps.services.wallet,
      invoice,
    })
    if (settled.err) {
      return Err(
        new FetchError({
          message: `Failed to settle prepaid invoice ${invoice.id} to wallet: ${settled.err.message}`,
          retry: false,
        })
      )
    }

    const updated = await billingRepo.updateInvoiceIfStatus({
      invoiceId: invoice.id,
      projectId,
      allowedFromStatuses: PAYMENT_DISPUTE_REVERSED_FROM,
      data: {
        status: "paid",
        paidAt: invoice.paidAt ?? normalizedEvent.occurredAt,
        metadata: {
          ...(invoice.metadata ?? {}),
          reason: "payment_received",
          note: "Payment reinstated after dispute reversal",
        },
        updatedAtM: now,
      },
    })

    if (!updated) {
      deps.logger.warn("webhook payment.dispute_reversed: invoice already in target state", {
        invoiceId: invoice.id,
        currentStatus: invoice.status,
        eventId: normalizedEvent.eventId,
      })
    }

    const reconciled = await reconcilePaymentOutcomeOnce({
      deps,
      billingRepo,
      invoiceId: invoice.id,
      projectId: invoice.projectId,
      subscriptionId: invoice.subscriptionId,
      currentMetadata: updated?.metadata ?? invoice.metadata,
      outcome: "success",
      eventId: normalizedEvent.eventId,
      now,
    })
    if (reconciled.err) {
      return Err(reconciled.err)
    }

    return Ok({
      outcome,
      invoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
    })
  }

  const isPaymentFailed = normalizedEvent.eventType === "payment.failed"
  const failedStatus: InvoiceStatus = isPaymentFailed ? "unpaid" : "failed"
  const allowedFrom = isPaymentFailed ? PAYMENT_FAILED_FROM : PAYMENT_REVERSED_FROM
  const failureMessage =
    normalizedEvent.failureMessage ??
    (normalizedEvent.eventType === "payment.reversed"
      ? "Payment reversed by provider"
      : "Payment failed from provider webhook")

  const updated = await billingRepo.updateInvoiceIfStatus({
    invoiceId: invoice.id,
    projectId,
    allowedFromStatuses: allowedFrom,
    data: {
      status: failedStatus,
      metadata: {
        ...(invoice.metadata ?? {}),
        reason: "payment_failed",
        note: failureMessage,
      },
      updatedAtM: now,
    },
  })

  if (!updated) {
    deps.logger.warn(`webhook ${normalizedEvent.eventType}: invoice already in target state`, {
      invoiceId: invoice.id,
      currentStatus: invoice.status,
      eventId: normalizedEvent.eventId,
    })
  }

  // Refund accounting (revenue → customer reverse transfers) is owned by
  // the wallet layer. The invoice's failed/unpaid status above already
  // reflects the reversal for downstream consumers.

  const reconciled = await reconcilePaymentOutcomeOnce({
    deps,
    billingRepo,
    invoiceId: invoice.id,
    projectId: invoice.projectId,
    subscriptionId: invoice.subscriptionId,
    currentMetadata: updated?.metadata ?? invoice.metadata,
    outcome: "failure",
    failureMessage,
    eventId: normalizedEvent.eventId,
    now,
  })
  if (reconciled.err) {
    return Err(reconciled.err)
  }

  return Ok({
    outcome,
    invoiceId: invoice.id,
    subscriptionId: invoice.subscriptionId,
  })
}

// Idempotent wrapper around `subscriptions.reconcilePaymentOutcome`. The
// subscription state machine is NOT a strict no-op when sent the same
// PAYMENT_SUCCESS twice (in `active` it can self-transition to `renewing`
// at end-of-cycle). To keep replay safe we record the outcome on the
// invoice metadata and skip the machine call if the same outcome is
// already recorded. A genuinely new outcome (success → failure, or
// failure → success after dispute reversal) bypasses the marker because
// the recorded outcome differs from the incoming one.
async function reconcilePaymentOutcomeOnce({
  deps,
  billingRepo,
  invoiceId,
  projectId,
  subscriptionId,
  currentMetadata,
  outcome,
  failureMessage,
  eventId,
  now,
}: {
  deps: ProcessWebhookEventDeps
  billingRepo: DrizzleBillingRepository
  invoiceId: string
  projectId: string
  subscriptionId: string
  currentMetadata: unknown
  outcome: "success" | "failure"
  failureMessage?: string
  eventId: string
  now: number
}): Promise<Result<void, FetchError>> {
  const metadata = (currentMetadata ?? {}) as {
    subscriptionReconciledOutcome?: "success" | "failure"
  } & Record<string, unknown>

  if (metadata.subscriptionReconciledOutcome === outcome) {
    deps.logger.info("webhook reconcile skipped: subscription already reconciled with outcome", {
      invoiceId,
      subscriptionId,
      outcome,
      eventId,
    })
    return Ok(undefined)
  }

  const subscriptionOutcome = await deps.services.subscriptions.reconcilePaymentOutcome({
    projectId,
    subscriptionId,
    invoiceId,
    outcome,
    failureMessage,
    now,
  })

  if (subscriptionOutcome.err) {
    return Err(
      new FetchError({
        message: subscriptionOutcome.err.message,
        retry: false,
      })
    )
  }

  // Persist the marker so a webhook retry that lands here after a previous
  // attempt's reconcile committed (but its overall apply step failed
  // afterward) skips the machine call instead of replaying a redundant
  // PAYMENT_SUCCESS / PAYMENT_FAILURE event. Best-effort: a marker write
  // failure does not roll back the reconcile and does not fail the webhook
  // — replay-safety is restored on the next retry. Logged for ops.
  try {
    await billingRepo.updateInvoice({
      invoiceId,
      projectId,
      data: {
        metadata: {
          ...metadata,
          subscriptionReconciledAt: now,
          subscriptionReconciledOutcome: outcome,
        },
        updatedAtM: now,
      },
    })
  } catch (markerError) {
    deps.logger.warn("webhook reconcile marker write failed (best-effort)", {
      invoiceId,
      subscriptionId,
      outcome,
      eventId,
      error: markerError instanceof Error ? markerError.message : String(markerError),
    })
  }

  return Ok(undefined)
}

export async function processWebhookEvent(
  deps: ProcessWebhookEventDeps,
  input: ProcessWebhookEventInput
): Promise<Result<ProcessWebhookEventOutput, FetchError | UnPriceCustomerError>> {
  const now = Date.now()

  deps.logger.set({
    business: {
      operation: "payment_provider.process_webhook_event",
      project_id: input.projectId,
    },
  })

  const { err: paymentProviderErr, val: paymentProviderService } =
    await deps.services.customers.getPaymentProvider({
      projectId: input.projectId,
      provider: input.provider,
    })

  if (paymentProviderErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: paymentProviderErr.message,
      })
    )
  }

  const { err: verifyErr, val: verifiedWebhook } = await paymentProviderService.verifyWebhook({
    rawBody: input.rawBody,
    headers: input.headers,
  })

  if (verifyErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: verifyErr.message,
      })
    )
  }

  const { err: normalizeErr, val: normalizedWebhook } =
    paymentProviderService.normalizeWebhook(verifiedWebhook)

  if (normalizeErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: normalizeErr.message,
      })
    )
  }

  const newWebhookEventId = newId("event")
  const signature = pickProviderSignature({
    provider: input.provider,
    headers: input.headers,
  })
  const sanitizedHeaders = sanitizeWebhookHeaders(input.headers)

  // Mutual exclusion + state-machine guards. The whole gate (insert /
  // dedup / mark processing / apply / mark processed) runs in a single
  // transaction holding `pg_try_advisory_xact_lock`. The lock is keyed on
  // (projectId, provider, providerEventId) and released at commit. Two
  // concurrent identical webhooks → only one acquires the lock; the other
  // bails immediately with `duplicate` and writes nothing. Re-deliveries
  // arriving after the original commits see `status='processed'` and bail
  // at the dedup check below.
  type GateResult =
    | { kind: "duplicate"; webhookEventId: string }
    | { kind: "applied"; webhookEventId: string; applied: ApplyWebhookEventOutput }
    | { kind: "failure"; webhookEventId: string; error: FetchError }

  let gateResult: GateResult
  try {
    gateResult = await deps.db.transaction(async (tx) => {
      const acquired = await tryAcquireWebhookLock({
        tx,
        projectId: input.projectId,
        provider: input.provider,
        providerEventId: normalizedWebhook.eventId,
      })

      if (!acquired) {
        // Another worker is currently processing this exact event. Look up
        // the existing row id (if any) for the response — best-effort, it
        // may not yet be visible if the holder hasn't reached its INSERT.
        const existing = await tx.query.webhookEvents.findFirst({
          where: (table, ops) =>
            ops.and(
              ops.eq(table.projectId, input.projectId),
              ops.eq(table.provider, input.provider),
              ops.eq(table.providerEventId, normalizedWebhook.eventId)
            ),
        })
        deps.logger.warn("webhook concurrent delivery rejected as duplicate", {
          projectId: input.projectId,
          provider: input.provider,
          providerEventId: normalizedWebhook.eventId,
        })
        return {
          kind: "duplicate" as const,
          webhookEventId: existing?.id ?? newWebhookEventId,
        }
      }

      await tx
        .insert(webhookEvents)
        .values({
          id: newWebhookEventId,
          projectId: input.projectId,
          provider: input.provider,
          providerEventId: normalizedWebhook.eventId,
          rawPayload: input.rawBody,
          signature,
          headers: sanitizedHeaders,
          status: "processing",
          attempts: 1,
          errorPayload: null,
        })
        .onConflictDoNothing()

      const storedEvent = await tx.query.webhookEvents.findFirst({
        where: (table, ops) =>
          ops.and(
            ops.eq(table.projectId, input.projectId),
            ops.eq(table.provider, input.provider),
            ops.eq(table.providerEventId, normalizedWebhook.eventId)
          ),
      })

      if (!storedEvent) {
        return {
          kind: "failure" as const,
          webhookEventId: newWebhookEventId,
          error: new FetchError({
            message: "Failed to persist webhook event",
            retry: false,
          }),
        }
      }

      // Already-finalized event. Holding the advisory lock means we are the
      // only writer right now; status='processed' is authoritative and we
      // must not re-apply.
      if (storedEvent.status === "processed") {
        return { kind: "duplicate" as const, webhookEventId: storedEvent.id }
      }

      // Either we just inserted (status='processing'), or this is a retry
      // of a prior failed/abandoned attempt. Bump attempts and proceed.
      if (storedEvent.id !== newWebhookEventId) {
        await tx
          .update(webhookEvents)
          .set({
            status: "processing",
            attempts: (storedEvent.attempts ?? 0) + 1,
            errorPayload: null,
            processedAtM: null,
            updatedAtM: now,
          })
          .where(
            and(eq(webhookEvents.projectId, input.projectId), eq(webhookEvents.id, storedEvent.id))
          )
      }

      try {
        const applied = await applyWebhookEvent({
          deps,
          projectId: input.projectId,
          normalizedEvent: normalizedWebhook,
          now,
        })

        if (applied.err) {
          // Surface to outer catch so we mark webhook_events.failed.
          throw applied.err
        }

        await tx
          .update(webhookEvents)
          .set({
            status: "processed",
            processedAtM: now,
            errorPayload: null,
            updatedAtM: now,
          })
          .where(
            and(eq(webhookEvents.projectId, input.projectId), eq(webhookEvents.id, storedEvent.id))
          )

        return {
          kind: "applied" as const,
          webhookEventId: storedEvent.id,
          applied: applied.val,
        }
      } catch (error) {
        // Persist the failure inside the same tx so the row reflects the
        // latest attempt before we commit and release the lock. The next
        // delivery will see status='failed' and the framework retry path
        // can re-enter once the provider re-delivers.
        const failure = toFailureError(error)

        await tx
          .update(webhookEvents)
          .set({
            status: "failed",
            processedAtM: now,
            updatedAtM: now,
            errorPayload: {
              message: failure.message,
              details: {
                providerEventId: normalizedWebhook.eventId,
                providerEventType: normalizedWebhook.providerEventType,
              },
            },
          })
          .where(
            and(eq(webhookEvents.projectId, input.projectId), eq(webhookEvents.id, storedEvent.id))
          )

        return {
          kind: "failure" as const,
          webhookEventId: storedEvent.id,
          error: failure,
        }
      }
    })
  } catch (error) {
    // Tx-level failure (e.g. DB connection blew up before our internal
    // try/catch could persist `failed`). Surface so the queue retries.
    return Err(toFailureError(error))
  }

  if (gateResult.kind === "duplicate") {
    return Ok({
      webhookEventId: gateResult.webhookEventId,
      providerEventId: normalizedWebhook.eventId,
      status: "duplicate",
      outcome: normalizeOutcome(normalizedWebhook.eventType),
    })
  }

  if (gateResult.kind === "failure") {
    return Err(gateResult.error)
  }

  return Ok({
    webhookEventId: gateResult.webhookEventId,
    providerEventId: normalizedWebhook.eventId,
    status: "processed",
    outcome: gateResult.applied.outcome,
    invoiceId: gateResult.applied.invoiceId,
    subscriptionId: gateResult.applied.subscriptionId,
    topupId: gateResult.applied.topupId,
  })
}
