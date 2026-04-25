import { type Database, and, eq } from "@unprice/db"
import { webhookEvents } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { Currency, PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { DrizzleBillingRepository } from "../../billing/repository.drizzle"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import type {
  NormalizedProviderWebhook,
  PaymentProviderWebhookHeaders,
} from "../../payment-provider/interface"
import { settlePrepaidInvoiceToWallet } from "./settle-prepaid-invoice-to-wallet"

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
    await billingRepo.updateInvoice({
      invoiceId: invoice.id,
      projectId,
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
    await billingRepo.updateInvoice({
      invoiceId: invoice.id,
      projectId,
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

  await billingRepo.updateInvoice({
    invoiceId: invoice.id,
    projectId,
    data: {
      status: failedStatus,
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
    },
  })

  // Refund accounting (revenue → customer reverse transfers) is owned by
  // the wallet layer. The invoice's failed/unpaid status above already
  // reflects the reversal for downstream consumers.

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
      topupId: applied.val.topupId,
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
