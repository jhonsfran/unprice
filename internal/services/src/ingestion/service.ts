import type {
  BillingConfig,
  ConfigFeatureVersionType,
  CustomerEntitlementExtended,
  FeatureType,
  MeterConfig,
  OverageStrategy,
  ResetConfig,
} from "@unprice/db/validators"
import { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Cache } from "../cache/service"
import { MAX_EVENT_AGE_MS } from "../entitlements"
import type { EntitlementService } from "../entitlements/service"
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
  filterIngestionEntitlementsWithValidAggregationPayload,
  isIngestionEntitlementActiveAt,
} from "./message"

export type IngestionGrant = {
  allowanceUnits: number | null
  effectiveAt: number
  expiresAt: number | null
  grantId: string
  priority: number
}

export type IngestionEntitlement = {
  customerEntitlementId: string
  customerId: string
  effectiveAt: number
  expiresAt: number | null
  featureConfig: ConfigFeatureVersionType
  featurePlanVersionId: string
  featureSlug: string
  featureType: FeatureType
  grants: IngestionGrant[]
  meterConfig: MeterConfig | null
  overageStrategy: OverageStrategy
  projectId: string
  resetConfig: ResetConfig | null
}

export type IngestionCandidateEntitlements = IngestionEntitlement[]

export type PreparedCustomerMessageGroup = {
  candidateEntitlements: IngestionCandidateEntitlements
  messages: IngestionQueueMessage[]
  rejectionReason?: IngestionRejectionReason
}

export type PreparedCustomerGrantContext = {
  candidateEntitlements: IngestionCandidateEntitlements
  rejectionReason?: IngestionRejectionReason
}

type IngestionContext = {
  candidateEntitlements: IngestionCandidateEntitlements
  customerId: string
  message: IngestionQueueMessage
  projectId: string
}

type HandleMessageParams = {
  context: IngestionContext
  rejectionReason?: IngestionRejectionReason
}

type EntitlementWindowApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED" | "WALLET_EMPTY" | "LATE_EVENT_CLOSED_PERIOD"
  message?: string
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
    slug: string
    timestamp: number
  }
  grants: IngestionGrant[]
  idempotencyKey: string
  now: number
  projectId: string
}

export type EntitlementWindowController = {
  apply: (input: EntitlementWindowApplyInput) => Promise<EntitlementWindowApplyResult>
  getEnforcementState: (input?: EntitlementWindowStateInput) => Promise<{
    isLimitReached: boolean
    limit: number | null
    usage: number
  }>
}

export interface EntitlementWindowClient {
  getEntitlementWindowStub(params: {
    customerEntitlementId: string
    customerId: string
    projectId: string
  }): EntitlementWindowController
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
  private readonly entitlementService: EntitlementService
  private readonly entitlementWindowClient: EntitlementWindowClient
  private readonly auditClient: IngestionAuditClient
  private readonly cache: Pick<Cache, "ingestionPreparedGrantContext">
  private readonly logger: Logger
  private readonly now: () => number
  private readonly waitUntil: (promise: Promise<unknown>) => void

  constructor(opts: {
    cache: Pick<Cache, "ingestionPreparedGrantContext">
    entitlementService: EntitlementService
    entitlementWindowClient: EntitlementWindowClient
    auditClient: IngestionAuditClient
    logger: Logger
    now?: () => number
    waitUntil: (promise: Promise<unknown>) => void
  }) {
    this.entitlementService = opts.entitlementService
    this.entitlementWindowClient = opts.entitlementWindowClient
    this.auditClient = opts.auditClient
    this.cache = opts.cache
    this.logger = opts.logger
    this.now = opts.now ?? (() => Date.now())
    this.waitUntil = opts.waitUntil
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

    if (preparedContext.rejectionReason) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: preparedContext.rejectionReason,
      })
    }

    const processableEntitlementsResult = this.resolveSyncFeatureEntitlements({
      candidateEntitlements: preparedContext.candidateEntitlements,
      featureSlug,
      message,
    })

    if (processableEntitlementsResult.err) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: processableEntitlementsResult.err,
      })
    }

    const [entitlement] = processableEntitlementsResult.val

    if (!entitlement) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: "UNROUTABLE_EVENT",
      })
    }

    if (await this.isKnownByAudit(projectId, customerId, message.idempotencyKey)) {
      return this.toSyncResult({
        allowed: true,
        outcome: { state: "processed" },
      })
    }

    const applyResult = await this.applyEntitlement({
      customerId,
      enforceLimit: true,
      entitlement,
      message,
      projectId,
    })

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

    if (preparedContext.rejectionReason) {
      return {
        allowed: false,
        featureSlug,
        status:
          preparedContext.rejectionReason === "CUSTOMER_NOT_FOUND"
            ? "customer_not_found"
            : "feature_missing",
        timestamp,
      }
    }

    const matchingEntitlements = preparedContext.candidateEntitlements.filter(
      (candidate) =>
        candidate.featureSlug === featureSlug &&
        isIngestionEntitlementActiveAt(candidate, timestamp)
    )

    if (matchingEntitlements.length > 1) {
      this.logger.error("multiple active entitlements matched feature verification", {
        projectId,
        customerId,
        featureSlug,
        customerEntitlementIds: matchingEntitlements.map(
          (entitlement) => entitlement.customerEntitlementId
        ),
      })

      return {
        allowed: false,
        featureSlug,
        status: "invalid_entitlement_configuration",
        timestamp,
      }
    }

    const entitlement = matchingEntitlements[0]

    if (!entitlement) {
      return {
        allowed: false,
        featureSlug,
        status: "feature_missing",
        timestamp,
      }
    }

    if (entitlement.featureType !== "usage") {
      return {
        allowed: true,
        featureSlug,
        featureType: entitlement.featureType,
        status: "non_usage",
        timestamp,
      }
    }

    if (!entitlement.meterConfig) {
      return {
        allowed: false,
        featureSlug,
        featureType: "usage",
        message: "Usage feature is missing meter configuration",
        status: "invalid_entitlement_configuration",
        timestamp,
      }
    }

    const applyEntitlement = {
      ...entitlement,
      meterConfig: entitlement.meterConfig,
    }
    const enforcementState = await this.entitlementWindowClient
      .getEntitlementWindowStub({
        customerEntitlementId: entitlement.customerEntitlementId,
        customerId,
        projectId,
      })
      .getEnforcementState({
        entitlement: applyEntitlement,
        grants: entitlement.grants,
        now: timestamp,
      })

    return {
      allowed: !enforcementState.isLimitReached,
      featureSlug,
      featureType: "usage",
      isLimitReached: enforcementState.isLimitReached,
      limit: enforcementState.limit,
      meterConfig: entitlement.meterConfig,
      overageStrategy: entitlement.overageStrategy,
      status: "usage",
      effectiveAt: entitlement.effectiveAt,
      expiresAt: entitlement.expiresAt,
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

      const { fresh, duplicateOutcomes } = await this.filterCrossPeriodDuplicates(
        projectId,
        customerId,
        preparedGroup.messages
      )

      const freshOutcomes =
        fresh.length > 0
          ? await this.processPreparedMessages(fresh, {
              candidateEntitlements: preparedGroup.candidateEntitlements,
              customerId,
              projectId,
              rejectionReason: preparedGroup.rejectionReason,
            })
          : []

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

    const processableEntitlementsResult = this.resolveProcessableEntitlements(context)

    if (processableEntitlementsResult.err) {
      return { state: "rejected", rejectionReason: processableEntitlementsResult.err }
    }

    for (const entitlement of processableEntitlementsResult.val) {
      const applyResult = await this.applyEntitlement({
        customerId,
        enforceLimit: false,
        entitlement,
        message,
        projectId,
      })

      if (!applyResult.allowed && applyResult.deniedReason === "LATE_EVENT_CLOSED_PERIOD") {
        return { state: "rejected", rejectionReason: applyResult.deniedReason }
      }
    }

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
      candidateEntitlements: IngestionCandidateEntitlements
      customerId: string
      projectId: string
      rejectionReason?: IngestionRejectionReason
    }
  ): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = []

    for (const message of messages) {
      const outcome = await this.handleMessage({
        context: {
          candidateEntitlements: params.candidateEntitlements,
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
        candidateEntitlements: [],
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
      candidateEntitlements: preparedContext.candidateEntitlements,
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
      load: () => this.loadCustomerEntitlementContext(params),
      wrapLoadError: (error) =>
        new FetchError({
          message: `unable to prepare cached entitlement context - ${error.message}`,
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
      this.logger.warn("failed to use cached entitlement context, falling back to direct load", {
        customerId: params.customerId,
        projectId: params.projectId,
        error: cachedResult.err.message,
      })

      return this.loadCustomerEntitlementContext(params)
    }

    return cachedResult.val
  }

  private async loadCustomerEntitlementContext(params: {
    customerId: string
    endAt: number
    projectId: string
    startAt: number
  }): Promise<PreparedCustomerGrantContext> {
    const { customerId, endAt, projectId, startAt } = params

    const entitlementsResult = await this.entitlementService.getCustomerEntitlementsForCustomer({
      projectId,
      customerId,
      startAt,
      endAt,
    })

    if (entitlementsResult.err) {
      throw entitlementsResult.err
    }

    const candidateEntitlements = entitlementsResult.val.map((entitlement) =>
      this.toIngestionEntitlement(entitlement)
    )

    return {
      candidateEntitlements,
      rejectionReason: candidateEntitlements.some(isUsageEntitlement)
        ? undefined
        : "NO_MATCHING_ENTITLEMENT",
    }
  }

  private toIngestionEntitlement(entitlement: CustomerEntitlementExtended): IngestionEntitlement {
    return {
      customerEntitlementId: entitlement.id,
      customerId: entitlement.customerId,
      effectiveAt: entitlement.effectiveAt,
      expiresAt: entitlement.expiresAt,
      featureConfig: entitlement.featurePlanVersion.config,
      featurePlanVersionId: entitlement.featurePlanVersionId,
      featureSlug: entitlement.featurePlanVersion.feature.slug,
      featureType: entitlement.featurePlanVersion.featureType,
      grants: (entitlement.grants ?? []).map((grant) => ({
        allowanceUnits: grant.allowanceUnits,
        effectiveAt: grant.effectiveAt,
        expiresAt: grant.expiresAt,
        grantId: grant.id,
        priority: grant.priority,
      })),
      meterConfig: entitlement.featurePlanVersion.meterConfig ?? null,
      overageStrategy: entitlement.overageStrategy,
      projectId: entitlement.projectId,
      resetConfig:
        entitlement.featurePlanVersion.resetConfig ??
        toResetConfigFromBillingConfig(entitlement.featurePlanVersion.billingConfig),
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

  private resolveSyncFeatureEntitlements(params: {
    candidateEntitlements: IngestionCandidateEntitlements
    featureSlug: string
    message: IngestionQueueMessage
  }): Result<IngestionEntitlement[], IngestionRejectionReason> {
    const entitlements = params.candidateEntitlements.filter(
      (entitlement) => entitlement.featureSlug === params.featureSlug
    )

    if (entitlements.length === 0) {
      return { err: "NO_MATCHING_ENTITLEMENT" }
    }

    return this.filterProcessableEntitlements({
      message: params.message,
      entitlements,
    })
  }

  private resolveProcessableEntitlements(
    context: IngestionContext
  ): Result<IngestionEntitlement[], IngestionRejectionReason> {
    return this.filterProcessableEntitlements({
      message: context.message,
      entitlements: context.candidateEntitlements,
    })
  }

  private filterProcessableEntitlements(params: {
    message: IngestionQueueMessage
    entitlements: IngestionEntitlement[]
  }): Result<IngestionEntitlement[], IngestionRejectionReason> {
    const matchingEntitlements = params.entitlements.filter(
      (entitlement) =>
        entitlement.featureType === "usage" &&
        entitlement.meterConfig?.eventSlug === params.message.slug &&
        isIngestionEntitlementActiveAt(entitlement, params.message.timestamp)
    )

    if (matchingEntitlements.length === 0) {
      return { err: "UNROUTABLE_EVENT" }
    }

    if (matchingEntitlements.length > 1) {
      this.logger.error("multiple active entitlements matched ingestion event", {
        projectId: params.message.projectId,
        customerId: params.message.customerId,
        eventId: params.message.id,
        eventSlug: params.message.slug,
        customerEntitlementIds: matchingEntitlements.map(
          (entitlement) => entitlement.customerEntitlementId
        ),
      })

      return { err: "INVALID_ENTITLEMENT_CONFIGURATION" }
    }

    const processableEntitlements = filterIngestionEntitlementsWithValidAggregationPayload({
      entitlements: matchingEntitlements,
      event: params.message,
    })

    if (processableEntitlements.length === 0) {
      return { err: "INVALID_AGGREGATION_PROPERTIES" }
    }

    return { val: processableEntitlements }
  }

  private async applyEntitlement(params: {
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

    const stub = this.entitlementWindowClient.getEntitlementWindowStub({
      customerEntitlementId: entitlement.customerEntitlementId,
      customerId,
      projectId,
    })
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

function isUsageEntitlement(entitlement: IngestionEntitlement): boolean {
  return entitlement.featureType === "usage" && Boolean(entitlement.meterConfig)
}

function toResetConfigFromBillingConfig(billingConfig: BillingConfig): ResetConfig {
  return {
    name: billingConfig.name,
    resetInterval: billingConfig.billingInterval,
    resetIntervalCount: billingConfig.billingIntervalCount,
    planType: billingConfig.planType,
    resetAnchor: "dayOfCreation",
  }
}
