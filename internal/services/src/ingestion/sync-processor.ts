import type {
  CustomerGrantContextReader,
  IngestionEntitlement,
  PreparedCustomerGrantContext,
} from "./entitlement-context"
import {
  hasBillingPeriodCoveringEvent,
  resolveCustomerGrantContextWindow,
} from "./entitlement-context"
import type { IngestionEntitlementRouter } from "./entitlement-routing"
import type { EntitlementWindowApplier } from "./entitlement-window-applier"
import type { FanoutMessageOutcome as MessageOutcome } from "./fanout-outcomes"
import type {
  IngestionIdempotencyStatus,
  IngestionOutcome,
  IngestionRejectionReason,
  IngestionSyncResult,
} from "./interface"
import type { IngestionQueueMessage } from "./message"
import { type IngestionMessageOutcomes, toSyncResult } from "./message-outcomes"
import type { IngestionReportingOutcomeDispatcher } from "./reporting-dispatcher"
import type { IngestionSubscriptionCatchUp } from "./subscription-catchup"

type SyncEntitlementResolution =
  | { kind: "resolved"; entitlement: IngestionEntitlement }
  | { kind: "rejected"; rejectionReason: IngestionRejectionReason }

type PreparedSyncApplyResult =
  | {
      idempotencyStatus: IngestionIdempotencyStatus
      state: "processed"
      meterFacts: MessageOutcome["meterFacts"]
    }
  | {
      idempotencyStatus: IngestionIdempotencyStatus
      state: "rejected"
      messageText?: string
      rejectionReason: IngestionRejectionReason
    }

export class IngestionSyncProcessor {
  private readonly entitlementContext: CustomerGrantContextReader
  private readonly entitlementRouter: IngestionEntitlementRouter
  private readonly entitlementWindowApplier: EntitlementWindowApplier
  private readonly messageOutcomes: IngestionMessageOutcomes
  private readonly now: () => number
  private readonly reportingDispatcher: IngestionReportingOutcomeDispatcher
  private readonly subscriptionCatchUp?: IngestionSubscriptionCatchUp

  constructor(opts: {
    entitlementContext: CustomerGrantContextReader
    entitlementRouter: IngestionEntitlementRouter
    entitlementWindowApplier: EntitlementWindowApplier
    messageOutcomes: IngestionMessageOutcomes
    now: () => number
    reportingDispatcher: IngestionReportingOutcomeDispatcher
    subscriptionCatchUp?: IngestionSubscriptionCatchUp
  }) {
    this.entitlementContext = opts.entitlementContext
    this.entitlementRouter = opts.entitlementRouter
    this.entitlementWindowApplier = opts.entitlementWindowApplier
    this.messageOutcomes = opts.messageOutcomes
    this.now = opts.now
    this.reportingDispatcher = opts.reportingDispatcher
    this.subscriptionCatchUp = opts.subscriptionCatchUp
  }

  public async ingestFeatureSync(params: {
    featureSlug: string
    message: IngestionQueueMessage
  }): Promise<IngestionSyncResult> {
    const { featureSlug, message } = params
    const { customerId, projectId } = message

    const staleRejection = this.resolveStaleSyncMessageRejection({
      customerId,
      message,
      projectId,
    })
    if (staleRejection) {
      return staleRejection
    }

    const preparedContext = await this.prepareSyncContext({
      customerId,
      message,
      projectId,
    })

    if (preparedContext.rejectionReason) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: preparedContext.rejectionReason,
      })
    }

    const applyContext = await this.refreshSyncContextForMissingBillingPeriod({
      customerId,
      featureSlug,
      message,
      preparedContext,
      projectId,
    })
    if (applyContext.rejectionReason) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: applyContext.rejectionReason,
      })
    }

    const applyResult = await this.applyPreparedSyncMessage({
      featureSlug,
      message,
      preparedContext: applyContext,
    })
    if (
      applyResult.state === "processed" ||
      applyResult.rejectionReason !== "WALLET_EMPTY" ||
      this.subscriptionCatchUp === undefined
    ) {
      return this.reportPreparedSyncApplyResult({
        message,
        result: applyResult,
      })
    }

    const catchUp = await this.subscriptionCatchUp.catchUpForPreparedGroup({
      candidateEntitlements: applyContext.candidateEntitlements,
      customerId,
      messages: [message],
      projectId,
    })
    if (!catchUp.changed) {
      return this.reportPreparedSyncApplyResult({
        message,
        result: applyResult,
      })
    }

    const refreshedContext = await this.prepareSyncContext({
      customerId,
      message,
      projectId,
    })
    if (refreshedContext.rejectionReason) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: refreshedContext.rejectionReason,
      })
    }

    const refreshedResult = await this.applyPreparedSyncMessage({
      featureSlug,
      message,
      preparedContext: refreshedContext,
    })
    return this.reportPreparedSyncApplyResult({
      message,
      result: refreshedResult,
    })
  }

  private prepareSyncContext(params: {
    customerId: string
    message: IngestionQueueMessage
    projectId: string
  }): Promise<PreparedCustomerGrantContext> {
    return this.entitlementContext.prepareCustomerGrantContext({
      customerId: params.customerId,
      projectId: params.projectId,
      ...resolveCustomerGrantContextWindow({
        earliestTimestamp: params.message.timestamp,
        latestTimestamp: params.message.timestamp,
      }),
    })
  }

  private async refreshSyncContextForMissingBillingPeriod(params: {
    customerId: string
    featureSlug: string
    message: IngestionQueueMessage
    preparedContext: PreparedCustomerGrantContext
    projectId: string
  }): Promise<PreparedCustomerGrantContext> {
    const { customerId, featureSlug, message, preparedContext, projectId } = params
    if (this.subscriptionCatchUp === undefined) {
      return preparedContext
    }

    const entitlementResolution = this.resolveSyncEntitlement({
      candidateEntitlements: preparedContext.candidateEntitlements,
      featureSlug,
      message,
    })
    if (
      entitlementResolution.kind === "rejected" ||
      hasBillingPeriodCoveringEvent(entitlementResolution.entitlement, message.timestamp)
    ) {
      return preparedContext
    }

    const catchUp = await this.subscriptionCatchUp.catchUpForPreparedGroup({
      candidateEntitlements: preparedContext.candidateEntitlements,
      customerId,
      messages: [message],
      projectId,
    })
    if (!catchUp.changed) {
      return preparedContext
    }

    return this.prepareSyncContext({
      customerId,
      message,
      projectId,
    })
  }

  private async applyPreparedSyncMessage(params: {
    featureSlug: string
    message: IngestionQueueMessage
    preparedContext: PreparedCustomerGrantContext
  }): Promise<PreparedSyncApplyResult> {
    const { featureSlug, message, preparedContext } = params
    const { customerId, projectId } = message

    const entitlementResolution = this.resolveSyncEntitlement({
      candidateEntitlements: preparedContext.candidateEntitlements,
      featureSlug,
      message,
    })
    if (entitlementResolution.kind === "rejected") {
      return {
        idempotencyStatus: "new",
        state: "rejected",
        rejectionReason: entitlementResolution.rejectionReason,
      }
    }

    if (
      requiresBillingPeriodContext(entitlementResolution.entitlement) &&
      !hasBillingPeriodCoveringEvent(entitlementResolution.entitlement, message.timestamp)
    ) {
      return {
        idempotencyStatus: "new",
        state: "rejected",
        rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
        messageText: "No active billing period covers this event timestamp",
      }
    }

    const applyResult = await this.entitlementWindowApplier.apply({
      customerId,
      enforceLimit: true,
      entitlement: entitlementResolution.entitlement,
      message,
      projectId,
    })

    if (!applyResult.allowed) {
      return {
        idempotencyStatus: applyResult.idempotencyStatus ?? "new",
        state: "rejected",
        rejectionReason: applyResult.deniedReason ?? "LIMIT_EXCEEDED",
        messageText: applyResult.message,
      }
    }

    return {
      idempotencyStatus: applyResult.idempotencyStatus ?? "new",
      state: "processed",
      meterFacts: applyResult.meterFacts,
    }
  }

  private reportPreparedSyncApplyResult(params: {
    message: IngestionQueueMessage
    result: PreparedSyncApplyResult
  }): Promise<IngestionSyncResult> {
    const { message, result } = params

    if (result.state === "processed") {
      return this.reportProcessedSyncMessage({
        idempotencyStatus: result.idempotencyStatus,
        message,
        meterFacts: result.meterFacts,
      })
    }

    return this.rejectSyncMessage({
      customerId: message.customerId,
      idempotencyStatus: result.idempotencyStatus,
      message,
      messageText: result.messageText,
      projectId: message.projectId,
      rejectionReason: result.rejectionReason,
    })
  }

  private resolveStaleSyncMessageRejection(params: {
    customerId: string
    message: IngestionQueueMessage
    projectId: string
  }): Promise<IngestionSyncResult> | null {
    const { customerId, message, projectId } = params
    const tooOldOutcome = this.messageOutcomes.resolveTooOldOutcome({
      customerId,
      message,
      now: this.now(),
      projectId,
    })

    if (!tooOldOutcome) {
      return null
    }

    return this.rejectSyncMessage({
      customerId,
      message,
      messageText: "Event timestamp is older than the maximum accepted age",
      projectId,
      rejectionReason: "EVENT_TOO_OLD",
    })
  }

  private resolveSyncEntitlement(params: {
    candidateEntitlements: PreparedCustomerGrantContext["candidateEntitlements"]
    featureSlug: string
    message: IngestionQueueMessage
  }): SyncEntitlementResolution {
    const processableEntitlementsResult =
      this.entitlementRouter.resolveSyncFeatureEntitlements(params)

    if (processableEntitlementsResult.err) {
      return { kind: "rejected", rejectionReason: processableEntitlementsResult.err }
    }

    const [entitlement] = processableEntitlementsResult.val
    if (!entitlement) {
      return { kind: "rejected", rejectionReason: "UNROUTABLE_EVENT" }
    }

    return { kind: "resolved", entitlement }
  }

  private async reportProcessedSyncMessage(params: {
    idempotencyStatus: IngestionIdempotencyStatus
    message: IngestionQueueMessage
    meterFacts: MessageOutcome["meterFacts"]
  }): Promise<IngestionSyncResult> {
    const { idempotencyStatus, message, meterFacts } = params
    const outcome: IngestionOutcome = { state: "processed" }
    await this.reportingDispatcher.enqueueOutcomes({
      customerId: message.customerId,
      projectId: message.projectId,
      outcomes: [{ message, outcome, meterFacts }],
    })

    return toSyncResult({
      allowed: true,
      idempotencyStatus,
      outcome,
    })
  }

  private async rejectSyncMessage(params: {
    customerId: string
    idempotencyStatus?: IngestionIdempotencyStatus
    message: IngestionQueueMessage
    messageText?: string
    projectId: string
    rejectionReason: IngestionRejectionReason
  }): Promise<IngestionSyncResult> {
    const {
      customerId,
      idempotencyStatus = "new",
      message,
      messageText,
      projectId,
      rejectionReason,
    } = params
    const outcome: IngestionOutcome = { state: "rejected", rejectionReason }
    this.messageOutcomes.logRejectedMessage({
      customerId,
      message,
      projectId,
      rejectionReason: outcome.rejectionReason,
    })
    await this.reportingDispatcher.enqueueOutcomes({
      customerId: message.customerId,
      projectId: message.projectId,
      outcomes: [{ message, outcome }],
    })

    return toSyncResult({
      allowed: false,
      idempotencyStatus,
      message: messageText,
      outcome,
    })
  }
}

function requiresBillingPeriodContext(entitlement: IngestionEntitlement): boolean {
  return entitlement.creditLinePolicy !== "uncapped"
}
