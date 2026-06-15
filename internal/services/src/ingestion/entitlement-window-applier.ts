import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import type { MeterConfig } from "@unprice/db/validators"
import type { IngestionEntitlement, IngestionGrant } from "./entitlement-context"
import { getMessageOutcomeKey } from "./fanout-outcomes"
import type { EntitlementWindowState, IngestionRejectionReason } from "./interface"
import type { IngestionQueueMessage } from "./message"

type EntitlementWindowApplySource = IngestionQueueMessage["source"] & {
  workspaceId: string
}

export type EntitlementWindowApplyResult = {
  allowed: boolean
  deniedReason?: Extract<
    IngestionRejectionReason,
    "LIMIT_EXCEEDED" | "WALLET_EMPTY" | "LATE_EVENT_CLOSED_PERIOD" | "RUN_BUDGET_EXCEEDED"
  >
  meterFacts?: AnalyticsEntitlementMeterFact[]
  message?: string
}

export type EntitlementWindowApplyBatchEvent = {
  correlationKey: string
  id: string
  idempotencyKey: string
  now: number
  properties: Record<string, unknown>
  source: EntitlementWindowApplySource
  slug: string
  timestamp: number
}

export type EntitlementWindowApplyBatchResult = EntitlementWindowApplyResult & {
  correlationKey: string
  idempotencyKey: string
}

export type EntitlementWindowStateInput = {
  entitlement: IngestionEntitlement & { meterConfig: MeterConfig }
  grants: IngestionGrant[]
  now: number
}

export type EntitlementWindowApplyInput = {
  customerId: string
  enforceLimit: boolean
  entitlement: IngestionEntitlement & { meterConfig: MeterConfig }
  event: {
    id: string
    properties: Record<string, unknown>
    source: EntitlementWindowApplySource
    slug: string
    timestamp: number
  }
  grants: IngestionGrant[]
  idempotencyKey: string
  now: number
  projectId: string
  /** When "external_reservation", the DO skips wallet reservation I/O and uses externalReservation.remainingAmount for budget checks. */
  walletMode?: "standard" | "external_reservation"
  /** Required when walletMode is "external_reservation". */
  externalReservation?: { remainingAmount: number }
}

export type EntitlementWindowStatus = {
  durableObjectId: string
  lastIdempotencyCleanupAt: number | null
  nextAlarmAt: number | null
  outboxCount: number
  walletReservation: {
    allocationAmount: number
    billingPeriodId: string | null
    consumedAmount: number
    currency: string | null
    cycleEndAt: number | null
    cycleStartAt: number | null
    customerId: string | null
    deletionRequested: boolean
    featurePlanVersionItemId: string | null
    flushedAmount: number
    flushSeq: number
    lastEventAt: number | null
    lastFlushedAt: number | null
    pendingFlushAmount: number | null
    pendingFlushFinal: boolean
    pendingFlushSeq: number | null
    pendingRefillAmount: number
    projectId: string | null
    recoveryRequired: boolean
    refillInFlight: boolean
    reservationEndAt: number | null
    reservationId: string | null
    statementKey: string | null
    unflushedAmount: number
  } | null
}

export type FlushReservationForInvoicingInput = {
  statementKey: string
  billingPeriodIds: string[]
}

export type FlushReservationForInvoicingResult = {
  ok: boolean
  outcome:
    | "deferred"
    | "flushed"
    | "no_reservation"
    | "no_unflushed_usage"
    | "recovery_required"
    | "statement_mismatch"
    | "wallet_error"
  errorMessage?: string
}

export type EntitlementWindowController = {
  apply: (input: EntitlementWindowApplyInput) => Promise<EntitlementWindowApplyResult>
  applyBatch?: (input: {
    customerId: string
    enforceLimit: boolean
    entitlement: IngestionEntitlement & { meterConfig: MeterConfig }
    events: EntitlementWindowApplyBatchEvent[]
    grants: IngestionGrant[]
    projectId: string
  }) => Promise<{ results: EntitlementWindowApplyBatchResult[] }>
  getEnforcementState: (input?: EntitlementWindowStateInput) => Promise<EntitlementWindowState>
  getStatus?: () => Promise<EntitlementWindowStatus>
  flushReservationForInvoicing?: (
    input: FlushReservationForInvoicingInput
  ) => Promise<FlushReservationForInvoicingResult>
}

export interface EntitlementWindowClient {
  getEntitlementWindowStub(params: {
    customerEntitlementId: string
    customerId: string
    projectId: string
  }): EntitlementWindowController
}

export class EntitlementWindowApplier {
  constructor(private readonly entitlementWindowClient: EntitlementWindowClient) {}

  public async applyBatch(params: {
    customerId: string
    enforceLimit: boolean
    entitlement: IngestionEntitlement
    messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<EntitlementWindowApplyBatchResult[]> {
    const { customerId, enforceLimit, entitlement, messageOutcomeKeys, messages, projectId } =
      params

    if (!entitlement.meterConfig) {
      return messages.map((message) => ({
        allowed: false,
        correlationKey: getMessageOutcomeKey(message, messageOutcomeKeys),
        deniedReason: "LIMIT_EXCEEDED",
        idempotencyKey: message.idempotencyKey,
        message: "Usage entitlement is missing meter configuration",
      }))
    }

    const stub = this.getStub({ customerId, entitlement, projectId })
    const applyEntitlement = {
      ...entitlement,
      meterConfig: entitlement.meterConfig,
    }

    if (!stub.applyBatch) {
      return this.applySequentially({
        applyEntitlement,
        customerId,
        enforceLimit,
        entitlement,
        messageOutcomeKeys,
        messages,
        projectId,
        stub,
      })
    }

    const batchResult = await stub.applyBatch({
      events: messages.map((message) => ({
        correlationKey: getMessageOutcomeKey(message, messageOutcomeKeys),
        id: message.id,
        slug: message.slug,
        timestamp: message.timestamp,
        properties: message.properties,
        source: buildEntitlementWindowApplySource(message),
        idempotencyKey: message.idempotencyKey,
        now: message.receivedAt,
      })),
      entitlement: applyEntitlement,
      projectId,
      customerId,
      grants: entitlement.grants,
      enforceLimit,
    })

    return mapBatchResultsToMessages(batchResult.results, messages, messageOutcomeKeys)
  }

  public async apply(params: {
    customerId: string
    enforceLimit: boolean
    entitlement: IngestionEntitlement
    message: IngestionQueueMessage
    projectId: string
  }): Promise<EntitlementWindowApplyResult> {
    const { customerId, enforceLimit, entitlement, message, projectId } = params

    if (!entitlement.meterConfig) {
      return {
        allowed: false,
        deniedReason: "LIMIT_EXCEEDED",
        message: "Usage entitlement is missing meter configuration",
      }
    }

    const stub = this.getStub({ customerId, entitlement, projectId })
    const applyEntitlement = {
      ...entitlement,
      meterConfig: entitlement.meterConfig,
    }

    return stub.apply({
      event: {
        id: message.id,
        slug: message.slug,
        timestamp: message.timestamp,
        properties: message.properties,
        source: buildEntitlementWindowApplySource(message),
      },
      entitlement: applyEntitlement,
      idempotencyKey: message.idempotencyKey,
      projectId,
      customerId,
      grants: entitlement.grants,
      enforceLimit,
      now: message.receivedAt,
    })
  }

  private async applySequentially(params: {
    applyEntitlement: IngestionEntitlement & { meterConfig: MeterConfig }
    customerId: string
    enforceLimit: boolean
    entitlement: IngestionEntitlement
    messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>
    messages: IngestionQueueMessage[]
    projectId: string
    stub: EntitlementWindowController
  }): Promise<EntitlementWindowApplyBatchResult[]> {
    const {
      applyEntitlement,
      customerId,
      enforceLimit,
      entitlement,
      messageOutcomeKeys,
      messages,
      projectId,
      stub,
    } = params
    const results: EntitlementWindowApplyBatchResult[] = []

    for (const message of messages) {
      const result = await stub.apply({
        event: {
          id: message.id,
          slug: message.slug,
          timestamp: message.timestamp,
          properties: message.properties,
          source: buildEntitlementWindowApplySource(message),
        },
        entitlement: applyEntitlement,
        idempotencyKey: message.idempotencyKey,
        projectId,
        customerId,
        grants: entitlement.grants,
        enforceLimit,
        now: message.receivedAt,
      })
      results.push({
        ...result,
        correlationKey: getMessageOutcomeKey(message, messageOutcomeKeys),
        idempotencyKey: message.idempotencyKey,
      })
    }

    return results
  }

  private getStub(params: {
    customerId: string
    entitlement: IngestionEntitlement
    projectId: string
  }): EntitlementWindowController {
    return this.entitlementWindowClient.getEntitlementWindowStub({
      customerEntitlementId: params.entitlement.customerEntitlementId,
      customerId: params.customerId,
      projectId: params.projectId,
    })
  }
}

function mapBatchResultsToMessages(
  results: EntitlementWindowApplyBatchResult[],
  messages: IngestionQueueMessage[],
  messageOutcomeKeys: ReadonlyMap<IngestionQueueMessage, string>
): EntitlementWindowApplyBatchResult[] {
  const resultsByKey = new Map(results.map((result) => [result.correlationKey, result]))

  return messages.map((message) => {
    const correlationKey = getMessageOutcomeKey(message, messageOutcomeKeys)
    const result = resultsByKey.get(correlationKey)

    if (!result) {
      throw new Error(`entitlement window batch result missing message outcome: ${correlationKey}`)
    }

    if (result.idempotencyKey !== message.idempotencyKey) {
      throw new Error(`entitlement window batch result idempotency mismatch: ${correlationKey}`)
    }

    return { ...result, idempotencyKey: message.idempotencyKey, correlationKey }
  })
}

function buildEntitlementWindowApplySource(
  message: IngestionQueueMessage
): EntitlementWindowApplySource {
  return {
    workspaceId: message.workspaceId,
    ...message.source,
  }
}
