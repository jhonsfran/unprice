import { parseLakehouseEvent } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import type { CustomerService } from "../customers"
import { type GrantsManager, type IngestionResolvedState, MAX_EVENT_AGE_MS } from "../entitlements"
import {
  EVENTS_SCHEMA_VERSION,
  type FeatureVerificationResult,
  type IngestionMessageProcessingResult,
  type IngestionOutcome,
  type IngestionPipelineEvent,
  type IngestionRejectionReason,
  type IngestionSyncResult,
} from "./interface"
import {
  type IngestionQueueMessage,
  computeResolvedStatePeriodEndAt,
  computeResolvedStatePeriodKey,
} from "./message"
import {
  type IngestionCandidateGrants,
  IngestionPreparationService,
  type PreparedCustomerGrantContext,
  type PreparedCustomerMessageGroup,
} from "./preparation-service"
import { IngestionStateResolutionService } from "./state-resolution-service"

type IngestionContext = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  message: IngestionQueueMessage
  projectId: string
}

type ProcessMessageParams = {
  context: IngestionContext
  rejectionReason?: IngestionRejectionReason
}

type HandleMessageParams = {
  context: IngestionContext
  rejectionReason?: IngestionRejectionReason
}

type ApplyResolvedStatesParams = {
  customerId: string
  message: IngestionQueueMessage
  processableStates: IngestionResolvedState[]
  projectId: string
}

type ApplyResolvedStateParams = {
  customerId: string
  enforceLimit: boolean
  message: IngestionQueueMessage
  projectId: string
  state: IngestionResolvedState
}

type MessageLogContext = {
  customerId: string
  eventId: string
  idempotencyKey: string
  projectId: string
}

export type PipelineEventsQueue = {
  send: (events: IngestionPipelineEvent[]) => Promise<void>
}

export type IngestionIdempotencyDecision =
  | {
      decision: "duplicate"
    }
  | {
      decision: "busy"
      retryAfterSeconds?: number
    }
  | {
      decision: "process"
    }

export type IngestionIdempotencyController = {
  abort: (params: { idempotencyKey: string }) => Promise<void>
  begin: (params: { idempotencyKey: string; now: number }) => Promise<IngestionIdempotencyDecision>
  complete: (params: { idempotencyKey: string; now: number; result: string }) => Promise<void>
}

export interface IdempotencyClient {
  getIdempotencyStub(params: {
    customerId: string
    idempotencyKey: string
    projectId: string
  }): IngestionIdempotencyController
}

export type EntitlementWindowApplyInput = {
  customerId: string
  enforceLimit: boolean
  event: {
    id: string
    properties: Record<string, unknown>
    slug: string
    timestamp: number
  }
  featureSlug: string
  idempotencyKey: string
  limit: IngestionResolvedState["limit"]
  meters: IngestionResolvedState["meterConfig"][]
  now: number
  overageStrategy: IngestionResolvedState["overageStrategy"]
  periodEndAt: number
  periodKey: string
  projectId: string
  streamId: string
}

export type EntitlementWindowController = {
  apply: (input: EntitlementWindowApplyInput) => Promise<EntitlementWindowApplyResult>
  getEnforcementState: (input: {
    limit: IngestionResolvedState["limit"]
    meterConfig: IngestionResolvedState["meterConfig"]
    overageStrategy: IngestionResolvedState["overageStrategy"]
  }) => Promise<{
    isLimitReached: boolean
    limit: number | null
    usage: number
  }>
}

export interface EntitlementWindowClient {
  getEntitlementWindowStub(params: {
    customerId: string
    periodKey: string
    projectId: string
    streamId: string
  }): EntitlementWindowController
}

type EntitlementWindowApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED"
  message?: string
}

type Result<T, E> = { err: E; val?: undefined } | { err?: undefined; val: T }

export class IngestionService {
  private readonly preparationService: IngestionPreparationService
  private readonly stateResolutionService: IngestionStateResolutionService
  private readonly customerService: CustomerService
  private readonly grantsManager: GrantsManager
  private readonly entitlementWindowClient: EntitlementWindowClient
  private readonly idempotencyClient: IdempotencyClient
  private readonly logger: Logger
  private readonly now: () => number
  private readonly pipelineEvents: PipelineEventsQueue

  constructor(opts: {
    customerService: CustomerService
    entitlementWindowClient: EntitlementWindowClient
    grantsManager: GrantsManager
    idempotencyClient: IdempotencyClient
    logger: Logger
    pipelineEvents: PipelineEventsQueue
    now?: () => number
  }) {
    this.customerService = opts.customerService
    this.entitlementWindowClient = opts.entitlementWindowClient
    this.idempotencyClient = opts.idempotencyClient
    this.logger = opts.logger
    this.grantsManager = opts.grantsManager
    this.pipelineEvents = opts.pipelineEvents
    this.now = opts.now ?? (() => Date.now())
    this.preparationService = new IngestionPreparationService({
      customerService: this.customerService,
      grantsManager: this.grantsManager,
    })
    this.stateResolutionService = new IngestionStateResolutionService({
      grantsManager: this.grantsManager,
      logger: this.logger,
    })
  }

  // TODO: for EU countries we have to keep the stub in the EU namespace
  // private getStub(
  //   name: string,
  //   locationHint?: DurableObjectLocationHint
  // ): DurableObjectStub<DurableObjectUsagelimiter> {
  //   // jurisdiction is only available in production
  //   if (this.stats.isEUCountry && this.env.APP_ENV === "production") {
  //     const euSubnamespace = this.namespace.jurisdiction("eu")
  //     const euStub = euSubnamespace.get(euSubnamespace.idFromName(name), {
  //       locationHint,
  //     })

  //     return euStub
  //   }

  //   return this.namespace.get(this.namespace.idFromName(name), {
  //     locationHint,
  //   })
  // }

  public async ingestFeatureSync(params: {
    featureSlug: string
    message: IngestionQueueMessage
  }): Promise<IngestionSyncResult> {
    const { featureSlug, message } = params
    const { customerId, projectId } = message
    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      startAt: Math.max(0, message.timestamp - MAX_EVENT_AGE_MS),
      endAt: message.timestamp,
    })

    if (preparedContext.rejectionReason === "CUSTOMER_NOT_FOUND") {
      const outcome = await this.rejectMessage(message, preparedContext.rejectionReason)
      this.logRejectedMessage({
        customerId,
        message,
        projectId,
        rejectionReason: outcome.rejectionReason,
      })

      return this.toSyncResult({
        allowed: false,
        outcome,
      })
    }

    if (preparedContext.rejectionReason) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: preparedContext.rejectionReason,
      })
    }

    const resolvedStatesResult = await this.resolveSyncFeatureState({
      candidateGrants: preparedContext.candidateGrants,
      customerId,
      featureSlug,
      message,
      projectId,
    })

    if (resolvedStatesResult.err) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: resolvedStatesResult.err,
      })
    }

    const [resolvedState] = resolvedStatesResult.val

    if (!resolvedState) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: "UNROUTABLE_EVENT",
      })
    }

    const applyResult = await this.applyResolvedState({
      customerId,
      enforceLimit: true, // throw if limit is hit since is sync check
      message,
      projectId,
      state: resolvedState,
    })

    if (!applyResult) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: "UNROUTABLE_EVENT",
      })
    }

    if (!applyResult.allowed) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: applyResult.deniedReason ?? "LIMIT_EXCEEDED",
        messageText: applyResult.message,
      })
    }

    const outcome = await this.publishOutcome(message, {
      state: "processed",
    })

    return this.toSyncResult({
      allowed: true,
      outcome,
    })
  }

  public async verifyFeatureStatus(params: {
    customerId: string
    featureSlug: string
    projectId: string
    timestamp: number
  }): Promise<FeatureVerificationResult> {
    const { customerId, featureSlug, projectId, timestamp } = params
    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      startAt: Math.max(0, timestamp - MAX_EVENT_AGE_MS),
      endAt: timestamp,
    })

    if (preparedContext.rejectionReason === "CUSTOMER_NOT_FOUND") {
      return {
        allowed: false,
        featureSlug,
        status: "customer_not_found",
        timestamp,
      }
    }

    const resolvedFeatureStateResult = await this.grantsManager.resolveFeatureStateAtTimestamp({
      customerId,
      featureSlug,
      grants: preparedContext.candidateGrants,
      projectId,
      timestamp,
    })

    if (resolvedFeatureStateResult.err) {
      this.logger.warn("invalid active grant configuration for feature verification", {
        customerId,
        error: resolvedFeatureStateResult.err.message,
        featureSlug,
        projectId,
        timestamp,
      })

      return {
        allowed: false,
        featureSlug,
        message: resolvedFeatureStateResult.err.message,
        status: "invalid_entitlement_configuration",
        timestamp,
      }
    }

    const resolvedFeatureState = resolvedFeatureStateResult.val

    if (resolvedFeatureState.kind === "feature_missing") {
      return {
        allowed: false,
        featureSlug,
        status: "feature_missing",
        timestamp,
      }
    }

    if (resolvedFeatureState.kind === "feature_inactive") {
      return {
        allowed: false,
        featureSlug,
        status: "feature_inactive",
        timestamp,
      }
    }

    if (resolvedFeatureState.kind === "non_usage") {
      return {
        allowed: true,
        featureSlug,
        featureType: resolvedFeatureState.entitlement.featureType,
        status: "non_usage",
        timestamp,
      }
    }

    const { state } = resolvedFeatureState
    let periodKey: string | null = null
    try {
      periodKey = computeResolvedStatePeriodKey(state, timestamp)
    } catch (error) {
      const detail = {
        customerId,
        error,
        featureSlug,
        meterConfig: state.meterConfig,
        projectId,
        activeGrantIds: state.activeGrantIds,
        resetConfig: state.resetConfig,
        streamEndAt: state.streamEndAt,
        streamId: state.streamId,
        streamStartAt: state.streamStartAt,
        timestamp,
      }

      this.logger.warn(
        "invalid resolved-state period configuration for feature verification",
        detail
      )
      this.logger.debug(
        "invalid entitlement configuration details for feature verification",
        detail
      )

      return {
        allowed: false,
        featureSlug,
        featureType: "usage",
        message: "Unable to resolve the current meter window for this feature",
        status: "invalid_entitlement_configuration",
        timestamp,
      }
    }

    if (!periodKey) {
      this.logger.warn("unable to resolve feature verification period key", {
        customerId,
        featureSlug,
        projectId,
        streamId: state.streamId,
        timestamp,
      })

      return {
        allowed: false,
        featureSlug,
        featureType: "usage",
        message: "Unable to resolve the current meter window for this feature",
        status: "invalid_entitlement_configuration",
        timestamp,
      }
    }

    const enforcementState = await this.entitlementWindowClient
      .getEntitlementWindowStub({
        customerId,
        periodKey,
        projectId,
        streamId: state.streamId,
      })
      .getEnforcementState({
        limit: state.limit,
        meterConfig: state.meterConfig,
        overageStrategy: state.overageStrategy,
      })

    return {
      allowed: !enforcementState.isLimitReached,
      featureSlug,
      featureType: "usage",
      isLimitReached: enforcementState.isLimitReached,
      limit: enforcementState.limit,
      meterConfig: state.meterConfig,
      overageStrategy: state.overageStrategy,
      periodKey,
      status: "usage",
      streamEndAt: state.streamEndAt,
      streamId: state.streamId,
      streamStartAt: state.streamStartAt,
      timestamp,
      usage: enforcementState.usage,
    }
  }

  public async processCustomerGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<IngestionMessageProcessingResult[]> {
    const { customerId, projectId } = params
    // important to process them in the same order by timestamp
    const messages = [...params.messages].sort(sortIngestionMessages)

    try {
      const preparedGroup = await this.prepareCustomerMessageGroup({
        customerId,
        messages,
        projectId,
      })

      if (preparedGroup.rejectionReason === "CUSTOMER_NOT_FOUND") {
        const results: IngestionMessageProcessingResult[] = []

        for (const message of preparedGroup.messages) {
          await this.rejectMessageWithoutIdempotency({
            customerId,
            message,
            projectId,
            rejectionReason: preparedGroup.rejectionReason,
          })

          results.push(this.ackMessage(message))
        }

        return results
      }

      // once we are sure the customer exists and there are grants that can resolve the event,
      // then we can call the DO
      const results: IngestionMessageProcessingResult[] = []

      for (const message of preparedGroup.messages) {
        results.push(
          await this.processMessage({
            context: {
              candidateGrants: preparedGroup.candidateGrants,
              customerId,
              message,
              projectId,
            },
            rejectionReason: preparedGroup.rejectionReason,
          })
        )
      }

      return results
    } catch (error) {
      this.logger.error("raw ingestion queue processing failed", {
        projectId,
        customerId,
        error,
      })

      return messages.map((message) => this.retryMessage(message))
    }
  }

  /**
   * Process one queued event for the customer after the batch-level grant lookup.
   */
  private async processMessage(
    params: ProcessMessageParams
  ): Promise<IngestionMessageProcessingResult> {
    const { context, rejectionReason } = params
    const { customerId, message, projectId } = context
    const now = this.now()
    const idempotencyKey = message.idempotencyKey
    const logContext: MessageLogContext = {
      projectId,
      customerId,
      eventId: message.id,
      idempotencyKey,
    }

    const idempotencyStub = this.idempotencyClient.getIdempotencyStub({
      projectId,
      customerId,
      idempotencyKey,
    })

    let claimedIdempotency = false

    try {
      const idempotency = await idempotencyStub.begin({
        idempotencyKey,
        now,
      })

      if (idempotency.decision === "duplicate") {
        this.logger.debug("duplicated event", {
          event: message,
        })
        return this.ackMessage(message)
      }

      if (idempotency.decision === "busy") {
        this.logger.debug("idempotency busy", {
          event: message,
        })
        return this.retryMessage(message, idempotency.retryAfterSeconds)
      }

      claimedIdempotency = true

      // if all those validations are good then lets process the message
      const outcome = await this.handleMessage({
        context,
        rejectionReason,
      })

      if (outcome.state === "rejected") {
        this.logRejectedMessage({
          customerId,
          message,
          projectId,
          rejectionReason: outcome.rejectionReason,
        })
      }

      await idempotencyStub.complete({
        idempotencyKey,
        now: this.now(),
        result: JSON.stringify(outcome),
      })

      return this.ackMessage(message)
    } catch (error) {
      this.logger.error("raw ingestion message processing failed", {
        ...logContext,
        error,
      })

      if (claimedIdempotency) {
        await this.abortClaim(idempotencyStub, idempotencyKey, logContext)
      }

      return this.retryMessage(message)
    }
  }

  private async handleMessage(params: HandleMessageParams): Promise<IngestionOutcome> {
    const { context, rejectionReason } = params
    const { customerId, message, projectId } = context

    // we validate the rejection here because we need to check every idempotency key no matter what
    // double counting is the worse
    if (rejectionReason) {
      return this.rejectMessage(message, rejectionReason)
    }

    const processableStatesResult = await this.resolveProcessableStates(context)

    if (processableStatesResult.err) {
      return this.rejectMessage(message, processableStatesResult.err)
    }

    await this.applyResolvedStates({
      customerId,
      message,
      processableStates: processableStatesResult.val,
      projectId,
    })

    return this.publishOutcome(message, {
      state: "processed",
    })
  }

  private async resolveSyncFeatureState(params: {
    candidateGrants: IngestionCandidateGrants
    customerId: string
    featureSlug: string
    message: IngestionQueueMessage
    projectId: string
  }): Promise<Result<IngestionResolvedState[], IngestionRejectionReason>> {
    return this.stateResolutionService.resolveSyncFeatureState(params)
  }

  private async prepareCustomerMessageGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<PreparedCustomerMessageGroup> {
    return this.preparationService.prepareCustomerMessageGroup(params)
  }

  private async prepareCustomerGrantContext(params: {
    customerId: string
    endAt: number
    projectId: string
    startAt: number
  }): Promise<PreparedCustomerGrantContext> {
    return this.preparationService.prepareCustomerGrantContext(params)
  }

  private ackMessage(message: IngestionQueueMessage): IngestionMessageProcessingResult {
    return {
      message,
      disposition: {
        action: "ack",
      },
    }
  }

  private retryMessage(
    message: IngestionQueueMessage,
    retryAfterSeconds?: number
  ): IngestionMessageProcessingResult {
    return {
      message,
      disposition: {
        action: "retry",
        retryAfterSeconds,
      },
    }
  }

  private async abortClaim(
    idempotencyStub: IngestionIdempotencyController,
    idempotencyKey: string,
    logContext: MessageLogContext
  ): Promise<void> {
    await idempotencyStub.abort({ idempotencyKey }).catch((abortError) => {
      this.logger.error("failed to release ingestion idempotency claim", {
        ...logContext,
        error: abortError,
      })
    })
  }

  private async publishOutcome(
    message: IngestionQueueMessage,
    outcome: IngestionOutcome
  ): Promise<IngestionOutcome> {
    await this.publishPipelineEvent({
      handledAt: this.now(),
      message,
      outcome,
    })

    return outcome
  }

  private async rejectMessage(
    message: IngestionQueueMessage,
    rejectionReason: IngestionRejectionReason
  ): Promise<IngestionOutcome> {
    return this.publishOutcome(message, {
      state: "rejected",
      rejectionReason,
    })
  }

  private async rejectMessageWithoutIdempotency(params: {
    customerId: string
    message: IngestionQueueMessage
    projectId: string
    rejectionReason: "CUSTOMER_NOT_FOUND"
  }): Promise<void> {
    const { customerId, message, projectId, rejectionReason } = params
    const outcome = await this.rejectMessage(message, rejectionReason)
    this.logRejectedMessage({
      customerId,
      message,
      projectId,
      rejectionReason: outcome.rejectionReason,
    })
  }

  private async resolveProcessableStates(
    context: IngestionContext
  ): Promise<Result<IngestionResolvedState[], IngestionRejectionReason>> {
    return this.stateResolutionService.resolveProcessableStates(context)
  }

  private async applyResolvedStates(params: ApplyResolvedStatesParams): Promise<void> {
    const { customerId, message, processableStates, projectId } = params

    for (const state of processableStates) {
      await this.applyResolvedState({
        customerId,
        enforceLimit: false,
        message,
        projectId,
        state,
      })
    }
  }

  private async applyResolvedState(
    params: ApplyResolvedStateParams
  ): Promise<EntitlementWindowApplyResult | null> {
    const { customerId, enforceLimit, message, projectId, state } = params

    // This keeps counters stable across mid-cycle grant changes.
    const periodKey = computeResolvedStatePeriodKey(state, message.timestamp)

    if (!periodKey) {
      this.logger.debug("period key doesn't exist")
      return null
    }

    const periodEndAt = computeResolvedStatePeriodEndAt(state, message.timestamp)

    if (periodEndAt === null) {
      this.logger.debug("period end doesn't exist")
      return null
    }

    const stub = this.entitlementWindowClient.getEntitlementWindowStub({
      customerId,
      periodKey,
      projectId,
      streamId: state.streamId,
    })

    // call the DO and apply the usage
    return stub.apply({
      event: {
        id: message.id,
        slug: message.slug,
        timestamp: message.timestamp,
        properties: message.properties,
      },
      idempotencyKey: message.idempotencyKey,
      projectId,
      customerId,
      streamId: state.streamId,
      featureSlug: state.featureSlug,
      periodKey,
      meters: [state.meterConfig],
      limit: state.limit,
      overageStrategy: state.overageStrategy,
      enforceLimit,
      now: message.receivedAt, // we avoid clock skews
      periodEndAt,
    })
  }

  private logRejectedMessage(params: {
    customerId: string
    message: IngestionQueueMessage
    projectId: string
    rejectionReason?: IngestionRejectionReason
  }): void {
    const { customerId, message, projectId, rejectionReason } = params
    this.logger.warn("raw ingestion message rejected", {
      projectId,
      customerId,
      eventId: message.id,
      eventSlug: message.slug,
      idempotencyKey: message.idempotencyKey,
      rejectionReason,
    })
  }

  private async rejectSyncMessage(params: {
    customerId: string
    message: IngestionQueueMessage
    messageText?: string
    projectId: string
    rejectionReason: IngestionRejectionReason
  }): Promise<IngestionSyncResult> {
    const { customerId, message, messageText, projectId, rejectionReason } = params
    const outcome = await this.rejectMessage(message, rejectionReason)
    this.logRejectedMessage({
      customerId,
      message,
      projectId,
      rejectionReason: outcome.rejectionReason,
    })

    return this.toSyncResult({
      allowed: false,
      message: messageText,
      outcome,
    })
  }

  private toSyncResult(params: {
    allowed: boolean
    message?: string
    outcome: IngestionOutcome
  }): IngestionSyncResult {
    const { allowed, message, outcome } = params
    return {
      allowed,
      message,
      rejectionReason: outcome.rejectionReason,
      state: outcome.state,
    }
  }

  private async publishPipelineEvent(params: {
    handledAt: number
    message: IngestionQueueMessage
    outcome: IngestionOutcome
  }): Promise<void> {
    const pipelineEvent = parseLakehouseEvent("events", {
      event_date: toEventDate(params.message.timestamp),
      schema_version: EVENTS_SCHEMA_VERSION,
      id: params.message.id,
      project_id: params.message.projectId,
      customer_id: params.message.customerId,
      request_id: params.message.requestId,
      idempotency_key: params.message.idempotencyKey,
      slug: params.message.slug,
      timestamp: params.message.timestamp,
      received_at: params.message.receivedAt,
      handled_at: params.handledAt,
      state: params.outcome.state,
      rejection_reason: params.outcome.rejectionReason,
      properties: params.message.properties,
    })

    await this.pipelineEvents.send([pipelineEvent])
  }
}

function toEventDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function sortIngestionMessages(left: IngestionQueueMessage, right: IngestionQueueMessage): number {
  return left.timestamp - right.timestamp || left.idempotencyKey.localeCompare(right.idempotencyKey)
}
