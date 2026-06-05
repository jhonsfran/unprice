import type { Logger } from "@unprice/logs"
import type { IngestionCandidateEntitlements, IngestionEntitlement } from "./entitlement-context"
import type { IngestionRejectionReason } from "./interface"
import {
  type IngestionQueueMessage,
  filterIngestionEntitlementsWithValidAggregationPayload,
  isIngestionEntitlementActiveAt,
} from "./message"

type Result<T, E> = { err: E; val?: undefined } | { err?: undefined; val: T }

const DEFAULT_FANOUT_WARNING_THRESHOLD = 5

export class IngestionEntitlementRouter {
  private readonly fanoutWarningThreshold: number
  private readonly logger: Pick<Logger, "error" | "warn">

  constructor(opts: {
    fanoutWarningThreshold?: number
    logger: Pick<Logger, "error" | "warn">
  }) {
    this.fanoutWarningThreshold = opts.fanoutWarningThreshold ?? DEFAULT_FANOUT_WARNING_THRESHOLD
    this.logger = opts.logger
  }

  public resolveSyncFeatureEntitlements(params: {
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
      allowMultipleMatches: false,
      message: params.message,
      entitlements,
    })
  }

  public resolveProcessableEntitlements(params: {
    candidateEntitlements: IngestionCandidateEntitlements
    message: IngestionQueueMessage
  }): Result<IngestionEntitlement[], IngestionRejectionReason> {
    return this.filterProcessableEntitlements({
      allowMultipleMatches: true,
      message: params.message,
      entitlements: params.candidateEntitlements,
    })
  }

  private filterProcessableEntitlements(params: {
    allowMultipleMatches: boolean
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

    if (!params.allowMultipleMatches && matchingEntitlements.length > 1) {
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

    if (
      params.allowMultipleMatches &&
      processableEntitlements.length > this.fanoutWarningThreshold
    ) {
      this.logger.warn("high ingestion entitlement fanout", {
        projectId: params.message.projectId,
        customerId: params.message.customerId,
        eventId: params.message.id,
        eventSlug: params.message.slug,
        matched_entitlements_per_event: processableEntitlements.length,
        fanout_warning_threshold: this.fanoutWarningThreshold,
        customerEntitlementIds: processableEntitlements.map(
          (entitlement) => entitlement.customerEntitlementId
        ),
      })
    }

    return { val: processableEntitlements }
  }
}
