import { type Database, and, eq } from "@unprice/db"
import { invoices, ledgerEntries, ledgers, webhookEvents } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import type {
  NormalizedProviderWebhook,
  PaymentProviderWebhookHeaders,
} from "../../payment-provider/interface"

type ProcessWebhookEventDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions">
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
  | "ignored"

type ProcessWebhookEventOutput = {
  webhookEventId: string
  providerEventId: string
  status: ProcessWebhookEventStatus
  outcome: ProcessWebhookEventOutcome
  invoiceId?: string
  subscriptionId?: string
}

type ApplyWebhookEventOutput = {
  outcome: ProcessWebhookEventOutcome
  invoiceId?: string
  subscriptionId?: string
}

const PROCESSING_WEBHOOK_STATUSES = new Set(["processed", "processing"] as const)

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

function nextPaymentAttempts({
  currentAttempts,
  status,
  now,
}: {
  currentAttempts: { status: string; createdAt: number }[] | null
  status: string
  now: number
}): { status: string; createdAt: number }[] {
  return [...(currentAttempts ?? []), { status, createdAt: now }]
}

async function confirmLedgerSettlementByInvoiceId({
  deps,
  projectId,
  invoiceId,
}: {
  deps: ProcessWebhookEventDeps
  projectId: string
  invoiceId: string
}): Promise<void> {
  await deps.db
    .update(ledgerEntries)
    .set({
      settlementPendingProviderConfirmation: false,
      updatedAtM: Date.now(),
    })
    .where(
      and(
        eq(ledgerEntries.projectId, projectId),
        eq(ledgerEntries.settlementType, "invoice"),
        eq(ledgerEntries.settlementArtifactId, invoiceId),
        eq(ledgerEntries.settlementPendingProviderConfirmation, true)
      )
    )
}

async function reopenLedgerSettlementByInvoiceId({
  deps,
  projectId,
  invoiceId,
  now,
}: {
  deps: ProcessWebhookEventDeps
  projectId: string
  invoiceId: string
  now: number
}): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const relatedEntries = await tx.query.ledgerEntries.findMany({
      where: (entry, ops) =>
        ops.and(
          ops.eq(entry.projectId, projectId),
          ops.eq(entry.settlementType, "invoice"),
          ops.eq(entry.settlementArtifactId, invoiceId)
        ),
    })

    const entriesToReopen = relatedEntries.filter((entry) => entry.settledAt !== null)
    if (entriesToReopen.length === 0) {
      return
    }

    for (const entry of entriesToReopen) {
      await tx
        .update(ledgerEntries)
        .set({
          settlementType: null,
          settlementArtifactId: null,
          settlementPendingProviderConfirmation: false,
          settledAt: null,
          updatedAtM: now,
        })
        .where(and(eq(ledgerEntries.projectId, entry.projectId), eq(ledgerEntries.id, entry.id)))
    }

    const signedAmountByLedger = entriesToReopen.reduce((acc, entry) => {
      acc.set(entry.ledgerId, (acc.get(entry.ledgerId) ?? 0) + entry.signedAmountCents)
      return acc
    }, new Map<string, number>())

    for (const [ledgerId, signedAmount] of signedAmountByLedger.entries()) {
      const ledger = await tx.query.ledgers.findFirst({
        where: (table, ops) =>
          ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, ledgerId)),
      })

      if (!ledger) {
        continue
      }

      await tx
        .update(ledgers)
        .set({
          unsettledBalanceCents: ledger.unsettledBalanceCents + signedAmount,
          updatedAtM: now,
        })
        .where(and(eq(ledgers.projectId, projectId), eq(ledgers.id, ledgerId)))
    }
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

  if (!normalizedEvent.invoiceId) {
    return Ok({
      outcome: "ignored",
    })
  }
  const providerInvoiceId = normalizedEvent.invoiceId

  const invoice = await deps.db.query.invoices.findFirst({
    where: (table, ops) =>
      ops.and(
        ops.eq(table.projectId, projectId),
        ops.eq(table.invoicePaymentProviderId, providerInvoiceId)
      ),
  })

  if (!invoice) {
    return Ok({
      outcome: "ignored",
    })
  }

  if (normalizedEvent.eventType === "payment.succeeded") {
    const alreadyPaid = invoice.status === "paid"
    await deps.db
      .update(invoices)
      .set({
        status: "paid",
        paidAt: invoice.paidAt ?? normalizedEvent.occurredAt,
        invoicePaymentProviderUrl: normalizedEvent.invoiceUrl ?? invoice.invoicePaymentProviderUrl,
        paymentAttempts: alreadyPaid
          ? invoice.paymentAttempts
          : nextPaymentAttempts({
              currentAttempts: invoice.paymentAttempts ?? null,
              status: "paid",
              now,
            }),
        metadata: {
          ...(invoice.metadata ?? {}),
          reason: "payment_received",
          note: "Payment confirmed by provider webhook",
        },
        updatedAtM: now,
      })
      .where(and(eq(invoices.projectId, projectId), eq(invoices.id, invoice.id)))

    await confirmLedgerSettlementByInvoiceId({
      deps,
      projectId,
      invoiceId: invoice.id,
    })

    const subscriptionOutcome = await deps.services.subscriptions.reconcilePaymentOutcome({
      projectId,
      subscriptionId: invoice.subscriptionId,
      invoiceId: invoice.id,
      outcome: "success",
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

    return Ok({
      outcome,
      invoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
    })
  }

  if (normalizedEvent.eventType === "payment.dispute_reversed") {
    await deps.db
      .update(invoices)
      .set({
        status: "paid",
        paidAt: invoice.paidAt ?? normalizedEvent.occurredAt,
        paymentAttempts: nextPaymentAttempts({
          currentAttempts: invoice.paymentAttempts ?? null,
          status: "paid",
          now,
        }),
        metadata: {
          ...(invoice.metadata ?? {}),
          reason: "payment_received",
          note: "Payment reinstated after dispute reversal",
        },
        updatedAtM: now,
      })
      .where(and(eq(invoices.projectId, projectId), eq(invoices.id, invoice.id)))

    await confirmLedgerSettlementByInvoiceId({
      deps,
      projectId,
      invoiceId: invoice.id,
    })

    const subscriptionOutcome = await deps.services.subscriptions.reconcilePaymentOutcome({
      projectId,
      subscriptionId: invoice.subscriptionId,
      invoiceId: invoice.id,
      outcome: "success",
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

    return Ok({
      outcome,
      invoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
    })
  }

  const failedStatus = normalizedEvent.eventType === "payment.failed" ? "unpaid" : "failed"

  await deps.db
    .update(invoices)
    .set({
      status: failedStatus,
      paymentAttempts: nextPaymentAttempts({
        currentAttempts: invoice.paymentAttempts ?? null,
        status: failedStatus,
        now,
      }),
      metadata: {
        ...(invoice.metadata ?? {}),
        reason: "payment_failed",
        note:
          normalizedEvent.failureMessage ??
          (normalizedEvent.eventType === "payment.reversed"
            ? "Payment reversed by provider"
            : "Payment failed from provider webhook"),
      },
      updatedAtM: now,
    })
    .where(and(eq(invoices.projectId, projectId), eq(invoices.id, invoice.id)))

  if (normalizedEvent.eventType === "payment.reversed") {
    await reopenLedgerSettlementByInvoiceId({
      deps,
      projectId,
      invoiceId: invoice.id,
      now,
    })
  }

  const subscriptionOutcome = await deps.services.subscriptions.reconcilePaymentOutcome({
    projectId,
    subscriptionId: invoice.subscriptionId,
    invoiceId: invoice.id,
    outcome: "failure",
    failureMessage:
      normalizedEvent.failureMessage ??
      (normalizedEvent.eventType === "payment.reversed"
        ? "Payment reversed by provider"
        : "Payment failed from provider webhook"),
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

  return Ok({
    outcome,
    invoiceId: invoice.id,
    subscriptionId: invoice.subscriptionId,
  })
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

  const webhookEventId = newId("event")
  const signature = pickProviderSignature({
    provider: input.provider,
    headers: input.headers,
  })
  const sanitizedHeaders = sanitizeWebhookHeaders(input.headers)

  await deps.db
    .insert(webhookEvents)
    .values({
      id: webhookEventId,
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

  const storedEvent = await deps.db.query.webhookEvents.findFirst({
    where: (table, ops) =>
      ops.and(
        ops.eq(table.projectId, input.projectId),
        ops.eq(table.provider, input.provider),
        ops.eq(table.providerEventId, normalizedWebhook.eventId)
      ),
  })

  if (!storedEvent) {
    return Err(
      new FetchError({
        message: "Failed to persist webhook event",
        retry: false,
      })
    )
  }

  if (storedEvent.id !== webhookEventId) {
    if (PROCESSING_WEBHOOK_STATUSES.has(storedEvent.status as "processed" | "processing")) {
      return Ok({
        webhookEventId: storedEvent.id,
        providerEventId: normalizedWebhook.eventId,
        status: "duplicate",
        outcome: normalizeOutcome(normalizedWebhook.eventType),
      })
    }

    await deps.db
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
      throw applied.err
    }

    const persistedWebhookEventId = storedEvent.id

    await deps.db
      .update(webhookEvents)
      .set({
        status: "processed",
        processedAtM: now,
        errorPayload: null,
        updatedAtM: now,
      })
      .where(
        and(
          eq(webhookEvents.projectId, input.projectId),
          eq(webhookEvents.id, persistedWebhookEventId)
        )
      )

    return Ok({
      webhookEventId: persistedWebhookEventId,
      providerEventId: normalizedWebhook.eventId,
      status: "processed",
      outcome: applied.val.outcome,
      invoiceId: applied.val.invoiceId,
      subscriptionId: applied.val.subscriptionId,
    })
  } catch (error) {
    const failure = toFailureError(error)

    await deps.db
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

    return Err(failure)
  }
}
