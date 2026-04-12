import { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache } from "../cache/service"
import {
  type GrantsManager,
  type IngestionResolvedState,
  MAX_EVENT_AGE_MS,
  UnPriceGrantError,
} from "../entitlements"
import { cachedQuery } from "../utils/cached-query"
import {
  type IngestionAuditClient,
  type IngestionAuditEntry,
  computeCanonicalAuditId,
  computePayloadHash,
  selectIngestionAuditShardIndex,
} from "./audit"
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
} from "./message"
export type IngestionCandidateGrants = Parameters<
  GrantsManager["resolveIngestionStatesFromGrants"]
>[0]["grants"]

export type PreparedCustomerMessageGroup = {
  candidateGrants: IngestionCandidateGrants
  messages: IngestionQueueMessage[]
  rejectionReason?: IngestionRejectionReason
}

export type PreparedCustomerGrantContext = {
  candidateGrants: IngestionCandidateGrants
  rejectionReason?: IngestionRejectionReason
}
import { IngestionStateResolutionService } from "./state-resolution-service"

type IngestionContext = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  message: IngestionQueueMessage
  projectId: string
}

type HandleMessageParams = {
  context: IngestionContext
  rejectionReason?: IngestionRejectionReason
}

type ApplyResolvedStatesParams = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  message: IngestionQueueMessage
  processableStates: IngestionResolvedState[]
  projectId: string
}

type ApplyResolvedStateParams = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  enforceLimit: boolean
  message: IngestionQueueMessage
  projectId: string
  state: IngestionResolvedState
}

export type EntitlementWindowApplyInput = {
  customerId: string
  currency: string
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
  featurePlanVersionId: string | null
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

type MessageOutcome = {
  message: IngestionQueueMessage
  outcome: IngestionOutcome
}

type ShardedAuditEntry = {
  entry: IngestionAuditEntry
  shardIndex: number
}

const GRANT_CONTEXT_CACHE_BUCKET_MS = 300_000

export class IngestionService {
  private readonly stateResolutionService: IngestionStateResolutionService
  private readonly grantsManager: GrantsManager
  private readonly entitlementWindowClient: EntitlementWindowClient
  private readonly auditClient: IngestionAuditClient
  private readonly cache: Pick<Cache, "ingestionPreparedGrantContext">
  private readonly logger: Logger
  private readonly now: () => number
  private readonly waitUntil: (promise: Promise<unknown>) => void

  constructor(opts: {
    cache: Pick<Cache, "ingestionPreparedGrantContext">
    entitlementWindowClient: EntitlementWindowClient
    grantsManager: GrantsManager
    auditClient: IngestionAuditClient
    logger: Logger
    now?: () => number
    waitUntil: (promise: Promise<unknown>) => void
  }) {
    this.entitlementWindowClient = opts.entitlementWindowClient
    this.auditClient = opts.auditClient
    this.cache = opts.cache
    this.logger = opts.logger
    this.grantsManager = opts.grantsManager
    this.now = opts.now ?? (() => Date.now())
    this.waitUntil = opts.waitUntil
    this.stateResolutionService = new IngestionStateResolutionService({
      grantsManager: this.grantsManager,
      logger: this.logger,
    })
  }

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
      const outcome: IngestionOutcome = {
        state: "rejected",
        rejectionReason: preparedContext.rejectionReason,
      }
      this.logRejectedMessage({
        customerId,
        message,
        projectId,
        rejectionReason: outcome.rejectionReason,
      })
      this.commitToAuditAsync(message, outcome)

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

    // Cross-period idempotency: if the audit DO already recorded this key,
    // the event was processed in a prior reset window — return the cached result.
    if (await this.isKnownByAudit(projectId, customerId, message.idempotencyKey)) {
      return this.toSyncResult({
        allowed: true,
        outcome: { state: "processed" },
      })
    }

    const applyResult = await this.applyResolvedState({
      candidateGrants: preparedContext.candidateGrants,
      customerId,
      enforceLimit: true,
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

    const outcome: IngestionOutcome = { state: "processed" }
    this.commitToAuditAsync(message, outcome)

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
    const messages = [...params.messages].sort(sortIngestionMessages)

    try {
      const preparedGroup = await this.prepareCustomerMessageGroup({
        customerId,
        messages,
        projectId,
      })

      if (preparedGroup.rejectionReason === "CUSTOMER_NOT_FOUND") {
        const outcomes = this.buildCustomerNotFoundOutcomes(preparedGroup.messages, {
          customerId,
          projectId,
          rejectionReason: preparedGroup.rejectionReason,
        })
        await this.commitOutcomesToAudit(projectId, customerId, outcomes)
        return this.mapOutcomesToAckResults(outcomes)
      }

      // Cross-period idempotency: filter out events the audit DO already recorded
      // so they are not reprocessed in a new reset window.
      const { fresh, duplicateOutcomes } = await this.filterCrossPeriodDuplicates(
        projectId,
        customerId,
        preparedGroup.messages
      )

      const freshOutcomes =
        fresh.length > 0
          ? await this.processPreparedMessages(fresh, {
              candidateGrants: preparedGroup.candidateGrants,
              customerId,
              projectId,
              rejectionReason: preparedGroup.rejectionReason,
            })
          : []

      // Only commit fresh outcomes — duplicates are already in the audit DO
      await this.commitOutcomesToAudit(projectId, customerId, freshOutcomes)

      return [
        ...this.mapOutcomesToAckResults(freshOutcomes),
        ...duplicateOutcomes.map(({ message }) => this.ackMessage(message)),
      ]
    } catch (error) {
      this.logger.error("raw ingestion queue processing failed", {
        projectId,
        customerId,
        error,
      })

      return messages.map((message) => this.retryMessage(message))
    }
  }

  private async handleMessage(params: HandleMessageParams): Promise<IngestionOutcome> {
    const { context, rejectionReason } = params
    const { customerId, message, projectId } = context

    if (rejectionReason) {
      return { state: "rejected", rejectionReason }
    }

    const processableStatesResult = await this.resolveProcessableStates(context)

    if (processableStatesResult.err) {
      return { state: "rejected", rejectionReason: processableStatesResult.err }
    }

    await this.applyResolvedStates({
      candidateGrants: context.candidateGrants,
      customerId,
      message,
      processableStates: processableStatesResult.val,
      projectId,
    })

    return { state: "processed" }
  }

  private buildCustomerNotFoundOutcomes(
    messages: IngestionQueueMessage[],
    params: {
      customerId: string
      projectId: string
      rejectionReason: "CUSTOMER_NOT_FOUND"
    }
  ): MessageOutcome[] {
    return messages.map((message) => {
      const outcome: IngestionOutcome = {
        state: "rejected",
        rejectionReason: params.rejectionReason,
      }

      this.logRejectedMessage({
        customerId: params.customerId,
        message,
        projectId: params.projectId,
        rejectionReason: outcome.rejectionReason,
      })

      return { message, outcome }
    })
  }

  private async processPreparedMessages(
    messages: IngestionQueueMessage[],
    params: {
      candidateGrants: IngestionCandidateGrants
      customerId: string
      projectId: string
      rejectionReason?: IngestionRejectionReason
    }
  ): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = []

    for (const message of messages) {
      const outcome = await this.handleMessage({
        context: {
          candidateGrants: params.candidateGrants,
          customerId: params.customerId,
          message,
          projectId: params.projectId,
        },
        rejectionReason: params.rejectionReason,
      })

      if (outcome.state === "rejected") {
        this.logRejectedMessage({
          customerId: params.customerId,
          message,
          projectId: params.projectId,
          rejectionReason: outcome.rejectionReason,
        })
      }

      outcomes.push({ message, outcome })
    }

    return outcomes
  }

  private async commitOutcomesToAudit(
    projectId: string,
    customerId: string,
    outcomes: MessageOutcome[]
  ): Promise<void> {
    const auditEntries = await this.buildAuditEntries(projectId, customerId, outcomes)
    const auditEntriesByShard = this.bucketAuditEntriesByShard(auditEntries)
    await this.flushAuditEntries(projectId, customerId, auditEntriesByShard)
  }

  private async buildAuditEntries(
    projectId: string,
    customerId: string,
    outcomes: MessageOutcome[]
  ): Promise<ShardedAuditEntry[]> {
    return Promise.all(
      outcomes.map(async ({ message, outcome }) => ({
        entry: await this.buildAuditEntry(projectId, customerId, message, outcome),
        shardIndex: selectIngestionAuditShardIndex(message.idempotencyKey),
      }))
    )
  }

  private async buildAuditEntry(
    projectId: string,
    customerId: string,
    message: IngestionQueueMessage,
    outcome: IngestionOutcome
  ): Promise<IngestionAuditEntry> {
    const handledAt = this.now()
    const [canonicalAuditId, payloadHash] = await Promise.all([
      computeCanonicalAuditId(projectId, customerId, message.idempotencyKey),
      computePayloadHash(message),
    ])

    return {
      idempotencyKey: message.idempotencyKey,
      canonicalAuditId,
      payloadHash,
      status: outcome.state,
      rejectionReason: outcome.rejectionReason,
      resultJson: JSON.stringify(outcome),
      auditPayloadJson: JSON.stringify(
        buildAuditPayload(message, outcome, canonicalAuditId, payloadHash, handledAt)
      ),
      firstSeenAt: message.receivedAt,
    }
  }

  private bucketAuditEntriesByShard(
    auditEntries: ShardedAuditEntry[]
  ): Map<number, IngestionAuditEntry[]> {
    const auditEntriesByShard = new Map<number, IngestionAuditEntry[]>()

    for (const { entry, shardIndex } of auditEntries) {
      const existingEntries = auditEntriesByShard.get(shardIndex)

      if (existingEntries) {
        existingEntries.push(entry)
        continue
      }

      auditEntriesByShard.set(shardIndex, [entry])
    }

    return auditEntriesByShard
  }

  private async flushAuditEntries(
    projectId: string,
    customerId: string,
    auditEntriesByShard: Map<number, IngestionAuditEntry[]>
  ): Promise<void> {
    // Cloudflare Queues is at-least-once. Duplicate deliveries are expected here and
    // tolerated because EntitlementWindowDO is the sole correctness boundary for usage.
    const commitPromises = [...auditEntriesByShard.entries()].map(([shardIndex, entries]) =>
      this.auditClient
        .getAuditStub({
          projectId,
          customerId,
          shardIndex,
        })
        .commit(entries)
        .then((result) => {
          if (result.conflicts > 0) {
            this.logger.warn("audit payload conflicts detected", {
              projectId,
              customerId,
              conflicts: result.conflicts,
              shardIndex,
            })
          }
        })
        .catch((error) => {
          this.logger.error("audit commit failed", {
            projectId,
            customerId,
            shardIndex,
            error,
          })
        })
    )

    await Promise.all(commitPromises)
  }

  private commitToAuditAsync(message: IngestionQueueMessage, outcome: IngestionOutcome): void {
    this.waitUntil(
      this.commitOutcomesToAudit(message.projectId, message.customerId, [{ message, outcome }])
    )
  }

  private async isKnownByAudit(
    projectId: string,
    customerId: string,
    idempotencyKey: string
  ): Promise<boolean> {
    try {
      const shardIndex = selectIngestionAuditShardIndex(idempotencyKey)
      const knownKeys = await this.auditClient
        .getAuditStub({ projectId, customerId, shardIndex })
        .exists([idempotencyKey])
      return knownKeys.length > 0
    } catch (error) {
      this.logger.warn("audit idempotency pre-check failed, falling through", {
        projectId,
        customerId,
        idempotencyKey,
        error,
      })
      return false
    }
  }

  private async filterCrossPeriodDuplicates(
    projectId: string,
    customerId: string,
    messages: IngestionQueueMessage[]
  ): Promise<{
    duplicateOutcomes: MessageOutcome[]
    fresh: IngestionQueueMessage[]
  }> {
    if (messages.length === 0) {
      return { fresh: [], duplicateOutcomes: [] }
    }

    try {
      // Group idempotency keys by audit shard for parallel lookup
      const keysByShard = new Map<number, string[]>()

      for (const message of messages) {
        const shardIndex = selectIngestionAuditShardIndex(message.idempotencyKey)
        const existing = keysByShard.get(shardIndex)
        if (existing) {
          existing.push(message.idempotencyKey)
        } else {
          keysByShard.set(shardIndex, [message.idempotencyKey])
        }
      }

      const shardResults = await Promise.all(
        [...keysByShard.entries()].map(([shardIndex, keys]) =>
          this.auditClient.getAuditStub({ projectId, customerId, shardIndex }).exists(keys)
        )
      )

      const knownKeys = new Set(shardResults.flat())

      if (knownKeys.size === 0) {
        return { fresh: messages, duplicateOutcomes: [] }
      }

      const fresh: IngestionQueueMessage[] = []
      const duplicateOutcomes: MessageOutcome[] = []

      for (const message of messages) {
        if (knownKeys.has(message.idempotencyKey)) {
          duplicateOutcomes.push({
            message,
            outcome: { state: "processed" },
          })
        } else {
          fresh.push(message)
        }
      }

      if (duplicateOutcomes.length > 0) {
        this.logger.info("cross-period duplicates filtered", {
          projectId,
          customerId,
          duplicateCount: duplicateOutcomes.length,
          freshCount: fresh.length,
        })
      }

      return { fresh, duplicateOutcomes }
    } catch (error) {
      this.logger.warn("audit cross-period dedup failed, processing all messages", {
        projectId,
        customerId,
        messageCount: messages.length,
        error,
      })
      return { fresh: messages, duplicateOutcomes: [] }
    }
  }

  private mapOutcomesToAckResults(outcomes: MessageOutcome[]): IngestionMessageProcessingResult[] {
    return outcomes.map((outcome) => this.ackMessage(outcome.message))
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
    const bucket = Math.floor(params.endAt / GRANT_CONTEXT_CACHE_BUCKET_MS)
    const cacheKey = `${params.projectId}:${params.customerId}:${bucket}`

    const cachedResult = await cachedQuery({
      cache: this.cache.ingestionPreparedGrantContext,
      cacheKey,
      load: () => this.loadCustomerGrantContext(params),
      wrapLoadError: (error) =>
        new FetchError({
          message: `unable to prepare cached grant context - ${error.message}`,
          retry: false,
          context: {
            customerId: params.customerId,
            projectId: params.projectId,
            method: "prepareCustomerGrantContext",
            url: "",
            error: error.message,
          },
        }),
    })

    if (cachedResult.err) {
      this.logger.warn("failed to use cached grant context, falling back to direct load", {
        customerId: params.customerId,
        projectId: params.projectId,
        error: cachedResult.err.message,
      })

      return this.loadCustomerGrantContext(params)
    }

    return cachedResult.val
  }

  private async loadCustomerGrantContext(params: {
    customerId: string
    endAt: number
    projectId: string
    startAt: number
  }): Promise<PreparedCustomerGrantContext> {
    const { customerId, endAt, projectId, startAt } = params

    const { err, val } = await this.grantsManager.getGrantsForCustomer({
      projectId,
      customerId,
      startAt,
      endAt,
    })

    if (err) {
      if (err instanceof UnPriceGrantError && err.code === "CUSTOMER_NOT_FOUND") {
        return {
          candidateGrants: [],
          rejectionReason: "CUSTOMER_NOT_FOUND",
        }
      }
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

  private async resolveProcessableStates(
    context: IngestionContext
  ): Promise<Result<IngestionResolvedState[], IngestionRejectionReason>> {
    return this.stateResolutionService.resolveProcessableStates(context)
  }

  private async applyResolvedStates(params: ApplyResolvedStatesParams): Promise<void> {
    const { candidateGrants, customerId, message, processableStates, projectId } = params

    for (const state of processableStates) {
      await this.applyResolvedState({
        candidateGrants,
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
    const { candidateGrants, customerId, enforceLimit, message, projectId, state } = params
    const currency = resolveCurrencyForResolvedState(candidateGrants, state)
    const featurePlanVersionId = resolveFeaturePlanVersionIdForResolvedState(candidateGrants, state)

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
      currency,
      streamId: state.streamId,
      featurePlanVersionId,
      featureSlug: state.featureSlug,
      periodKey,
      meters: [state.meterConfig],
      limit: state.limit,
      overageStrategy: state.overageStrategy,
      enforceLimit,
      now: message.receivedAt,
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
    const outcome: IngestionOutcome = { state: "rejected", rejectionReason }
    this.logRejectedMessage({
      customerId,
      message,
      projectId,
      rejectionReason: outcome.rejectionReason,
    })
    this.commitToAuditAsync(message, outcome)

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
}

function resolveCurrencyForResolvedState(
  candidateGrants: IngestionCandidateGrants,
  state: IngestionResolvedState
): string {
  const activeGrantIds = new Set(state.activeGrantIds)

  for (const grant of candidateGrants) {
    if (!activeGrantIds.has(grant.id)) {
      continue
    }

    const config = grant.featurePlanVersion?.config
    const currencyFromPrice = extractCurrencyCode(config, "price")
    if (currencyFromPrice) {
      return currencyFromPrice
    }

    const tiers = extractTiers(config)
    for (const tier of tiers) {
      const currencyFromTier = extractCurrencyCode(tier, "unitPrice")
      if (currencyFromTier) {
        return currencyFromTier
      }
    }
  }

  return "USD"
}

function resolveFeaturePlanVersionIdForResolvedState(
  candidateGrants: IngestionCandidateGrants,
  state: IngestionResolvedState
): string | null {
  const activeGrantIds = new Set(state.activeGrantIds)
  const matchingGrant = candidateGrants.find((grant) => activeGrantIds.has(grant.id))
  return matchingGrant?.featurePlanVersionId ?? null
}

function extractCurrencyCode(input: unknown, priceKey: string): string | null {
  if (!isRecord(input)) {
    return null
  }

  const price = input[priceKey]
  if (!isRecord(price)) {
    return null
  }

  const dinero = price.dinero
  if (!isRecord(dinero)) {
    return null
  }

  const currency = dinero.currency
  if (!isRecord(currency)) {
    return null
  }

  const code = currency.code
  return typeof code === "string" && code.length > 0 ? code : null
}

function extractTiers(input: unknown): Record<string, unknown>[] {
  if (!isRecord(input)) {
    return []
  }

  const tiers = input.tiers
  if (!Array.isArray(tiers)) {
    return []
  }

  return tiers.filter((tier): tier is Record<string, unknown> => isRecord(tier))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function buildAuditPayload(
  message: IngestionQueueMessage,
  outcome: IngestionOutcome,
  canonicalAuditId: string,
  payloadHash: string,
  handledAt: number
): Record<string, unknown> {
  return {
    event_date: toEventDate(message.timestamp),
    schema_version: EVENTS_SCHEMA_VERSION,
    id: message.id,
    project_id: message.projectId,
    customer_id: message.customerId,
    request_id: message.requestId,
    idempotency_key: message.idempotencyKey,
    slug: message.slug,
    timestamp: message.timestamp,
    received_at: message.receivedAt,
    handled_at: handledAt,
    state: outcome.state,
    rejection_reason: outcome.rejectionReason,
    properties: message.properties,
    canonical_audit_id: canonicalAuditId,
    payload_hash: payloadHash,
  }
}

function toEventDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function sortIngestionMessages(left: IngestionQueueMessage, right: IngestionQueueMessage): number {
  return left.timestamp - right.timestamp || left.idempotencyKey.localeCompare(right.idempotencyKey)
}

function hasUsageGrant(candidateGrants: IngestionCandidateGrants): boolean {
  return candidateGrants.some(
    (grant) =>
      grant.featurePlanVersion.featureType === "usage" &&
      Boolean(grant.featurePlanVersion.meterConfig)
  )
}
