import type { Logger } from "@unprice/logs"
import type { IngestionRejectionReason } from "./interface"
import {
  type IngestionQueueMessage,
  computeIngestionEntitlementPeriodKey,
  filterIngestionEntitlementsWithValidAggregationPayload,
} from "./message"
import type { IngestionEntitlement } from "./service"

type Result<T, E> = { err: E; val?: undefined } | { err?: undefined; val: T }

export class IngestionStateResolutionService {
  private readonly logger: Logger

  constructor(params: { logger: Logger }) {
    this.logger = params.logger
  }

  public resolveProcessableEntitlements(params: {
    entitlements: IngestionEntitlement[]
    message: IngestionQueueMessage
  }): Result<IngestionEntitlement[], IngestionRejectionReason> {
    const matchingEntitlements = params.entitlements.filter(
      (entitlement) =>
        entitlement.featureType === "usage" &&
        entitlement.meterConfig?.eventSlug === params.message.slug &&
        computeIngestionEntitlementPeriodKey(entitlement, params.message.timestamp) !== null
    )

    if (matchingEntitlements.length === 0) {
      this.logger.debug("no matching ingestion streams", {
        event: params.message,
        outcome: {
          state: "rejected",
          rejectionReason: "UNROUTABLE_EVENT",
        },
      })

      return { err: "UNROUTABLE_EVENT" }
    }

    const processableEntitlements = filterIngestionEntitlementsWithValidAggregationPayload({
      entitlements: matchingEntitlements,
      event: params.message,
    })

    if (processableEntitlements.length === 0) {
      this.logger.debug("invalid aggregation payload", {
        event: params.message,
        outcome: {
          state: "rejected",
          rejectionReason: "INVALID_AGGREGATION_PROPERTIES",
        },
      })

      return { err: "INVALID_AGGREGATION_PROPERTIES" }
    }

    return { val: processableEntitlements }
  }
}
