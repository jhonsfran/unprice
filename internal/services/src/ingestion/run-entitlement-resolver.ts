import type { MeterConfig } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import type {
  RunEntitlementResolution,
  RunEntitlementResolver,
} from "../use-cases/runs/apply-run-sync-event"
import type { CustomerGrantContextReader, IngestionEntitlement } from "./entitlement-context"
import { resolveCustomerGrantContextWindow } from "./entitlement-context"
import { IngestionEntitlementRouter } from "./entitlement-routing"

/**
 * Resolves the active entitlement for a feature slug in the context of a run sync event.
 * Reuses the same SWR-cached entitlement context and routing logic as the normal sync path.
 */
export class IngestionRunEntitlementResolver implements RunEntitlementResolver {
  private readonly entitlementContext: CustomerGrantContextReader
  private readonly router: IngestionEntitlementRouter

  constructor(opts: {
    entitlementContext: CustomerGrantContextReader
    logger: Pick<Logger, "error" | "warn">
  }) {
    this.entitlementContext = opts.entitlementContext
    this.router = new IngestionEntitlementRouter({ logger: opts.logger })
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

    // Load candidate entitlements (SWR-cached, ~sub-ms on hit)
    const contextWindow = resolveCustomerGrantContextWindow({
      earliestTimestamp: eventTimestamp,
      latestTimestamp: eventTimestamp,
    })

    const preparedContext = await this.entitlementContext.prepareCustomerGrantContext({
      customerId,
      projectId,
      ...contextWindow,
    })

    if (preparedContext.rejectionReason) {
      return { ok: false, reason: preparedContext.rejectionReason }
    }

    // Route to the matching entitlement for this feature slug + event slug
    const routingResult = this.router.resolveSyncFeatureEntitlements({
      candidateEntitlements: preparedContext.candidateEntitlements,
      featureSlug,
      message: {
        slug: eventSlug,
        timestamp: eventTimestamp,
        properties: eventProperties,
        // Fields required by IngestionQueueMessage type but only used for logging
        version: 1 as const,
        workspaceId: "",
        projectId,
        customerId,
        requestId: "",
        receivedAt: eventTimestamp,
        idempotencyKey: "",
        id: "",
        source: {
          environment: "",
          apiKeyId: null,
          sourceType: "system" as const,
          sourceId: "",
          sourceName: null,
        },
      },
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
