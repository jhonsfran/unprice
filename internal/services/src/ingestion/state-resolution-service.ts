import type { Logger } from "@unprice/logs"
import type { GrantsManager, IngestionResolvedState } from "../entitlements"
import type { IngestionRejectionReason } from "./interface"
import {
  type IngestionQueueMessage,
  computeResolvedStatePeriodKey,
  filterResolvedStatesWithValidAggregationPayload,
} from "./message"
import type { IngestionCandidateGrants } from "./preparation-service"

type IngestionContext = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  message: IngestionQueueMessage
  projectId: string
}

type Result<T, E> = { err: E; val?: undefined } | { err?: undefined; val: T }

export class IngestionStateResolutionService {
  private readonly grantsManager: GrantsManager
  private readonly logger: Logger

  constructor(params: { grantsManager: GrantsManager; logger: Logger }) {
    this.grantsManager = params.grantsManager
    this.logger = params.logger
  }

  public async resolveSyncFeatureState(params: {
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

  public async resolveProcessableStates(
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

  public async filterProcessableResolvedStates(params: {
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
        },
      })

      return {
        err: "UNROUTABLE_EVENT",
      }
    }

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
        },
      })

      return {
        err: "INVALID_AGGREGATION_PROPERTIES",
      }
    }

    return { val: processableStates }
  }
}
