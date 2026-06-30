import type { MeterConfig } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import type {
  RunEntitlementResolution,
  RunEntitlementResolver,
} from "../use-cases/runs/apply-run-sync-event"
import type {
  CustomerGrantContextReader,
  IngestionEntitlement,
  PreparedCustomerGrantContext,
} from "./entitlement-context"
import { resolveCustomerGrantContextWindow } from "./entitlement-context"
import { IngestionEntitlementRouter } from "./entitlement-routing"
import type { IngestionQueueMessage } from "./message"

type RunSubscriptionCatchUp = {
  catchUpForPreparedGroup(params: {
    candidateEntitlements: IngestionEntitlement[]
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<{ changed: boolean; caughtUpSubscriptionIds: string[] }>
}

/**
 * Resolves the active entitlement for a feature slug in the context of a run sync event.
 * Reuses the same SWR-cached entitlement context and routing logic as the normal sync path.
 */
export class IngestionRunEntitlementResolver implements RunEntitlementResolver {
  private readonly entitlementContext: CustomerGrantContextReader
  private readonly router: IngestionEntitlementRouter
  private readonly subscriptionCatchUp?: RunSubscriptionCatchUp

  constructor(opts: {
    entitlementContext: CustomerGrantContextReader
    logger: Pick<Logger, "error" | "warn">
    subscriptionCatchUp?: RunSubscriptionCatchUp
  }) {
    this.entitlementContext = opts.entitlementContext
    this.router = new IngestionEntitlementRouter({ logger: opts.logger })
    this.subscriptionCatchUp = opts.subscriptionCatchUp
  }

  async resolveForFeature(params: {
    projectId: string
    customerId: string
    featureSlug: string
    eventSlug: string
    eventTimestamp: number
    eventProperties: Record<string, unknown>
  }): Promise<RunEntitlementResolution> {
    const { projectId, customerId, featureSlug, eventSlug, eventTimestamp, eventProperties } =
      params

    const message = buildRunEntitlementMessage({
      customerId,
      eventProperties,
      eventSlug,
      eventTimestamp,
      projectId,
    })

    const preparedContext = await this.loadPreparedContext({
      customerId,
      eventTimestamp,
      projectId,
    })

    if (preparedContext.rejectionReason) {
      return { ok: false, reason: preparedContext.rejectionReason }
    }

    const resolution = this.routePreparedContext({
      featureSlug,
      message,
      preparedContext,
    })

    if (
      !resolution.ok ||
      this.subscriptionCatchUp === undefined ||
      hasBillingPeriodCovering(resolution.entitlement, eventTimestamp)
    ) {
      return resolution
    }

    const catchUp = await this.subscriptionCatchUp.catchUpForPreparedGroup({
      candidateEntitlements: preparedContext.candidateEntitlements,
      customerId,
      messages: [message],
      projectId,
    })

    if (!catchUp.changed) {
      return resolution
    }

    const refreshedContext = await this.loadPreparedContext({
      customerId,
      eventTimestamp,
      projectId,
    })

    if (refreshedContext.rejectionReason) {
      return { ok: false, reason: refreshedContext.rejectionReason }
    }

    return this.routePreparedContext({
      featureSlug,
      message,
      preparedContext: refreshedContext,
    })
  }

  private loadPreparedContext(params: {
    customerId: string
    eventTimestamp: number
    projectId: string
  }): Promise<PreparedCustomerGrantContext> {
    const contextWindow = resolveCustomerGrantContextWindow({
      earliestTimestamp: params.eventTimestamp,
      latestTimestamp: params.eventTimestamp,
    })

    return this.entitlementContext.prepareCustomerGrantContext({
      customerId: params.customerId,
      projectId: params.projectId,
      ...contextWindow,
    })
  }

  private routePreparedContext(params: {
    featureSlug: string
    message: IngestionQueueMessage
    preparedContext: PreparedCustomerGrantContext
  }): RunEntitlementResolution {
    const routingResult = this.router.resolveSyncFeatureEntitlements({
      candidateEntitlements: params.preparedContext.candidateEntitlements,
      featureSlug: params.featureSlug,
      message: params.message,
    })

    if (routingResult.err) {
      return { ok: false, reason: routingResult.err }
    }

    const [entitlement] = routingResult.val
    if (!entitlement) {
      return { ok: false, reason: "UNROUTABLE_EVENT" }
    }

    if (!entitlement.meterConfig) {
      return { ok: false, reason: "NO_MATCHING_ENTITLEMENT" }
    }

    return {
      ok: true,
      entitlement: entitlement as IngestionEntitlement & { meterConfig: MeterConfig },
      grants: entitlement.grants,
    }
  }
}

function buildRunEntitlementMessage(params: {
  customerId: string
  eventProperties: Record<string, unknown>
  eventSlug: string
  eventTimestamp: number
  projectId: string
}): IngestionQueueMessage {
  return {
    slug: params.eventSlug,
    timestamp: params.eventTimestamp,
    properties: params.eventProperties,
    // Fields required by IngestionQueueMessage type but only used for routing/logging here.
    version: 1,
    workspaceId: "",
    projectId: params.projectId,
    customerId: params.customerId,
    requestId: "",
    receivedAt: params.eventTimestamp,
    idempotencyKey: "",
    id: "",
    source: {
      environment: "",
      apiKeyId: null,
      sourceType: "system",
      sourceId: "",
      sourceName: null,
    },
  }
}

function hasBillingPeriodCovering(entitlement: IngestionEntitlement, eventTimestamp: number) {
  return entitlement.billingPeriods.some(
    (period) => period.cycleStartAt <= eventTimestamp && eventTimestamp < period.cycleEndAt
  )
}
