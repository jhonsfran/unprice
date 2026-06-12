import { type Database, and, eq, gt, inArray, lte, ne } from "@unprice/db"
import { billingPeriods } from "@unprice/db/schema"
import type {
  BillingConfig,
  ConfigFeatureVersionType,
  CreditLinePolicy,
  CustomerEntitlementExtended,
  FeatureType,
  MeterConfig,
  OverageStrategy,
  ResetConfig,
} from "@unprice/db/validators"
import { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import type { EntitlementService } from "../entitlements/service"
import { cachedQuery } from "../utils/cached-query"
import type { IngestionRejectionReason } from "./interface"
import type { IngestionQueueMessage } from "./message"

export type IngestionGrant = {
  allowanceUnits: number | null
  effectiveAt: number
  expiresAt: number | null
  grantId: string
  priority: number
}

export type IngestionBillingPeriodContext = {
  billingPeriodId: string
  cycleEndAt: number
  cycleStartAt: number
  featurePlanVersionItemId: string
  statementKey: string
}

export type IngestionEntitlement = {
  billingPeriods: IngestionBillingPeriodContext[]
  creditLinePolicy: CreditLinePolicy
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
  subscriptionId?: string | null
  subscriptionItemId: string | null
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

export type CustomerGrantContextWindow = {
  endAt: number
  startAt: number
}

export type CustomerGrantContextReader = {
  prepareCustomerGrantContext(
    params: CustomerGrantContextWindow & {
      customerId: string
      projectId: string
    }
  ): Promise<PreparedCustomerGrantContext>
}

export type CustomerMessageGroupPreparer = {
  prepareCustomerMessageGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<PreparedCustomerMessageGroup>
}

type PreparedGrantContextCache = {
  ingestionPreparedGrantContext: {
    swr: (
      key: string,
      loader: (key: string) => Promise<PreparedCustomerGrantContext>
    ) => Promise<{ val?: PreparedCustomerGrantContext; err?: unknown }>
  }
}

const GRANT_CONTEXT_CACHE_BUCKET_MS = 300_000

export class IngestionEntitlementContextLoader {
  private readonly cache: PreparedGrantContextCache
  private readonly db: Database | null
  private readonly entitlementService: EntitlementService
  private readonly logger: Pick<Logger, "warn">

  constructor(opts: {
    cache: PreparedGrantContextCache
    db?: Database
    entitlementService: EntitlementService
    logger: Pick<Logger, "warn">
  }) {
    this.cache = opts.cache
    this.db = opts.db ?? null
    this.entitlementService = opts.entitlementService
    this.logger = opts.logger
  }

  public async prepareCustomerMessageGroup(params: {
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

    const contextWindow = resolveCustomerGrantContextWindow({
      earliestTimestamp: earliestMessage.timestamp,
      latestTimestamp: latestMessage.timestamp,
    })
    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      ...contextWindow,
    })

    return {
      messages,
      candidateEntitlements: preparedContext.candidateEntitlements,
      rejectionReason: preparedContext.rejectionReason,
    }
  }

  public async prepareCustomerGrantContext(params: {
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

      return this.withFreshBillingPeriodContexts(
        await this.loadCustomerEntitlementContext(params),
        params
      )
    }

    return this.withFreshBillingPeriodContexts(cachedResult.val, params)
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
      toIngestionEntitlement(entitlement)
    )

    if (candidateEntitlements.length === 0) {
      const customerExists = await this.entitlementService.customerExists({
        projectId,
        customerId,
      })

      if (customerExists.err) {
        throw customerExists.err
      }

      if (!customerExists.val) {
        return {
          candidateEntitlements,
          rejectionReason: "CUSTOMER_NOT_FOUND",
        }
      }
    }

    return {
      candidateEntitlements,
      rejectionReason: candidateEntitlements.some(isUsageEntitlement)
        ? undefined
        : "NO_MATCHING_ENTITLEMENT",
    }
  }

  private async withFreshBillingPeriodContexts(
    context: PreparedCustomerGrantContext,
    params: {
      customerId: string
      endAt: number
      projectId: string
      startAt: number
    }
  ): Promise<PreparedCustomerGrantContext> {
    const billingPeriodsByItemId = await this.loadBillingPeriodContexts({
      customerId: params.customerId,
      entitlements: context.candidateEntitlements,
      endAt: params.endAt,
      projectId: params.projectId,
      startAt: params.startAt,
    })

    return {
      ...context,
      candidateEntitlements: context.candidateEntitlements.map((entitlement) => ({
        ...entitlement,
        billingPeriods:
          entitlement.subscriptionItemId !== null
            ? (billingPeriodsByItemId.get(entitlement.subscriptionItemId) ?? [])
            : [],
      })),
    }
  }

  private async loadBillingPeriodContexts(params: {
    customerId: string
    endAt: number
    entitlements: Array<{ subscriptionItemId: string | null }>
    projectId: string
    startAt: number
  }): Promise<Map<string, IngestionBillingPeriodContext[]>> {
    if (!this.db) return new Map()

    const subscriptionItemIds = [
      ...new Set(
        params.entitlements
          .map((entitlement) => entitlement.subscriptionItemId)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      ),
    ]
    if (subscriptionItemIds.length === 0) return new Map()

    const rows = await this.db
      .select({
        billingPeriodId: billingPeriods.id,
        cycleEndAt: billingPeriods.cycleEndAt,
        cycleStartAt: billingPeriods.cycleStartAt,
        featurePlanVersionItemId: billingPeriods.subscriptionItemId,
        statementKey: billingPeriods.statementKey,
      })
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.projectId, params.projectId),
          eq(billingPeriods.customerId, params.customerId),
          inArray(billingPeriods.subscriptionItemId, subscriptionItemIds),
          ne(billingPeriods.status, "voided"),
          lte(billingPeriods.cycleStartAt, params.endAt),
          gt(billingPeriods.cycleEndAt, params.startAt)
        )
      )

    const byItemId = new Map<string, IngestionBillingPeriodContext[]>()
    for (const row of rows) {
      const contexts = byItemId.get(row.featurePlanVersionItemId) ?? []
      contexts.push(row)
      byItemId.set(row.featurePlanVersionItemId, contexts)
    }

    return byItemId
  }
}

export function resolveCustomerGrantContextWindow(params: {
  earliestTimestamp: number
  latestTimestamp: number
}): CustomerGrantContextWindow {
  return {
    startAt: Math.max(0, params.earliestTimestamp - INGESTION_MAX_EVENT_AGE_MS),
    endAt: params.latestTimestamp,
  }
}

export function toIngestionEntitlement(
  entitlement: CustomerEntitlementExtended,
  options: { billingPeriods?: IngestionBillingPeriodContext[] } = {}
): IngestionEntitlement {
  return {
    billingPeriods: options.billingPeriods ?? [],
    creditLinePolicy: entitlement.subscriptionPhase?.creditLinePolicy ?? "uncapped",
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
    subscriptionId: entitlement.subscriptionId,
    subscriptionItemId: entitlement.subscriptionItemId,
  }
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
