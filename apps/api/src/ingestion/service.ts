import { parseLakehouseEvent } from "@unprice/lakehouse"
import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import type { CustomerService } from "@unprice/services/customers"
import {
  type GrantsManager,
  type IngestionResolvedState,
  MAX_EVENT_AGE_MS,
} from "@unprice/services/entitlements"
import type { Env } from "~/env"
import {
  CloudflareEntitlementWindowClient,
  CloudflareIdempotencyClient,
  type EntitlementWindowClient,
  type IdempotencyClient,
  type IngestionIdempotencyStub,
} from "./clients"
import { IngestionQueueConsumer } from "./consumer"
import {
  EVENTS_SCHEMA_VERSION,
  type FeatureVerificationResult,
  type IngestionMessageProcessingResult,
  type IngestionOutcome,
  type IngestionRejectionReason,
  type IngestionSyncResult,
} from "./interface"
import {
  type IngestionQueueMessage,
  computeResolvedStatePeriodEndAt,
  computeResolvedStatePeriodKey,
  filterResolvedStatesWithValidAggregationPayload,
} from "./message"
import { createQueueServices } from "./queue"

type IngestionCandidateGrants = Parameters<
  GrantsManager["resolveIngestionStatesFromGrants"]
>[0]["grants"]

type IngestionContext = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  message: IngestionQueueMessage
  projectId: string
}

type PreparedCustomerMessageGroup = {
  candidateGrants: IngestionCandidateGrants
  messages: IngestionQueueMessage[]
  rejectionReason?: IngestionRejectionReason
}

type PreparedCustomerGrantContext = {
  candidateGrants: IngestionCandidateGrants
  rejectionReason?: IngestionRejectionReason
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

type PipelineEventsQueue = Pick<Env["PIPELINE_EVENTS"], "send">

type EntitlementWindowApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED"
  message?: string
}

type Result<T, E> = { err: E; val?: undefined } | { err?: undefined; val: T }

type CreateIngestionServiceParams = {
  customerService: CustomerService
  env: Pick<Env, "APP_ENV" | "entitlementwindow" | "ingestionidempotency" | "PIPELINE_EVENTS">
  grantsManager: GrantsManager
  logger: AppLogger
  now?: () => number
}

export class IngestionService {
  private readonly customerService: CustomerService
  private readonly grantsManager: GrantsManager
  private readonly entitlementWindowClient: EntitlementWindowClient
  private readonly idempotencyClient: IdempotencyClient
  private readonly logger: AppLogger
  private readonly now: () => number
  private readonly pipelineEvents: PipelineEventsQueue

  constructor(opts: {
    customerService: CustomerService
    entitlementWindowClient: EntitlementWindowClient
    grantsManager: GrantsManager
    idempotencyClient: IdempotencyClient
    logger: AppLogger
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
    const { candidateGrants, customerId, featureSlug, message, projectId } = params
    const resolvedFeatureStateResult = await this.grantsManager.resolveFeatureStateAtTimestamp({
      customerId,
      featureSlug,
      grants: candidateGrants,
      projectId,
      timestamp: message.timestamp,
    })

    if (resolvedFeatureStateResult.err) {
      this.logger.warn("invalid active grant configuration for sync ingestion", {
        projectId,
        customerId,
        featureSlug,
        event: message,
        error: resolvedFeatureStateResult.err.message,
      })

      return {
        err: "INVALID_ENTITLEMENT_CONFIGURATION",
      }
    }

    if (resolvedFeatureStateResult.val.kind !== "usage") {
      this.logger.debug("no matching sync ingestion entitlement", {
        event: message,
        featureSlug,
        state: resolvedFeatureStateResult.val.kind,
      })

      return {
        err: "NO_MATCHING_ENTITLEMENT",
      }
    }

    return this.filterProcessableResolvedStates({
      message,
      states: [resolvedFeatureStateResult.val.state],
    })
  }

  private async prepareCustomerMessageGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<PreparedCustomerMessageGroup> {
    const { customerId, messages, projectId } = params

    const earliestMessage = messages[0]
    const latestMessage = messages.at(-1)

    if (!earliestMessage || !latestMessage) {
      return {
        messages,
        candidateGrants: [],
      }
    }

    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      startAt: Math.max(0, earliestMessage.timestamp - MAX_EVENT_AGE_MS),
      endAt: latestMessage.timestamp,
    })

    return {
      messages,
      candidateGrants: preparedContext.candidateGrants,
      rejectionReason: preparedContext.rejectionReason,
    }
  }

  private async prepareCustomerGrantContext(params: {
    customerId: string
    endAt: number
    projectId: string
    startAt: number
  }): Promise<PreparedCustomerGrantContext> {
    const { customerId, endAt, projectId, startAt } = params

    // We need to validate the customer exists before sending bs to the DO
    const { err: customerErr, val: customer } = await this.customerService.getCustomer(customerId)

    if (customerErr) {
      throw customerErr
    }

    if (!customer || customer.projectId !== projectId) {
      return {
        candidateGrants: [],
        rejectionReason: "CUSTOMER_NOT_FOUND",
      }
    }

    const { err, val } = await this.grantsManager.getGrantsForCustomer({
      projectId,
      customerId,
      startAt,
      endAt,
    })

    if (err) {
      throw err
    }

    const candidateGrants = val.grants

    return {
      candidateGrants,
      rejectionReason: hasUsageGrant(candidateGrants) ? undefined : "NO_MATCHING_ENTITLEMENT",
    }
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
    idempotencyStub: IngestionIdempotencyStub,
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
    const { candidateGrants, customerId, message, projectId } = context
    const resolvedStatesResult = await this.grantsManager.resolveIngestionStatesFromGrants({
      customerId,
      grants: candidateGrants,
      projectId,
      timestamp: message.timestamp,
    })

    if (resolvedStatesResult.err) {
      this.logger.warn("invalid active grant configuration for ingestion", {
        projectId,
        customerId,
        event: message,
        error: resolvedStatesResult.err.message,
      })

      return {
        err: "INVALID_ENTITLEMENT_CONFIGURATION",
      }
    }

    return this.filterProcessableResolvedStates({
      message,
      states: resolvedStatesResult.val,
    })
  }

  private async filterProcessableResolvedStates(params: {
    message: IngestionQueueMessage
    states: IngestionResolvedState[]
  }): Promise<Result<IngestionResolvedState[], IngestionRejectionReason>> {
    const { message, states } = params
    const matchingStates: IngestionResolvedState[] = []
    const invalidStates: Array<{
      activeGrantIds: string[]
      errorMessage: string
      featureSlug: string
      meterConfig: IngestionResolvedState["meterConfig"]
      resetConfig: IngestionResolvedState["resetConfig"]
      streamEndAt: number | null
      streamId: string
      streamStartAt: number
    }> = []

    for (const state of states) {
      if (state.meterConfig.eventSlug !== message.slug) {
        continue
      }

      try {
        const periodKey = computeResolvedStatePeriodKey(state, message.timestamp)

        if (periodKey !== null) {
          matchingStates.push(state)
        }
      } catch (error) {
        invalidStates.push({
          activeGrantIds: state.activeGrantIds,
          errorMessage: error instanceof Error ? error.message : String(error),
          featureSlug: state.featureSlug,
          meterConfig: state.meterConfig,
          resetConfig: state.resetConfig,
          streamEndAt: state.streamEndAt,
          streamId: state.streamId,
          streamStartAt: state.streamStartAt,
        })
      }
    }

    if (invalidStates.length > 0) {
      const detail = {
        event: message,
        invalidStates,
        invalidStatesCount: invalidStates.length,
      }

      this.logger.warn("invalid resolved-state period configuration for ingestion", detail)
      this.logger.debug("invalid entitlement configuration details for ingestion", detail)

      return {
        err: "INVALID_ENTITLEMENT_CONFIGURATION",
      }
    }

    if (matchingStates.length === 0) {
      this.logger.debug("no matching ingestion streams", {
        event: message,
        outcome: {
          state: "rejected",
          rejectionReason: "UNROUTABLE_EVENT",
        } satisfies IngestionOutcome,
      })

      return {
        err: "UNROUTABLE_EVENT",
      }
    }

    // before going to the DO let's validate the event itself has the property the meter is using
    // for the aggregation
    const processableStates = filterResolvedStatesWithValidAggregationPayload({
      states: matchingStates,
      event: message,
    })

    if (processableStates.length === 0) {
      this.logger.debug("invalid aggregation payload", {
        event: message,
        outcome: {
          state: "rejected",
          rejectionReason: "INVALID_AGGREGATION_PROPERTIES",
        } satisfies IngestionOutcome,
      })

      return {
        err: "INVALID_AGGREGATION_PROPERTIES",
      }
    }

    return { val: processableStates }
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

export function createIngestionService(params: CreateIngestionServiceParams): IngestionService {
  return new IngestionService({
    customerService: params.customerService,
    entitlementWindowClient: new CloudflareEntitlementWindowClient(params.env),
    grantsManager: params.grantsManager,
    idempotencyClient: new CloudflareIdempotencyClient(params.env),
    logger: params.logger,
    pipelineEvents: params.env.PIPELINE_EVENTS,
    now: params.now,
  })
}

function toEventDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function hasUsageGrant(candidateGrants: IngestionCandidateGrants): boolean {
  return candidateGrants.some(
    (grant) =>
      grant.featurePlanVersion.featureType === "usage" &&
      Boolean(grant.featurePlanVersion.meterConfig)
  )
}

export async function consumeIngestionBatch(
  batch: MessageBatch<IngestionQueueMessage>,
  env: Env,
  executionCtx: ExecutionContext
): Promise<void> {
  const batchRequestId = `queue:${Date.now()}`
  const { logger } = createStandaloneRequestLogger({
    requestId: batchRequestId,
  })

  logger.set({
    service: "api",
    request: {
      id: batchRequestId,
    },
    cloud: {
      platform: "cloudflare",
    },
    business: {
      operation: "raw_ingestion_queue_consume",
    },
  })

  const services = createQueueServices({
    env,
    executionCtx,
    logger,
  })

  const service = createIngestionService({
    customerService: services.customers,
    grantsManager: services.grantsManager,
    logger,
    env,
  })

  const consumer = new IngestionQueueConsumer({
    logger,
    processor: service,
  })

  await consumer.consumeBatch(batch)

  await logger.flush().catch((error: Error) => {
    logger.emit("error", "Failed to flush ingestion queue logger", {
      error: error.message,
    })
  })
}

function sortIngestionMessages(left: IngestionQueueMessage, right: IngestionQueueMessage): number {
  return left.timestamp - right.timestamp || left.idempotencyKey.localeCompare(right.idempotencyKey)
}
